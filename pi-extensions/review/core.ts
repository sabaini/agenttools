import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEW_PREFIX = "review-";
export const MAIN_BRANCH = "main";
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_REVIEW_PROMPTS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../pi-prompts",
);

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

async function loadReviewTypesFromCommands(pi: ExtensionAPI): Promise<ReviewType[]> {
	const commands = pi.getCommands();
	const templates = commands.filter(
		(command) =>
			command.source === "prompt" &&
			command.name.startsWith(REVIEW_PREFIX) &&
			Boolean(command.path),
	);

	const reviews: ReviewType[] = [];
	for (const template of templates) {
		const prompt = await loadPromptBody(template.path!);
		reviews.push({
			id: template.name,
			label: toReviewLabel(template.name),
			prompt,
			path: template.path,
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
	const outputInstruction = outputPath
		? `\n\nWrite the full review as Markdown to \`${outputPath}\` (use the write tool). ` +
			"Then respond here with a brief summary and the file path."
		: "";

	const prompt =
		scopeHeading +
		"\n\n" +
		reviewBlocks +
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
	resolveSelectedReviews,
	wantsCommitLog,
	parseRefRange,
};
