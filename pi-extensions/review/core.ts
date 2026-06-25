import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Marked, Renderer, type Tokens } from "marked";

export const REVIEW_PREFIX = "review-";
export const MAIN_BRANCH = "main";
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_REVIEW_PROMPTS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../pi-prompts",
);

const REVIEW_CALIBRATION = [
	"Review calibration:",
	"",
	'- Do not force findings for every rubric. "No material issues found" is a valid outcome.',
	"- If a finding depends on external-system behavior, verify it against docs, source, or specs and cite it. If you cannot verify it after trying, mark it unverified and present it as a question/follow-up, not a blocker.",
	"- Before marking a finding blocking/high-severity, identify the concrete fact that would make it not a bug and confirm that fact is false.",
	"- Missing tests are test-quality gaps, not evidence that runtime behavior is broken.",
].join("\n");

export interface ReviewType {
	id: string;
	label: string;
	prompt: string;
	path?: string;
}

export interface ReviewSelectionState {
	selectedIds: string[];
}

export type SelectionEntry = {
	type: string;
	customType?: string;
	data?: unknown;
};

export interface PrInfo {
	number: number;
	title: string;
	author: string;
	headRefName: string;
	baseRefName: string;
	url: string;
	body: string;
	state: string;
}

export type ReviewScope =
	| {
		kind: "working-tree";
	}
	| {
		kind: "branch";
		base: string;
		head?: string;
	}
	| {
		kind: "repository";
	}
	| {
		kind: "pull-request";
		prRef: string;
	};

export interface PrepareReviewRequestOptions {
	reviewIds?: string[];
	scope: ReviewScope;
	outputPath?: string;
	/** Internal: when set by interactive /review, ask the agent to present the finished Markdown with this tool. */
	presentationToolName?: string;
}

export interface PreparedReviewRequest {
	branch: string;
	activeReviews: ReviewType[];
	reviewInputLabel: string;
	reviewInputTitle: string;
	reviewInputFence: string;
	reviewInputText: string;
	commitLog: string;
	prContext: string;
	outputPath: string;
	prompt: string;
}

export interface RepositorySnapshot {
	text: string;
	stats: {
		scannedFiles: number;
		ignoredFiles: number;
		skippedBinaryFiles: number;
		skippedUnreadableFiles: number;
	};
}

function toReviewLabel(id: string): string {
	return id.slice(REVIEW_PREFIX.length).replace(/-/g, " ");
}

export function stripFrontmatter(text: string): string {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return text.trim();
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end === -1) return text.trim();
	return lines.slice(end + 1).join("\n").trim();
}

async function loadPromptBody(filePath: string): Promise<string> {
	const raw = await fs.readFile(filePath, "utf8");
	const prompt = stripFrontmatter(raw);
	if (!prompt) {
		throw new Error(`Review prompt is empty: ${filePath}`);
	}
	return prompt;
}

function getCommandPath(command: {
	sourceInfo?: { path?: string };
	path?: string;
}): string | undefined {
	return command.sourceInfo?.path ?? command.path;
}

async function loadReviewTypesFromCommands(pi: ExtensionAPI): Promise<ReviewType[]> {
	const commands = pi.getCommands();
	const templates = commands.filter(
		(command) =>
			command.source === "prompt" &&
			command.name.startsWith(REVIEW_PREFIX) &&
			Boolean(getCommandPath(command)),
	);

	const reviews: ReviewType[] = [];
	for (const template of templates) {
		const templatePath = getCommandPath(template);
		if (!templatePath) continue;
		const prompt = await loadPromptBody(templatePath);
		reviews.push({
			id: template.name,
			label: toReviewLabel(template.name),
			prompt,
			path: templatePath,
		});
	}

	return reviews.sort((left, right) => left.id.localeCompare(right.id));
}

async function loadReviewTypesFromDirectory(promptDir: string): Promise<ReviewType[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(promptDir);
	} catch {
		return [];
	}

	const files = entries
		.filter((entry) => /^review-.*\.md$/i.test(entry))
		.sort((left, right) => left.localeCompare(right));

	const reviews: ReviewType[] = [];
	for (const file of files) {
		const filePath = path.join(promptDir, file);
		const id = file.replace(/\.md$/i, "");
		const prompt = await loadPromptBody(filePath);
		reviews.push({
			id,
			label: toReviewLabel(id),
			prompt,
			path: filePath,
		});
	}

	return reviews;
}

export async function loadReviewTypes(pi: ExtensionAPI): Promise<ReviewType[]> {
	const fromCommands = await loadReviewTypesFromCommands(pi);
	if (fromCommands.length > 0) {
		return fromCommands;
	}

	return loadReviewTypesFromDirectory(DEFAULT_REVIEW_PROMPTS_DIR);
}

export function restoreSelection(reviewTypes: ReviewType[], entries: SelectionEntry[]): Set<string> {
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

export async function getCurrentBranch(pi: ExtensionAPI): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (result.code !== 0) return "HEAD";
	return result.stdout.trim() || "HEAD";
}

export type RefRange = {
	base: string;
	head: string;
	operator: ".." | "...";
};

export function parseRefRange(value: string): RefRange | null {
	const normalized = value.trim();
	if (!normalized) {
		return null;
	}

	const tripleDot = normalized.indexOf("...");
	if (tripleDot > -1) {
		const base = normalized.slice(0, tripleDot).trim();
		const head = normalized.slice(tripleDot + 3).trim();
		if (!base || !head) {
			return null;
		}
		return { base, head, operator: "..." };
	}

	const doubleDot = normalized.indexOf("..");
	if (doubleDot > -1) {
		const base = normalized.slice(0, doubleDot).trim();
		const head = normalized.slice(doubleDot + 2).trim();
		if (!base || !head) {
			return null;
		}
		return { base, head, operator: ".." };
	}

	return null;
}

export async function ensureGitRefExists(pi: ExtensionAPI, ref: string): Promise<boolean> {
	const normalized = ref.trim();
	if (!normalized) {
		return false;
	}

	const check = await pi.exec("git", ["rev-parse", "--verify", "--quiet", `${normalized}^{commit}`]);
	return check.code === 0;
}

export async function ensureGitRevisionExpressionExists(
	pi: ExtensionAPI,
	revisionExpression: string,
): Promise<boolean> {
	const normalized = revisionExpression.trim();
	if (!normalized) {
		return false;
	}

	const check = await pi.exec("git", ["rev-list", "--max-count=1", normalized]);
	return check.code === 0 && check.stdout.trim().length > 0;
}

export async function getUntrackedDiff(pi: ExtensionAPI): Promise<string> {
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

export async function getWorkingDiff(pi: ExtensionAPI): Promise<string> {
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

export async function getBranchDiff(
	pi: ExtensionAPI,
	base: string,
	head: string,
	operator: ".." | "..." = "...",
): Promise<string> {
	const diff = await pi.exec("git", ["diff", `${base}${operator}${head}`]);
	if (diff.code !== 0) {
		throw new Error(diff.stderr.trim() || "git diff failed");
	}
	return diff.stdout;
}

export async function getRevisionExpressionDiff(
	pi: ExtensionAPI,
	revisionExpression: string,
): Promise<string> {
	const diff = await pi.exec("git", ["diff", revisionExpression]);
	if (diff.code !== 0) {
		throw new Error(diff.stderr.trim() || "git diff failed");
	}
	return diff.stdout;
}

export async function getCommitLog(pi: ExtensionAPI, base: string, head: string): Promise<string> {
	const log = await pi.exec("git", ["log", "--oneline", `${base}..${head}`]);
	if (log.code !== 0) return "";
	return log.stdout.trim();
}

export async function getRevisionExpressionCommitLog(
	pi: ExtensionAPI,
	revisionExpression: string,
): Promise<string> {
	const log = await pi.exec("git", ["log", "--oneline", revisionExpression]);
	if (log.code !== 0) return "";
	return log.stdout.trim();
}

export async function getIgnoredFiles(pi: ExtensionAPI): Promise<Set<string>> {
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

export async function getRepositorySnapshot(pi: ExtensionAPI): Promise<RepositorySnapshot> {
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
	).sort((left, right) => left.localeCompare(right));

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

	const stats = {
		scannedFiles: files.length,
		ignoredFiles: ignored.size,
		skippedBinaryFiles: skippedBinary,
		skippedUnreadableFiles: skippedUnreadable,
	};

	const header =
		`Repository snapshot (${stats.scannedFiles} files scanned)` +
		`\nIgnored by .gitignore: ${stats.ignoredFiles}` +
		`\nSkipped binary files: ${stats.skippedBinaryFiles}` +
		`\nSkipped unreadable files: ${stats.skippedUnreadableFiles}`;

	return {
		text: `${header}${output}`,
		stats,
	};
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncateHeadText(text: string): {
	content: string;
	truncated: boolean;
	outputLines: number;
	totalLines: number;
	outputBytes: number;
	totalBytes: number;
} {
	const lines = text.split(/\r?\n/);
	const totalLines = lines.length;
	const totalBytes = Buffer.byteLength(text, "utf8");

	let outputLines = 0;
	let outputBytes = 0;
	const kept: string[] = [];

	for (const line of lines) {
		const candidate = kept.length === 0 ? line : `\n${line}`;
		const candidateBytes = Buffer.byteLength(candidate, "utf8");
		if (outputLines >= DEFAULT_MAX_LINES || outputBytes + candidateBytes > DEFAULT_MAX_BYTES) {
			break;
		}
		kept.push(line);
		outputLines += 1;
		outputBytes += candidateBytes;
	}

	const content = kept.join("\n");
	return {
		content,
		truncated: outputLines < totalLines || outputBytes < totalBytes,
		outputLines,
		totalLines,
		outputBytes,
		totalBytes,
	};
}

type TruncationWithNotice = {
	content: string;
	notice: string | null;
};

async function applyTruncationWithNotice(
	text: string,
	label: string,
	extension: string,
): Promise<TruncationWithNotice> {
	const truncation = truncateHeadText(text);

	let result = truncation.content;
	if (!truncation.truncated) {
		return {
			content: result,
			notice: null,
		};
	}

	const tempPath = path.join(os.tmpdir(), `pi-review-${Date.now()}${extension}`);
	await fs.writeFile(tempPath, text);
	const notice =
		`${label} truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
		`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
		`Full ${label.toLowerCase()} saved to: ${tempPath}`;

	result += `\n\n[${notice}]`;
	return {
		content: result,
		notice,
	};
}

export async function applyTruncation(text: string, label: string, extension: string): Promise<string> {
	const truncated = await applyTruncationWithNotice(text, label, extension);
	return truncated.content;
}

export function sanitizeFileComponent(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function buildReviewOutputPath(branch: string): string {
	const safeBranch = branch === "HEAD" ? "detached" : sanitizeFileComponent(branch);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(".pi", "reviews", `review-${stamp}-${safeBranch}.md`);
}

export type ReviewPresentationUnavailableReason =
	| "no-ui"
	| "no-gui"
	| "firefox-not-found"
	| "open-failed";

export type ReviewBrowserAvailability =
	| {
		available: true;
		firefoxCommand: string;
	}
	| {
		available: false;
		reason: Exclude<ReviewPresentationUnavailableReason, "open-failed">;
		message: string;
		triedCommands?: string[];
	};

export type PresentReviewResult =
	| {
		presented: true;
		markdownPath: string;
		htmlPath: string;
		firefoxCommand: string;
		message: string;
	}
	| {
		presented: false;
		reason: ReviewPresentationUnavailableReason;
		markdownPath: string;
		htmlPath?: string;
		message: string;
		triedCommands?: string[];
	};

export type ReviewBrowserOpener = (firefoxCommand: string, htmlPath: string) => Promise<void> | void;

export function hasGraphicalEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform === "linux") {
		return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
	}
	if (platform === "darwin" || platform === "win32") {
		return true;
	}
	return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export function getFirefoxCommandCandidates(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const candidates = [
		env.FIREFOX_BIN?.trim(),
		"firefox",
		"firefox-esr",
		platform === "win32" ? "firefox.exe" : undefined,
		platform === "darwin" ? "/Applications/Firefox.app/Contents/MacOS/firefox" : undefined,
	];
	return Array.from(new Set(candidates.filter((candidate): candidate is string => Boolean(candidate))));
}

export async function findFirefoxCommand(
	pi: ExtensionAPI,
	options: {
		env?: NodeJS.ProcessEnv;
		platform?: NodeJS.Platform;
	} = {},
): Promise<string | undefined> {
	for (const command of getFirefoxCommandCandidates(options.env, options.platform)) {
		try {
			const result = await pi.exec(command, ["--version"]);
			if (result.code === 0) {
				return command;
			}
		} catch {
			// Ignore missing commands and keep probing other Firefox variants.
		}
	}
	return undefined;
}

export async function detectReviewBrowserAvailability(
	pi: ExtensionAPI,
	options: {
		hasUI?: boolean;
		env?: NodeJS.ProcessEnv;
		platform?: NodeJS.Platform;
	} = {},
): Promise<ReviewBrowserAvailability> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;

	if (options.hasUI === false) {
		return {
			available: false,
			reason: "no-ui",
			message: "Review presentation skipped because this session has no interactive UI.",
		};
	}

	if (!hasGraphicalEnvironment(env, platform)) {
		return {
			available: false,
			reason: "no-gui",
			message: "Review presentation skipped because no graphical desktop environment was detected.",
		};
	}

	const firefoxCommand = await findFirefoxCommand(pi, { env, platform });
	if (!firefoxCommand) {
		return {
			available: false,
			reason: "firefox-not-found",
			message: "Review presentation skipped because Firefox was not found.",
			triedCommands: getFirefoxCommandCandidates(env, platform),
		};
	}

	return {
		available: true,
		firefoxCommand,
	};
}

export function buildReviewHtmlOutputPath(markdownPath: string): string {
	const parsed = path.parse(markdownPath);
	if (/^\.(md|markdown)$/i.test(parsed.ext)) {
		return path.join(parsed.dir, `${parsed.name}.html`);
	}
	return `${markdownPath}.html`;
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function isSafeReviewUrl(value: string, kind: "link" | "image"): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
		return true;
	}

	const compact = trimmed.replace(/[\u0000-\u001F\u007F\s]+/g, "");
	const scheme = compact.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)?.[1]?.toLowerCase();
	if (!scheme) return true;
	if (kind === "image") {
		if (scheme === "data") {
			return /^data:image\/(png|gif|jpe?g|webp);/i.test(compact);
		}
		return ["http", "https", "file"].includes(scheme);
	}
	return ["http", "https", "mailto", "file"].includes(scheme);
}

function inferReviewHtmlTitle(markdown: string, fallback: string): string {
	const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
	return heading || fallback;
}

export function renderReviewMarkdownToHtml(
	markdown: string,
	options: {
		title?: string;
	} = {},
): string {
	const renderer = new Renderer();
	renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text);
	renderer.link = function (this: Renderer, token: Tokens.Link) {
		const href = token.href ?? "";
		const label = this.parser.parseInline(token.tokens);
		if (!isSafeReviewUrl(href, "link")) {
			return label;
		}
		const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
		return `<a href="${escapeHtml(href)}"${title}>${label}</a>`;
	};
	renderer.image = function (this: Renderer, token: Tokens.Image) {
		const href = token.href ?? "";
		const alt = token.text ?? "";
		if (!isSafeReviewUrl(href, "image")) {
			return escapeHtml(alt);
		}
		const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
		return `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"${title}>`;
	};

	const marked = new Marked({
		gfm: true,
		breaks: false,
		renderer,
	});
	const body = marked.parse(markdown, { async: false }) as string;
	const title = inferReviewHtmlTitle(markdown, options.title || "Review");

	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: file: http: https:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">',
		`<title>${escapeHtml(title)}</title>`,
		"<style>",
		":root { color-scheme: light dark; --bg: #f6f8fa; --fg: #1f2328; --muted: #656d76; --border: #d0d7de; --code-bg: #f0f3f6; --panel: #ffffff; }",
		"@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --border: #30363d; --code-bg: #161b22; --panel: #010409; } }",
		"body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }",
		"main { box-sizing: border-box; max-width: 980px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; background: var(--panel); min-height: 100vh; }",
		"h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.6em; }",
		"h1 { margin-top: 0; padding-bottom: 0.35em; border-bottom: 1px solid var(--border); }",
		"a { color: #0969da; }",
		"pre, code { font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace; }",
		"code { background: var(--code-bg); border-radius: 0.25rem; padding: 0.12rem 0.28rem; }",
		"pre { overflow: auto; background: var(--code-bg); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; }",
		"pre code { background: transparent; padding: 0; border-radius: 0; }",
		"blockquote { margin-left: 0; padding-left: 1rem; color: var(--muted); border-left: 0.25rem solid var(--border); }",
		"img { max-width: 100%; }",
		"table { border-collapse: collapse; width: 100%; margin: 1rem 0; }",
		"th, td { border: 1px solid var(--border); padding: 0.45rem 0.6rem; vertical-align: top; }",
		"hr { border: 0; border-top: 1px solid var(--border); margin: 2rem 0; }",
		"</style>",
		"</head>",
		"<body>",
		"<main>",
		body,
		"</main>",
		"</body>",
		"</html>",
	].join("\n");
}

export function resolveReviewMarkdownPath(reviewPath: string, cwd: string = process.cwd()): string {
	const trimmed = reviewPath.trim();
	if (!trimmed) {
		throw new Error("Review Markdown path is required.");
	}
	return path.normalize(path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed));
}

export function openFirefoxReview(firefoxCommand: string, htmlPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(firefoxCommand, ["--new-window", pathToFileURL(htmlPath).href], {
			detached: true,
			stdio: "ignore",
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

export async function presentReviewMarkdown(
	pi: ExtensionAPI,
	options: {
		reviewPath: string;
		cwd?: string;
		hasUI?: boolean;
		env?: NodeJS.ProcessEnv;
		platform?: NodeJS.Platform;
		openBrowser?: ReviewBrowserOpener;
	},
): Promise<PresentReviewResult> {
	const markdownPath = resolveReviewMarkdownPath(options.reviewPath, options.cwd);
	const availability = await detectReviewBrowserAvailability(pi, {
		hasUI: options.hasUI,
		env: options.env,
		platform: options.platform,
	});

	if (!availability.available) {
		return {
			presented: false,
			reason: availability.reason,
			markdownPath,
			message: availability.message,
			triedCommands: availability.triedCommands,
		};
	}

	const markdown = await fs.readFile(markdownPath, "utf8");
	const htmlPath = buildReviewHtmlOutputPath(markdownPath);
	const html = renderReviewMarkdownToHtml(markdown, { title: path.basename(markdownPath) });
	await fs.mkdir(path.dirname(htmlPath), { recursive: true });
	await fs.writeFile(htmlPath, html, "utf8");

	try {
		await (options.openBrowser ?? openFirefoxReview)(availability.firefoxCommand, htmlPath);
	} catch (error) {
		return {
			presented: false,
			reason: "open-failed",
			markdownPath,
			htmlPath,
			message: `Review HTML was written, but Firefox could not be opened: ${formatErrorMessage(error)}`,
		};
	}

	return {
		presented: true,
		markdownPath,
		htmlPath,
		firefoxCommand: availability.firefoxCommand,
		message: `Opened review HTML in Firefox: ${htmlPath}`,
	};
}

function formatErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export async function checkGhAuth(pi: ExtensionAPI): Promise<boolean> {
	const result = await pi.exec("gh", ["auth", "status"]);
	return result.code === 0;
}

export async function listOpenPrs(pi: ExtensionAPI, limit = 30): Promise<PrInfo[]> {
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

export async function getPrDetails(pi: ExtensionAPI, prRef: string): Promise<PrInfo> {
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

export async function getPrDiff(pi: ExtensionAPI, prRef: string): Promise<string> {
	const result = await pi.exec("gh", ["pr", "diff", prRef, "--color", "never"]);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `Failed to get diff for PR '${prRef}'`);
	}
	return result.stdout;
}

export async function getPrCommitLog(pi: ExtensionAPI, prRef: string): Promise<string> {
	const result = await pi.exec("gh", ["pr", "view", prRef, "--json", "commits"]);
	if (result.code !== 0) return "";
	const data = JSON.parse(result.stdout) as {
		commits: Array<{ oid: string; messageHeadline: string; authors: Array<{ login: string }> }>;
	};
	if (!data.commits || data.commits.length === 0) return "";
	return data.commits.map((commit) => `${commit.oid.slice(0, 7)} ${commit.messageHeadline}`).join("\n");
}

function wantsCommitLog(activeReviews: ReviewType[]): boolean {
	return activeReviews.some((review) => review.id === `${REVIEW_PREFIX}commit-discipline`);
}

function resolveSelectedReviews(reviewTypes: ReviewType[], reviewIds?: string[]): ReviewType[] {
	if (!reviewIds || reviewIds.length === 0) {
		return reviewTypes;
	}

	const byId = new Map(reviewTypes.map((review) => [review.id, review]));
	const selected: ReviewType[] = [];
	for (const reviewId of reviewIds.map((value) => value.trim()).filter(Boolean)) {
		const review = byId.get(reviewId);
		if (!review) {
			throw new Error(
				`Unknown review type '${reviewId}'. Available: ${reviewTypes.map((item) => item.id).join(", ")}`,
			);
		}
		selected.push(review);
	}

	return selected;
}

export async function prepareReviewRequest(
	pi: ExtensionAPI,
	options: PrepareReviewRequestOptions,
): Promise<PreparedReviewRequest> {
	const reviewTypes = await loadReviewTypes(pi);
	if (reviewTypes.length === 0) {
		throw new Error(`No review templates found (${REVIEW_PREFIX}*.md).`);
	}

	const activeReviews = resolveSelectedReviews(reviewTypes, options.reviewIds);
	if (activeReviews.length === 0) {
		throw new Error("No review types selected.");
	}

	const branch = await getCurrentBranch(pi);
	let reviewInputText = "";
	let reviewInputLabel = "";
	let reviewInputTitle = "Diff";
	let reviewInputFence = "diff";
	let commitLog = "";
	let prContext = "";
	let repositorySnapshotStats: RepositorySnapshot["stats"] | null = null;

	switch (options.scope.kind) {
		case "working-tree": {
			reviewInputText = await getWorkingDiff(pi);
			reviewInputLabel = "working tree";
			break;
		}
		case "branch": {
			const baseInput = options.scope.base.trim();
			const explicitHead = options.scope.head?.trim();
			if (!baseInput) {
				throw new Error("Branch review requires a base ref.");
			}

			let base = baseInput;
			let head = explicitHead || branch;
			let operator: ".." | "..." = "...";
			let revisionExpression: string | null = null;

			if (!explicitHead) {
				const parsedRange = parseRefRange(baseInput);
				if (parsedRange) {
					base = parsedRange.base;
					head = parsedRange.head;
					operator = parsedRange.operator;
				} else if (!(await ensureGitRefExists(pi, baseInput))) {
					if (await ensureGitRevisionExpressionExists(pi, baseInput)) {
						revisionExpression = baseInput;
					} else {
						throw new Error(
							`Base ref '${baseInput}' not found. Use any existing branch, tag, or commit SHA.`,
						);
					}
				}
			}

			if (revisionExpression) {
				reviewInputText = await getRevisionExpressionDiff(pi, revisionExpression);
				reviewInputLabel = revisionExpression;
				if (wantsCommitLog(activeReviews)) {
					commitLog = await getRevisionExpressionCommitLog(pi, revisionExpression);
				}
				break;
			}

			if (!(await ensureGitRefExists(pi, base))) {
				throw new Error(
					`Base ref '${base}' not found. Use any existing branch, tag, or commit SHA.`,
				);
			}
			reviewInputText = await getBranchDiff(pi, base, head, operator);
			reviewInputLabel = `${base}${operator}${head}`;
			if (wantsCommitLog(activeReviews)) {
				commitLog = await getCommitLog(pi, base, head);
			}
			break;
		}
		case "repository": {
			const snapshot = await getRepositorySnapshot(pi);
			reviewInputText = snapshot.text;
			repositorySnapshotStats = snapshot.stats;
			reviewInputLabel = "repository snapshot";
			reviewInputTitle = "Codebase";
			reviewInputFence = "text";
			break;
		}
		case "pull-request": {
			const prRef = options.scope.prRef.trim();
			if (!prRef) {
				throw new Error("Pull-request review requires a PR ref.");
			}
			if (!(await checkGhAuth(pi))) {
				throw new Error("GitHub CLI is not authenticated. Run 'gh auth login' first.");
			}
			const prInfo = await getPrDetails(pi, prRef);
			reviewInputText = await getPrDiff(pi, prRef);
			reviewInputLabel = `PR #${prInfo.number} (${prInfo.headRefName} → ${prInfo.baseRefName})`;
			if (wantsCommitLog(activeReviews)) {
				commitLog = await getPrCommitLog(pi, prRef);
			}
			const prBody = prInfo.body?.trim() ? `\n\nPR description:\n${prInfo.body.trim()}` : "";
			prContext =
				`\n\nPull Request: #${prInfo.number} — ${prInfo.title}` +
				`\nAuthor: ${prInfo.author}` +
				`\nBranches: ${prInfo.headRefName} → ${prInfo.baseRefName}` +
				`\nURL: ${prInfo.url}` +
				`\nState: ${prInfo.state}` +
				prBody;
			break;
		}
	}

	if (!reviewInputText.trim()) {
		throw new Error("No review input detected for the selected scope.");
	}

	const outputPath = options.outputPath?.trim() || buildReviewOutputPath(branch);
	const reviewBlocks = activeReviews.map((review) => `### ${review.label}\n${review.prompt}`).join("\n\n");
	const reviewInputTruncation = await applyTruncationWithNotice(
		reviewInputText,
		reviewInputTitle,
		reviewInputFence === "diff" ? ".diff" : ".txt",
	);
	const reviewInputBody = reviewInputTruncation.content;
	const isRepositoryScope = options.scope.kind === "repository";
	const scopeHeading = isRepositoryScope
		? "Please review the complete codebase."
		: "Please review the following changes.";
	const scopeContract = isRepositoryScope
		? "\n\nScope contract:" +
			"\n- This is a complete-codebase review. Do not limit the review to recent commits, branch diffs, or the last commit." +
			"\n- Review the full repository snapshot (tracked + untracked files, excluding .gitignored files)."
		: "";
	const repositoryInventory = isRepositoryScope && repositorySnapshotStats
		? "\n\nRepository inventory:" +
			`\n- Files scanned: ${repositorySnapshotStats.scannedFiles}` +
			`\n- Ignored by .gitignore: ${repositorySnapshotStats.ignoredFiles}` +
			`\n- Skipped binary files: ${repositorySnapshotStats.skippedBinaryFiles}` +
			`\n- Skipped unreadable files: ${repositorySnapshotStats.skippedUnreadableFiles}`
		: "";
	const repositoryTruncationNote = isRepositoryScope && reviewInputTruncation.notice
		? `\n\nImportant: ${reviewInputTruncation.notice}. ` +
			"Continue by inspecting the full snapshot file before finalizing the review."
		: "";
	const commitSection = commitLog
		? `\n\nCommit log (${reviewInputLabel.replace("...", "..")}):\n\n${commitLog}`
		: "";
	const presentationToolName = options.presentationToolName?.trim();
	const outputInstruction = outputPath
		? `\n\nWrite the full review as Markdown to \`${outputPath}\` (use the write tool). ` +
			(presentationToolName
				? `After writing the Markdown file, call \`${presentationToolName}\` with \`${outputPath}\` to present it in Firefox when available. If presentation is unavailable, continue normally. Then respond here with a brief summary and the file path.`
				: "Then respond here with a brief summary and the file path.")
		: "";

	const prompt =
		scopeHeading +
		"\n\n" +
		reviewBlocks +
		"\n\n" +
		REVIEW_CALIBRATION +
		scopeContract +
		repositoryInventory +
		repositoryTruncationNote +
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

	return {
		branch,
		activeReviews,
		reviewInputLabel,
		reviewInputTitle,
		reviewInputFence,
		reviewInputText,
		commitLog,
		prContext,
		outputPath,
		prompt,
	};
}

export const __test = {
	DEFAULT_REVIEW_PROMPTS_DIR,
	stripFrontmatter,
	restoreSelection,
	sanitizeFileComponent,
	buildReviewOutputPath,
	buildReviewHtmlOutputPath,
	hasGraphicalEnvironment,
	getFirefoxCommandCandidates,
	findFirefoxCommand,
	detectReviewBrowserAvailability,
	escapeHtml,
	renderReviewMarkdownToHtml,
	resolveReviewMarkdownPath,
	presentReviewMarkdown,
	resolveSelectedReviews,
	wantsCommitLog,
	parseRefRange,
};
