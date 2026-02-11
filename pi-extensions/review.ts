import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getSettingsListTheme,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@mariozechner/pi-tui";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REVIEW_PREFIX = "review-";
const MAIN_BRANCH = "main";

interface ReviewType {
	id: string;
	label: string;
	prompt: string;
}

interface ReviewSelectionState {
	selectedIds: string[];
}

type SelectionEntry = {
	type: string;
	customType?: string;
	data?: unknown;
};

function stripFrontmatter(text: string): string {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return text.trim();
	const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
	if (end === -1) return text.trim();
	return lines.slice(end + 1).join("\n").trim();
}

async function loadReviewTypes(pi: ExtensionAPI): Promise<ReviewType[]> {
	const commands = pi.getCommands();
	const templates = commands.filter(
		(cmd) => cmd.source === "prompt" && cmd.name.startsWith(REVIEW_PREFIX) && cmd.path,
	);

	const reviews: ReviewType[] = [];
	for (const cmd of templates) {
		const raw = await fs.readFile(cmd.path!, "utf8");
		reviews.push({
			id: cmd.name,
			label: cmd.name.slice(REVIEW_PREFIX.length).replace(/-/g, " "),
			prompt: stripFrontmatter(raw),
		});
	}
	return reviews;
}

function restoreSelection(reviewTypes: ReviewType[], entries: SelectionEntry[]): Set<string> {
	const byId = new Set(reviewTypes.map((review) => review.id));
	let selectedIds: string[] | undefined;

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "review-config") {
			const data = entry.data as ReviewSelectionState | undefined;
			if (data?.selectedIds) {
				selectedIds = data.selectedIds;
			}
		}
	}

	return new Set(selectedIds?.filter((id) => byId.has(id)) ?? Array.from(byId));
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (result.code !== 0) return "HEAD";
	return result.stdout.trim() || "HEAD";
}

async function ensureBaseExists(pi: ExtensionAPI, base: string): Promise<boolean> {
	const check = await pi.exec("git", ["rev-parse", "--verify", base]);
	return check.code === 0;
}

async function getUntrackedDiff(pi: ExtensionAPI): Promise<string> {
	const list = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"]);
	if (list.code !== 0) return "";

	const files = list.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
	let output = "";

	for (const file of files) {
		const diff = await pi.exec("git", ["diff", "--no-index", "--", "/dev/null", file]);
		if (diff.code !== 0 && diff.code !== 1) {
			throw new Error(diff.stderr.trim() || `Failed to diff untracked file: ${file}`);
		}
		output += diff.stdout;
	}

	return output;
}

async function getWorkingDiff(pi: ExtensionAPI): Promise<string> {
	const headCheck = await pi.exec("git", ["rev-parse", "--verify", "HEAD"]);
	let output = "";

	if (headCheck.code === 0) {
		const diff = await pi.exec("git", ["diff", "HEAD"]);
		if (diff.code !== 0) {
			throw new Error(diff.stderr.trim() || "git diff HEAD failed");
		}
		output += diff.stdout;
	} else {
		const unstaged = await pi.exec("git", ["diff"]);
		if (unstaged.code !== 0) {
			throw new Error(unstaged.stderr.trim() || "git diff failed");
		}
		output += unstaged.stdout;

		const staged = await pi.exec("git", ["diff", "--cached"]);
		if (staged.code !== 0) {
			throw new Error(staged.stderr.trim() || "git diff --cached failed");
		}
		output += staged.stdout;
	}

	output += await getUntrackedDiff(pi);
	return output;
}

async function getBranchDiff(pi: ExtensionAPI, base: string, head: string): Promise<string> {
	const diff = await pi.exec("git", ["diff", `${base}...${head}`]);
	if (diff.code !== 0) {
		throw new Error(diff.stderr.trim() || "git diff failed");
	}
	return diff.stdout;
}

async function getCommitLog(pi: ExtensionAPI, base: string, head: string): Promise<string> {
	const log = await pi.exec("git", ["log", "--oneline", `${base}..${head}`]);
	if (log.code !== 0) return "";
	return log.stdout.trim();
}

async function getIgnoredFiles(pi: ExtensionAPI): Promise<Set<string>> {
	const ignored = await pi.exec("git", [
		"ls-files",
		"--ignored",
		"--exclude-standard",
		"--cached",
		"--others",
	]);
	if (ignored.code !== 0) {
		throw new Error(ignored.stderr.trim() || "git ls-files --ignored failed");
	}

	return new Set(
		ignored.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	);
}

async function getRepositorySnapshot(pi: ExtensionAPI): Promise<string> {
	const tracked = await pi.exec("git", ["ls-files"]);
	if (tracked.code !== 0) {
		throw new Error(tracked.stderr.trim() || "git ls-files failed");
	}

	const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"]);
	if (untracked.code !== 0) {
		throw new Error(untracked.stderr.trim() || "git ls-files --others failed");
	}

	const ignored = await getIgnoredFiles(pi);
	const files = Array.from(
		new Set(
			(tracked.stdout + "\n" + untracked.stdout)
				.split("\n")
				.map((line) => line.trim())
				.filter((file) => file.length > 0 && !ignored.has(file)),
		),
	).sort((a, b) => a.localeCompare(b));

	let output = "";
	let skippedBinary = 0;
	let skippedUnreadable = 0;

	for (const file of files) {
		try {
			const stat = await fs.stat(file);
			if (!stat.isFile()) continue;
			const buf = await fs.readFile(file);
			if (buf.includes(0)) {
				skippedBinary += 1;
				continue;
			}

			const content = buf.toString("utf8");
			output += `\n\n--- FILE: ${file} ---\n${content}`;
		} catch {
			skippedUnreadable += 1;
		}
	}

	const header =
		`Repository snapshot (${files.length} files scanned)` +
		`\nIgnored by .gitignore: ${ignored.size}` +
		`\nSkipped binary files: ${skippedBinary}` +
		`\nSkipped unreadable files: ${skippedUnreadable}`;

	return `${header}${output}`;
}

async function applyTruncation(text: string, label: string, extension: string): Promise<string> {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let result = truncation.content;
	if (truncation.truncated) {
		const tempPath = path.join(os.tmpdir(), `pi-review-${Date.now()}${extension}`);
		await fs.writeFile(tempPath, text);
		result +=
			"\n\n[" +
			`${label} truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
			`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
			`Full ${label.toLowerCase()} saved to: ${tempPath}]`;
	}
	return result;
}

function sanitizeFileComponent(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function buildReviewOutputPath(branch: string): string {
	const safeBranch = branch === "HEAD" ? "detached" : sanitizeFileComponent(branch);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(".pi", "reviews", `review-${stamp}-${safeBranch}.md`);
}

// --- GitHub PR helpers ---

interface PrInfo {
	number: number;
	title: string;
	author: string;
	headRefName: string;
	baseRefName: string;
	url: string;
	body: string;
	state: string;
}

async function checkGhAuth(pi: ExtensionAPI): Promise<boolean> {
	const result = await pi.exec("gh", ["auth", "status"]);
	return result.code === 0;
}

async function listOpenPrs(pi: ExtensionAPI, limit = 30): Promise<PrInfo[]> {
	const result = await pi.exec("gh", [
		"pr",
		"list",
		"--state",
		"open",
		"--limit",
		String(limit),
		"--json",
		"number,title,author,headRefName,baseRefName,url,body,state",
	]);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || "Failed to list pull requests");
	}
	const raw = JSON.parse(result.stdout) as Array<{
		number: number;
		title: string;
		author: { login: string };
		headRefName: string;
		baseRefName: string;
		url: string;
		body: string;
		state: string;
	}>;
	return raw.map((pr) => ({
		number: pr.number,
		title: pr.title,
		author: pr.author.login,
		headRefName: pr.headRefName,
		baseRefName: pr.baseRefName,
		url: pr.url,
		body: pr.body,
		state: pr.state,
	}));
}

async function getPrDetails(pi: ExtensionAPI, prRef: string): Promise<PrInfo> {
	const result = await pi.exec("gh", [
		"pr",
		"view",
		prRef,
		"--json",
		"number,title,author,headRefName,baseRefName,url,body,state",
	]);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `Failed to get PR details for '${prRef}'`);
	}
	const pr = JSON.parse(result.stdout) as {
		number: number;
		title: string;
		author: { login: string };
		headRefName: string;
		baseRefName: string;
		url: string;
		body: string;
		state: string;
	};
	return {
		number: pr.number,
		title: pr.title,
		author: pr.author.login,
		headRefName: pr.headRefName,
		baseRefName: pr.baseRefName,
		url: pr.url,
		body: pr.body,
		state: pr.state,
	};
}

async function getPrDiff(pi: ExtensionAPI, prRef: string): Promise<string> {
	const result = await pi.exec("gh", ["pr", "diff", prRef, "--color", "never"]);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `Failed to get diff for PR '${prRef}'`);
	}
	return result.stdout;
}

async function getPrCommitLog(pi: ExtensionAPI, prRef: string): Promise<string> {
	const result = await pi.exec("gh", [
		"pr",
		"view",
		prRef,
		"--json",
		"commits",
	]);
	if (result.code !== 0) return "";
	const data = JSON.parse(result.stdout) as {
		commits: Array<{ oid: string; messageHeadline: string; authors: Array<{ login: string }> }>;
	};
	if (!data.commits || data.commits.length === 0) return "";
	return data.commits
		.map((c) => `${c.oid.slice(0, 7)} ${c.messageHeadline}`)
		.join("\n");
}

export default function reviewExtension(pi: ExtensionAPI) {
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

			const activeReviews = reviewTypes.filter((review) => selected.has(review.id));
			if (activeReviews.length === 0) {
				ctx.ui.notify("No review types selected.", "warning");
				return;
			}

			const branch = await getCurrentBranch(pi);

			// Check gh availability for the PR option label
			const ghAvailable = await checkGhAuth(pi);
			const prOption = "GitHub Pull Request" + (ghAvailable ? "" : " (gh auth required)");

			const scope = await ctx.ui.select("Compare which changes?", [
				"Uncommitted changes (staged + unstaged + untracked)",
				`Current branch (${branch}) vs ${MAIN_BRANCH}`,
				"Current branch vs another base",
				prOption,
				"Complete code base (excluding .gitignored files)",
			]);
			if (!scope) return;

			let reviewInputText = "";
			let reviewInputLabel = "";
			let reviewInputTitle = "Diff";
			let reviewInputFence = "diff";
			let commitLog = "";
			let prContext = "";
			let outputPath: string | null = null;

			if (scope.startsWith("Uncommitted")) {
				reviewInputText = await getWorkingDiff(pi);
				reviewInputLabel = "working tree";
			} else if (scope.includes(`vs ${MAIN_BRANCH}`)) {
				if (!(await ensureBaseExists(pi, MAIN_BRANCH))) {
					ctx.ui.notify(`Base branch '${MAIN_BRANCH}' not found.`, "error");
					return;
				}
				reviewInputText = await getBranchDiff(pi, MAIN_BRANCH, branch);
				reviewInputLabel = `${MAIN_BRANCH}...${branch}`;
				if (selected.has(`${REVIEW_PREFIX}commit-discipline`)) {
					commitLog = await getCommitLog(pi, MAIN_BRANCH, branch);
				}
			} else if (scope.startsWith("Current branch vs another base")) {
				const base = await ctx.ui.input("Base branch:", MAIN_BRANCH);
				if (!base) return;
				if (!(await ensureBaseExists(pi, base))) {
					ctx.ui.notify(`Base branch '${base}' not found.`, "error");
					return;
				}
				reviewInputText = await getBranchDiff(pi, base, branch);
				reviewInputLabel = `${base}...${branch}`;
				if (selected.has(`${REVIEW_PREFIX}commit-discipline`)) {
					commitLog = await getCommitLog(pi, base, branch);
				}
			} else if (scope.startsWith("GitHub Pull Request")) {
				if (!ghAvailable) {
					ctx.ui.notify(
						"GitHub CLI is not authenticated. Run 'gh auth login' first.",
						"error",
					);
					return;
				}

				// Let user pick a PR
				let prRef: string | undefined;
				const prMethod = await ctx.ui.select("How to specify the PR?", [
					"Select from open PRs",
					"Enter PR number or URL",
				]);
				if (!prMethod) return;

				if (prMethod.startsWith("Select")) {
					ctx.ui.setStatus("review", "Loading open PRs…");
					let prs: PrInfo[];
					try {
						prs = await listOpenPrs(pi);
					} catch (err) {
						ctx.ui.setStatus("review", undefined);
						ctx.ui.notify(`Failed to list PRs: ${String(err)}`, "error");
						return;
					}
					ctx.ui.setStatus("review", undefined);

					if (prs.length === 0) {
						ctx.ui.notify("No open pull requests found.", "warning");
						return;
					}

					const prChoices = prs.map(
						(pr) => `#${pr.number} — ${pr.title} (${pr.author}, ${pr.headRefName} → ${pr.baseRefName})`,
					);
					const prChoice = await ctx.ui.select("Select a pull request:", prChoices);
					if (!prChoice) return;

					const idx = prChoices.indexOf(prChoice);
					prRef = String(prs[idx].number);
				} else {
					const input = await ctx.ui.input("PR number or URL:");
					if (!input) return;
					prRef = input.trim();
				}

				// Fetch PR details and diff
				ctx.ui.setStatus("review", "Fetching PR details…");
				let prInfo: PrInfo;
				try {
					prInfo = await getPrDetails(pi, prRef);
				} catch (err) {
					ctx.ui.setStatus("review", undefined);
					ctx.ui.notify(`Failed to fetch PR details: ${String(err)}`, "error");
					return;
				}

				ctx.ui.setStatus("review", "Fetching PR diff…");
				try {
					reviewInputText = await getPrDiff(pi, prRef);
				} catch (err) {
					ctx.ui.setStatus("review", undefined);
					ctx.ui.notify(`Failed to fetch PR diff: ${String(err)}`, "error");
					return;
				}

				// Fetch commit log for commit-discipline review
				if (selected.has(`${REVIEW_PREFIX}commit-discipline`)) {
					commitLog = await getPrCommitLog(pi, prRef);
				}

				ctx.ui.setStatus("review", undefined);

				reviewInputLabel = `PR #${prInfo.number} (${prInfo.headRefName} → ${prInfo.baseRefName})`;

				// Build PR context section
				const prBody = prInfo.body?.trim()
					? `\n\nPR description:\n${prInfo.body.trim()}`
					: "";
				prContext =
					`\n\nPull Request: #${prInfo.number} — ${prInfo.title}` +
					`\nAuthor: ${prInfo.author}` +
					`\nBranches: ${prInfo.headRefName} → ${prInfo.baseRefName}` +
					`\nURL: ${prInfo.url}` +
					`\nState: ${prInfo.state}` +
					prBody;
			} else {
				reviewInputText = await getRepositorySnapshot(pi);
				reviewInputLabel = "repository snapshot";
				reviewInputTitle = "Codebase";
				reviewInputFence = "text";
			}

			if (!reviewInputText.trim()) {
				ctx.ui.notify("No review input detected for the selected scope.", "warning");
				return;
			}

			try {
				outputPath = buildReviewOutputPath(branch);
				await fs.mkdir(path.dirname(outputPath), { recursive: true });
			} catch (error) {
				ctx.ui.notify(`Failed to prepare review output path: ${String(error)}`, "error");
				outputPath = null;
			}

			const reviewBlocks = activeReviews
				.map((review) => `### ${review.label}\n${review.prompt}`)
				.join("\n\n");

			const reviewInputBody = await applyTruncation(
				reviewInputText,
				reviewInputTitle,
				reviewInputFence === "diff" ? ".diff" : ".txt",
			);
			const commitSection = commitLog
				? `\n\nCommit log (${reviewInputLabel.replace("...", "..")}):\n\n${commitLog}`
				: "";
			const outputInstruction = outputPath
				? `\n\nWrite the full review as Markdown to \`${outputPath}\` (use the write tool). ` +
					"Then respond here with a brief summary and the file path."
				: "";

			const prompt =
				"Please review the following changes.\n\n" +
				reviewBlocks +
				prContext +
				commitSection +
				outputInstruction +
				"\n\n" +
				reviewInputTitle +
				" (" +
				reviewInputLabel +
				"):\n```" +
				reviewInputFence +
				"\n" +
				reviewInputBody +
				"\n```\n";

			pi.sendUserMessage(prompt);
		},
	});
}
