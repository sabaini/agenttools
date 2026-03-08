import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import { Container, SettingsList, Text, type SettingItem } from "@mariozechner/pi-tui";

import {
	MAIN_BRANCH,
	REVIEW_PREFIX,
	checkGhAuth,
	getCurrentBranch,
	listOpenPrs,
	loadReviewTypes,
	prepareReviewRequest,
	restoreSelection,
	type PrInfo,
	type ReviewScope,
	type ReviewSelectionState,
	type SelectionEntry,
} from "./core.ts";

const STATUS_KEY = "review";
const PREPARE_REVIEW_TOOL_NAME = "prepare_review";

const prepareReviewSchema = Type.Object({
	scope: StringEnum(["working-tree", "branch", "repository", "pull-request"] as const),
	reviewIds: Type.Optional(
		Type.Array(Type.String({ description: "Review prompt ids like review-correctness" })),
	),
	base: Type.Optional(Type.String({ description: "Base ref for branch reviews" })),
	head: Type.Optional(Type.String({ description: "Head ref for branch reviews (defaults to current branch)" })),
	prRef: Type.Optional(Type.String({ description: "PR number or URL for pull-request reviews" })),
	outputPath: Type.Optional(Type.String({ description: "Markdown file path the review should be written to" })),
});

type PrepareReviewToolParams = Static<typeof prepareReviewSchema>;

function parseToolScope(params: PrepareReviewToolParams): ReviewScope {
	switch (params.scope) {
		case "working-tree":
			return { kind: "working-tree" };
		case "branch": {
			const base = params.base?.trim();
			if (!base) {
				throw new Error("prepare_review requires 'base' when scope='branch'.");
			}
			const head = params.head?.trim();
			return { kind: "branch", base, ...(head ? { head } : {}) };
		}
		case "repository":
			return { kind: "repository" };
		case "pull-request": {
			const prRef = params.prRef?.trim();
			if (!prRef) {
				throw new Error("prepare_review requires 'prRef' when scope='pull-request'.");
			}
			return { kind: "pull-request", prRef };
		}
	}
}

export default function reviewExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: PREPARE_REVIEW_TOOL_NAME,
		label: "Prepare Review",
		description:
			"Prepare a deterministic review packet from loaded review templates and repository state.",
		promptSnippet: "Prepare a deterministic review packet for the current repository or branch.",
		promptGuidelines: [
			"Use this tool instead of asking the user to run /review when a workflow needs deterministic review input.",
		],
		parameters: prepareReviewSchema,
		async execute(_toolCallId, params) {
			const prepared = await prepareReviewRequest(pi, {
				reviewIds: params.reviewIds,
				scope: parseToolScope(params),
				outputPath: params.outputPath,
			});

			return {
				content: [
					{
						type: "text",
						text:
							"Prepared deterministic review packet. Follow it to produce the review findings and write the requested Markdown file.\n\n" +
							prepared.prompt,
					},
				],
				details: {
					branch: prepared.branch,
					outputPath: prepared.outputPath,
					reviewIds: prepared.activeReviews.map((review) => review.id),
					reviewInputLabel: prepared.reviewInputLabel,
					reviewInputTitle: prepared.reviewInputTitle,
					scope: params.scope,
				},
			};
		},
	});

	pi.registerCommand("review", {
		description: "Run selected review types against git changes or full codebase",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}

			const gitCheck = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
			if (gitCheck.code !== 0) {
				ctx.ui.notify("Not inside a git repository.", "error");
				return;
			}

			const reviewTypes = await loadReviewTypes(pi);
			if (reviewTypes.length === 0) {
				ctx.ui.notify(`No review templates found (${REVIEW_PREFIX}*.md).`, "error");
				return;
			}

			const selected = restoreSelection(reviewTypes, ctx.sessionManager.getBranch() as SelectionEntry[]);

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = reviewTypes.map((review) => ({
					id: review.id,
					label: review.label,
					currentValue: selected.has(review.id) ? "on" : "off",
					values: ["on", "off"],
				}));

				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("Select Review Types")), 1, 1));

				const settings = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, value) => {
						if (value === "on") {
							selected.add(id);
						} else {
							selected.delete(id);
						}
					},
					() => done(undefined),
					{ enableSearch: true },
				);

				container.addChild(settings);
				container.addChild(new Text(theme.fg("dim", "Enter toggles • Esc continues"), 1, 0));

				return {
					render: (width) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						settings.handleInput?.(data);
						tui.requestRender();
					},
				};
			});

			pi.appendEntry<ReviewSelectionState>("review-config", {
				selectedIds: Array.from(selected),
			});

			const activeReviewIds = reviewTypes
				.filter((review) => selected.has(review.id))
				.map((review) => review.id);
			if (activeReviewIds.length === 0) {
				ctx.ui.notify("No review types selected.", "warning");
				return;
			}

			const scopeChoice = await chooseScope(pi, ctx, await checkGhAuth(pi));
			if (!scopeChoice) return;

			ctx.ui.setStatus(STATUS_KEY, "Preparing review packet…");
			try {
				const prepared = await prepareReviewRequest(pi, {
					reviewIds: activeReviewIds,
					scope: scopeChoice,
				});

				if (ctx.isIdle()) {
					pi.sendUserMessage(prepared.prompt);
				} else {
					pi.sendUserMessage(prepared.prompt, { deliverAs: "followUp" });
					ctx.ui.notify("Queued /review follow-up request.", "info");
				}
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});
}

async function chooseScope(
	pi: ExtensionAPI,
	ctx: {
		ui: {
			select: (title: string, options: string[]) => Promise<string | undefined>;
			input: (title: string, value?: string) => Promise<string | undefined>;
			setStatus: (key: string, value: string | undefined) => void;
			notify: (message: string, level: "info" | "warning" | "error") => void;
		};
	},
	ghAvailable: boolean,
): Promise<ReviewScope | undefined> {
	const branch = await getCurrentBranch(pi);
	const prOption = "GitHub Pull Request" + (ghAvailable ? "" : " (gh auth required)");
	const scope = await ctx.ui.select("Compare which changes?", [
		"Uncommitted changes (staged + unstaged + untracked)",
		`Current branch (${branch}) vs ${MAIN_BRANCH}`,
		"Current branch vs another base",
		prOption,
		"Complete code base (excluding .gitignored files)",
	]);
	if (!scope) return undefined;

	if (scope.startsWith("Uncommitted")) {
		return { kind: "working-tree" };
	}
	if (scope.includes(`vs ${MAIN_BRANCH}`)) {
		return { kind: "branch", base: MAIN_BRANCH, head: branch };
	}
	if (scope.startsWith("Current branch vs another base")) {
		const base = await ctx.ui.input("Base branch:", MAIN_BRANCH);
		if (!base) return undefined;
		return { kind: "branch", base: base.trim(), head: branch };
	}
	if (scope.startsWith("GitHub Pull Request")) {
		if (!ghAvailable) {
			ctx.ui.notify("GitHub CLI is not authenticated. Run 'gh auth login' first.", "error");
			return undefined;
		}

		const prMethod = await ctx.ui.select("How to specify the PR?", [
			"Select from open PRs",
			"Enter PR number or URL",
		]);
		if (!prMethod) return undefined;

		let prRef: string | undefined;
		if (prMethod.startsWith("Select")) {
			ctx.ui.setStatus(STATUS_KEY, "Loading open PRs…");
			let prs: PrInfo[];
			try {
				prs = await listOpenPrs(pi);
			} catch (error) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(`Failed to list PRs: ${String(error)}`, "error");
				return undefined;
			}
			ctx.ui.setStatus(STATUS_KEY, undefined);

			if (prs.length === 0) {
				ctx.ui.notify("No open pull requests found.", "warning");
				return undefined;
			}

			const prChoices = prs.map(
				(pr) => `#${pr.number} — ${pr.title} (${pr.author}, ${pr.headRefName} → ${pr.baseRefName})`,
			);
			const prChoice = await ctx.ui.select("Select a pull request:", prChoices);
			if (!prChoice) return undefined;
			const index = prChoices.indexOf(prChoice);
			prRef = String(prs[index].number);
		} else {
			const input = await ctx.ui.input("PR number or URL:");
			if (!input) return undefined;
			prRef = input.trim();
		}

		return prRef ? { kind: "pull-request", prRef } : undefined;
	}

	return { kind: "repository" };
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
