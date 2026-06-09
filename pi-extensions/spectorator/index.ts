import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const STATUS_KEY = "spectorator";
const REVIEW_TOOL_NAME = "spectorator_review_spec";
const DEFAULT_SPEC_DIR = path.join(os.homedir(), "data", "specs");
const MARKDOWN_EXTENSION_RE = /\.(md|markdown)$/i;
const PROMPT_TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt.md");

const REQUIRED_H1_SECTIONS = ["Abstract", "Rationale", "Specification"] as const;
const OPTIONAL_H1_SECTIONS = ["Further Information"] as const;
const ALL_H1_SECTIONS = [...REQUIRED_H1_SECTIONS, ...OPTIONAL_H1_SECTIONS] as const;

const reviewSpecSchema = {
	type: "object",
	properties: {
		filePath: {
			type: "string",
			description: "Path to the markdown spec file to review. Absolute paths and paths relative to cwd are supported.",
		},
	},
	required: ["filePath"],
	additionalProperties: false,
} as const;

type ReviewSpecToolParams = { filePath: string };

type ParsedArgs = {
	help: boolean;
	path?: string;
	title?: string;
	input: string;
};

type ReviewResult = {
	feedback?: string;
	approved?: boolean;
	exit?: boolean;
};

type PlanReviewStartResult = {
	status: "pending";
	reviewId: string;
};

type PlanReviewEvent = {
	reviewId: string;
	approved: boolean;
	feedback?: string;
};

type PlannotatorResponse<T> =
	| { status: "handled"; result: T }
	| { status: "unavailable"; error?: string }
	| { status: "error"; error: string };

type SpecAnalysis = {
	missingRequired: string[];
	wrongLevel: Array<{ section: string; level: number; line: number }>;
	duplicateH1: string[];
	unexpectedH1: string[];
	hasFurtherInformation: boolean;
	xxxCount: number;
};

export default function spectoratorExtension(pi: ExtensionAPI) {
	pi.registerCommand("spectorator", {
		description: "Create and iteratively review a fixed-format markdown spec",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trim();
			const options = ["--help", "--path", "--title"];
			if (trimmed.startsWith("-")) {
				return options
					.filter((option) => option.startsWith(trimmed))
					.map((option) => ({ value: option, label: option }));
			}
			return null;
		},
		handler: async (rawArgs, ctx) => {
			let parsed: ParsedArgs;
			try {
				parsed = parseArgs(rawArgs);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
				ctx.ui.notify("Run /spectorator --help for usage.", "warning");
				return;
			}

			const specDir = resolveSpecDirectory(ctx.cwd);
			if (parsed.help) {
				publishInfo(pi, usageText(specDir), { usage: true, specDir });
				return;
			}

			if (!parsed.input.trim() && !parsed.title?.trim()) {
				ctx.ui.notify("Usage: /spectorator [--title <title>] [--path <path>] <spec idea>", "warning");
				return;
			}

			ctx.ui.setStatus(STATUS_KEY, "Preparing spec skeleton...");
			try {
				const title = chooseTitle(parsed);
				const specPath = resolveOutputSpecPath({
					inputPath: parsed.path,
					title,
					cwd: ctx.cwd,
					specDir,
				});
				await ensureSpecSkeleton(specPath, title, parsed.input);

				const template = await loadPromptTemplate(ctx.cwd);
				const prompt = buildSpectoratorPrompt({
					specPath,
					title,
					userInput: parsed.input,
					template,
				});

				if (ctx.isIdle()) {
					pi.sendUserMessage(prompt);
				} else {
					pi.sendUserMessage(prompt, { deliverAs: "followUp" });
					ctx.ui.notify("Queued /spectorator follow-up request.", "info");
				}
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});

	pi.registerTool({
		name: REVIEW_TOOL_NAME,
		label: "Review Spec",
		description:
			"Open a markdown spec in the Spectorator/Plannotator browser review gate. " +
			"Use this after creating or revising a fixed-format spec. If feedback is returned, revise the same file and call this tool again.",
		promptSnippet: "Open the current spec for browser review and iterate until approved.",
		promptGuidelines: [
			"Use this after writing or revising a Spectorator spec.",
			"If the user returns feedback, edit the same spec file before calling the tool again.",
			"Approval means the spec is accepted; do not start implementation automatically.",
		],
		parameters: reviewSpecSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const inputPath = (params as ReviewSpecToolParams).filePath?.trim();
			try {
				const specPath = resolveExistingMarkdownPath(inputPath, ctx.cwd);
				const markdown = await fsPromises.readFile(specPath, "utf8");
				const analysis = analyzeSpecStructure(markdown);
				const preflightNotes = buildPreflightNotes(analysis);

				if (!ctx.hasUI) {
					return toolText(
						"Spectorator could not open browser review because this session has no UI. " +
						"Ask the user for text feedback on the spec instead, then revise the same file.",
						{ approved: false, reason: "no-ui", preflightNotes },
					);
				}

				const result = await requestPlannotatorPlanReview(pi, {
					planContent: markdown,
					planFilePath: specPath,
				});

				if (result.approved) {
					return {
						content: [
							{
								type: "text",
								text: [
									`Spec approved: ${specPath}`,
									preflightNotes.length > 0 ? "\nPreflight notes retained for reference:\n" + preflightNotes.map((note) => `- ${note}`).join("\n") : "",
								].join(""),
							},
						],
						details: { approved: true, specPath, preflightNotes },
						terminate: true,
					};
				}

				if (result.exit) {
					return toolText(
						"The spec review was closed without approval. Ask the user how to proceed before resubmitting.",
						{ approved: false, exit: true, specPath, preflightNotes },
					);
				}

				const feedback = result.feedback?.trim() || "The spec was not approved. Revise it and resubmit.";
				return toolText(
					[
						"SPEC REVIEW FEEDBACK — the spec was not approved.",
						"",
						`Spec file: ${specPath}`,
						"",
						"You must address all feedback in the same markdown file, preserve the fixed H1 structure, and call spectorator_review_spec again.",
						preflightNotes.length > 0 ? "\nPreflight notes:\n" + preflightNotes.map((note) => `- ${note}`).join("\n") : "",
						"",
						"User feedback and annotations:",
						feedback,
					].join("\n"),
					{ approved: false, feedback, specPath, preflightNotes },
				);
			} catch (error) {
				return toolText(`Spectorator review failed: ${formatError(error)}`, {
					approved: false,
					error: formatError(error),
				});
			}
		},
	});
}

function usageText(specDir: string): string {
	return [
		"Usage:",
		"  /spectorator [--title <title>] [--path <path>] <spec idea>",
		"",
		"Behavior:",
		"  - Creates a fixed-format markdown spec skeleton.",
		"  - Asks the agent to fill the spec in place.",
		"  - The agent opens browser review with spectorator_review_spec and iterates until approval.",
		"",
		"Spec format:",
		"  # Abstract",
		"  # Rationale",
		"  # Specification",
		"  # Further Information",
		"",
		"Environment:",
		`  SPECTORATOR_DIR overrides the default spec directory (default: ${specDir})`,
	].join("\n");
}

function parseArgs(rawArgs: string): ParsedArgs {
	const tokens = splitShellArgs(rawArgs);
	const rest: string[] = [];
	const out: ParsedArgs = { help: false, input: "" };

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		switch (token) {
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--path":
			case "-p":
				index += 1;
				if (!tokens[index]) throw new Error(`${token} requires a value`);
				out.path = tokens[index];
				break;
			case "--title":
			case "-t":
				index += 1;
				if (!tokens[index]) throw new Error(`${token} requires a value`);
				out.title = tokens[index];
				break;
			default:
				if (token.startsWith("--")) throw new Error(`unknown option: ${token}`);
				rest.push(token);
		}
	}

	out.input = rest.join(" ").trim();
	return out;
}

function splitShellArgs(input: string): string[] {
	const out: string[] = [];
	const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(input)) !== null) {
		const token = match[1] ?? match[2] ?? match[3] ?? "";
		if (token !== "") out.push(token.replace(/\\(["'\\ ])/g, "$1"));
	}
	return out;
}

function resolveSpecDirectory(cwd: string): string {
	const configured = process.env.SPECTORATOR_DIR?.trim();
	if (!configured) return DEFAULT_SPEC_DIR;
	return toAbsolutePath(configured, cwd);
}

function chooseTitle(parsed: ParsedArgs): string {
	const candidate = parsed.title?.trim() || parsed.input.trim();
	if (!candidate) return "Untitled Spec";
	return candidate
		.replace(/\s+/g, " ")
		.replace(/[\r\n]/g, " ")
		.trim()
		.slice(0, 96)
		|| "Untitled Spec";
}

function resolveOutputSpecPath(options: {
	inputPath?: string;
	title: string;
	cwd: string;
	specDir: string;
}): string {
	if (options.inputPath?.trim()) {
		return normalizeOutputPath(options.inputPath, options.cwd, options.specDir);
	}
	const slug = slugify(options.title) || "untitled-spec";
	return makeUniquePath(path.join(options.specDir, `${slug}.md`));
}

function normalizeOutputPath(inputPath: string, cwd: string, specDir: string): string {
	const normalized = normalizeMarkdownFilename(inputPath);
	const target = isPathLike(normalized)
		? toAbsolutePath(normalized, cwd)
		: path.join(specDir, normalized);
	return path.normalize(target);
}

function normalizeMarkdownFilename(inputPath: string): string {
	const trimmed = inputPath.trim();
	if (!trimmed) throw new Error("spec path is required");
	const ext = path.extname(trimmed);
	if (!ext) return `${trimmed}.md`;
	if (!MARKDOWN_EXTENSION_RE.test(trimmed)) {
		throw new Error("spectorator only supports markdown files (.md or .markdown)");
	}
	return trimmed;
}

function resolveExistingMarkdownPath(inputPath: string, cwd: string): string {
	const fullPath = toAbsolutePath(normalizeMarkdownFilename(inputPath), cwd);
	if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
		throw new Error(`Spec file not found: ${fullPath}`);
	}
	return path.normalize(fullPath);
}

function isPathLike(value: string): boolean {
	return (
		value.includes("/") ||
		value.includes("\\") ||
		value.startsWith(".") ||
		value.startsWith("~") ||
		path.isAbsolute(value)
	);
}

function toAbsolutePath(inputPath: string, cwd: string): string {
	const withHome = inputPath.startsWith("~")
		? path.join(os.homedir(), inputPath.slice(1).replace(/^[/\\]/, ""))
		: inputPath;
	return path.isAbsolute(withHome) ? path.normalize(withHome) : path.resolve(cwd, withHome);
}

function makeUniquePath(basePath: string): string {
	if (!fs.existsSync(basePath)) return path.normalize(basePath);
	const parsed = path.parse(basePath);
	for (let index = 2; index < 10_000; index += 1) {
		const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
		if (!fs.existsSync(candidate)) return path.normalize(candidate);
	}
	throw new Error(`Could not find an unused spec path for ${basePath}`);
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

async function ensureSpecSkeleton(specPath: string, title: string, userInput: string): Promise<void> {
	await fsPromises.mkdir(path.dirname(specPath), { recursive: true });
	if (fs.existsSync(specPath)) return;
	await fsPromises.writeFile(specPath, buildSpecSkeleton(title, userInput), "utf8");
}

function buildSpecSkeleton(title: string, userInput: string): string {
	const escapedTitle = title.replace(/"/g, "\\\"");
	const sourceInput = userInput.trim()
		? `\n\nInitial user input:\n\n> ${userInput.trim().replace(/\n/g, "\n> ")}`
		: "";
	return [
		"---",
		`title: "${escapedTitle}"`,
		"---",
		"",
		"# Abstract",
		"",
		"xxx: One-sentence summary of the proposal.",
		sourceInput,
		"",
		"# Rationale",
		"",
		"xxx: One-sentence reason this work is needed.",
		"",
		"# Specification",
		"",
		"xxx: Describe the proposed behavior and design. Include approach, user journey, scope/non-scope, implementation notes, testing/user acceptance tests, and documentation impact as applicable.",
		"",
		"# Further Information",
		"",
		"- References: xxx",
		"- Future work: xxx",
		"- Alternative approaches: xxx",
		"",
	].join("\n");
}

async function loadPromptTemplate(_cwd: string): Promise<string | undefined> {
	try {
		const raw = await fsPromises.readFile(PROMPT_TEMPLATE_PATH, "utf8");
		const stripped = stripFrontmatter(raw).trim();
		return stripped.length > 0 ? stripped : undefined;
	} catch {
		return undefined;
	}
}

function stripFrontmatter(text: string): string {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return text;
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end === -1) return text;
	return lines.slice(end + 1).join("\n");
}

function renderTemplate(template: string, values: Record<string, string>): string {
	let output = template;
	for (const [key, value] of Object.entries(values)) {
		output = output.replaceAll(`{{${key}}}`, value);
	}
	return output;
}

function buildSpectoratorPrompt(options: {
	specPath: string;
	title: string;
	userInput: string;
	template?: string;
}): string {
	const values = {
		SPEC_PATH: options.specPath,
		SPEC_TITLE: options.title,
		USER_INPUT: options.userInput || "(no additional input provided)",
		REVIEW_TOOL: REVIEW_TOOL_NAME,
	};

	if (options.template?.trim()) {
		return renderTemplate(options.template, values).trim();
	}

	return [
		`Please act as Spectorator and create an iterative fixed-format markdown spec at \`${options.specPath}\`.`,
		"",
		`Spec title: ${options.title}`,
		"",
		"User input:",
		options.userInput || "(no additional input provided)",
		"",
		"Workflow:",
		`1. Read \`${options.specPath}\`.`,
		"2. Fill or improve the spec in place via edit/write tools.",
		"3. Preserve this exact primary H1 structure: `# Abstract`, `# Rationale`, `# Specification`, optional `# Further Information`.",
		"4. Put unresolved decisions in explicit `xxx` open-question markers.",
		"5. When the spec is ready for human review, call `spectorator_review_spec` with the spec path.",
		"6. If review feedback is returned, address all feedback in the same file and call `spectorator_review_spec` again.",
		"7. If approved, stop; do not start implementation automatically.",
		"",
		"Specification guidance:",
		"- `# Abstract`: start with a single succinct sentence; expand only if review feedback makes it necessary.",
		"- `# Rationale`: start with one short paragraph or sentence explaining why this is needed; refine incrementally.",
		"- `# Specification`: include approach, user journey, design, scope/non-scope, implementation notes, testing/user acceptance tests, and documentation impact as applicable.",
		"- Larger specs may subdivide `# Specification` into milestones.",
		"- `# Further Information`: references, future work, and alternative approaches.",
	].join("\n");
}

function analyzeSpecStructure(markdown: string): SpecAnalysis {
	const headings = parseHeadings(markdown);
	const byTitle = new Map<string, Array<{ level: number; line: number; title: string }>>();
	for (const heading of headings) {
		const list = byTitle.get(normalizeHeadingTitle(heading.title)) ?? [];
		list.push(heading);
		byTitle.set(normalizeHeadingTitle(heading.title), list);
	}

	const missingRequired: string[] = [];
	const wrongLevel: Array<{ section: string; level: number; line: number }> = [];
	const duplicateH1: string[] = [];

	for (const section of REQUIRED_H1_SECTIONS) {
		const matches = byTitle.get(normalizeHeadingTitle(section)) ?? [];
		const h1 = matches.filter((heading) => heading.level === 1);
		if (h1.length === 0) {
			if (matches.length > 0) wrongLevel.push({ section, level: matches[0].level, line: matches[0].line });
			else missingRequired.push(section);
		}
		if (h1.length > 1) duplicateH1.push(section);
	}

	const furtherMatches = byTitle.get(normalizeHeadingTitle("Further Information")) ?? [];
	const furtherH1 = furtherMatches.filter((heading) => heading.level === 1);
	if (furtherH1.length > 1) duplicateH1.push("Further Information");

	const allowed = new Set(ALL_H1_SECTIONS.map(normalizeHeadingTitle));
	const unexpectedH1 = unique(
		headings
			.filter((heading) => heading.level === 1 && !allowed.has(normalizeHeadingTitle(heading.title)))
			.map((heading) => heading.title),
	);

	return {
		missingRequired,
		wrongLevel,
		duplicateH1,
		unexpectedH1,
		hasFurtherInformation: furtherH1.length > 0,
		xxxCount: (markdown.match(/\bxxx\b/gi) ?? []).length,
	};
}

function parseHeadings(markdown: string): Array<{ level: number; line: number; title: string }> {
	return markdown
		.split(/\r?\n/)
		.map((line, index) => ({ line, index }))
		.map(({ line, index }) => {
			const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
			return match ? { level: match[1].length, line: index + 1, title: match[2].trim() } : undefined;
		})
		.filter((heading): heading is { level: number; line: number; title: string } => Boolean(heading));
}

function normalizeHeadingTitle(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildPreflightNotes(analysis: SpecAnalysis): string[] {
	const notes: string[] = [];
	if (analysis.missingRequired.length > 0) {
		notes.push(`Missing required H1 sections: ${analysis.missingRequired.join(", ")}.`);
	}
	for (const item of analysis.wrongLevel) {
		notes.push(`Section ${item.section} is level H${item.level} on line ${item.line}; it must be H1.`);
	}
	if (analysis.duplicateH1.length > 0) {
		notes.push(`Duplicate H1 sections: ${analysis.duplicateH1.join(", ")}.`);
	}
	if (analysis.unexpectedH1.length > 0) {
		notes.push(`Unexpected H1 sections: ${analysis.unexpectedH1.join(", ")}. Keep primary sections fixed.`);
	}
	if (!analysis.hasFurtherInformation) {
		notes.push("Optional # Further Information section is not present.");
	}
	if (analysis.xxxCount > 0) {
		notes.push(`Spec still contains ${analysis.xxxCount} xxx open-question marker(s).`);
	}
	return notes;
}

function requestPlannotatorPlanReview(
	pi: ExtensionAPI,
	payload: { planContent: string; planFilePath: string },
): Promise<ReviewResult> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let reviewId: string | undefined;
		let unsubscribe: (() => void) | undefined;
		let startupTimer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (startupTimer) clearTimeout(startupTimer);
			unsubscribe?.();
			unsubscribe = undefined;
		};
		const finish = (next: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			next();
		};

		unsubscribe = pi.events.on("plannotator:review-result", (data) => {
			const event = data as Partial<PlanReviewEvent> | null;
			if (!event || event.reviewId !== reviewId) return;
			finish(() => resolve({
				approved: event.approved === true,
				feedback: typeof event.feedback === "string" ? event.feedback : "",
			}));
		});

		startupTimer = setTimeout(() => {
			finish(() => reject(new Error("Plannotator did not respond. Ensure @plannotator/pi-extension is installed and loaded.")));
		}, 5000);

		const respond = (response: PlannotatorResponse<PlanReviewStartResult>) => {
			if (settled) return;
			if (response.status !== "handled") {
				finish(() => reject(new Error(response.error || "Plannotator is unavailable.")));
				return;
			}
			reviewId = response.result.reviewId;
			if (!reviewId) {
				finish(() => reject(new Error("Plannotator returned no review id.")));
				return;
			}
			if (startupTimer) clearTimeout(startupTimer);
			startupTimer = undefined;
		};

		pi.events.emit("plannotator:request", {
			requestId: randomUUID(),
			action: "plan-review",
			payload,
			respond,
		});
	});
}

function toolText(text: string, details: Record<string, unknown>) {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function publishInfo(pi: ExtensionAPI, content: string, details: Record<string, unknown>): void {
	pi.sendMessage({
		customType: "spectorator",
		content,
		details,
		display: true,
	});
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export const __test = {
	parseArgs,
	splitShellArgs,
	resolveSpecDirectory,
	chooseTitle,
	resolveOutputSpecPath,
	normalizeOutputPath,
	normalizeMarkdownFilename,
	resolveExistingMarkdownPath,
	slugify,
	buildSpecSkeleton,
	stripFrontmatter,
	renderTemplate,
	buildSpectoratorPrompt,
	analyzeSpecStructure,
	buildPreflightNotes,
	requestPlannotatorPlanReview,
};
