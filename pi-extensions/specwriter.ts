import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STATUS_KEY = "specwriter";
const DEFAULT_SPEC_DIR = path.join(os.homedir(), "data", "specs");
const LARGE_SPEC_WORD_THRESHOLD = 260;
const TITLE_TABLE_SCAN_LINES = 20;
const MARKDOWN_EXTENSION_RE = /\.(md|markdown)$/i;
const PROMPT_TEMPLATE_PATH = path.join("pi-prompts", "specwriter.md");

const REQUIRED_H1_SECTIONS = ["Abstract", "Rationale", "Specification"] as const;
const OPTIONAL_H1_SECTIONS = ["Further Information"] as const;
const ALLOWED_H1_SECTIONS = [...REQUIRED_H1_SECTIONS, ...OPTIONAL_H1_SECTIONS] as const;

const GUIDING_QUESTIONS = [
	"Do I understand what needs to be done for the task?",
	"Do I understand what is described in the spec?",
	"Does the spec solve the task it is written for?",
	"Is there an alternative solution that may be easier to implement?",
	"Is the spec self-contradictory?",
	"Is the spec self-consistent?",
	"Is it clear what kind of tests need to be written?",
	"Is it clear what kind of testing is required?",
	"Is it clear what the implementation plan is and what are the deliverables of each phase of the implementation plan?",
	"Do phases and milestones have clear outcomes defined?",
] as const;

type ParsedArgs = {
	specPath?: string;
	help: boolean;
};

type Heading = {
	line: number;
	level: number;
	title: string;
	normalized: string;
};

type WrongLevelSection = {
	section: string;
	line: number;
	level: number;
};

type TitleSuggestionSource = "frontmatter" | "table" | "synthesized";

type ParsedYamlFrontmatter = {
	body: string;
};

type SpecDraftAnalysis = {
	requiredMissing: string[];
	requiredWrongLevel: WrongLevelSection[];
	duplicateH1Sections: string[];
	unexpectedH1: string[];
	hasYamlFrontmatter: boolean;
	hasFrontmatterTitle: boolean;
	frontmatterTitle?: string;
	tableTitleCandidate?: string;
	suggestedTitle: string;
	suggestedTitleSource: TitleSuggestionSource;
	hasFurtherInformation: boolean;
	hasSpecificationSection: boolean;
	phaseCount: number;
	milestoneCount: number;
	milestonesWithoutPhase: number;
	phasesWithoutMilestones: number;
	unnumberedPhaseHeadings: number;
	unnumberedMilestoneHeadings: number;
	specWordCount: number;
	shouldRecommendPhases: boolean;
	hasImplementationSignal: boolean;
	hasTestingSignal: boolean;
	hasDocumentationSignal: boolean;
	openQuestionCount: number;
};

export default function specwriterExtension(pi: ExtensionAPI) {
	pi.registerCommand("specwriter", {
		description: "Review and improve a markdown spec draft",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trim();
			const option = "--help";

			if (trimmed.startsWith("-")) {
				return option.startsWith(trimmed) ? [{ value: option, label: option }] : null;
			}

			const specDir = resolveSpecDirectory(process.cwd());
			const files = listMarkdownFiles(specDir).map((file) => ({
				value: file,
				label: `${file} (${specDir})`,
			}));

			const matches = files.filter((item) => item.value.startsWith(trimmed));
			return matches.length > 0 ? matches.slice(0, 50) : null;
		},
		handler: async (rawArgs, ctx) => {
			let parsed: ParsedArgs;
			try {
				parsed = parseArgs(rawArgs);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
				ctx.ui.notify("Run /specwriter --help for usage.", "warning");
				return;
			}

			const specDir = resolveSpecDirectory(ctx.cwd);
			if (parsed.help) {
				publishInfo(pi, usageText(specDir), { usage: true, specDir });
				return;
			}

			if (!parsed.specPath) {
				ctx.ui.notify("Usage: /specwriter <spec-filename-or-path>", "warning");
				return;
			}

			let specPath: string;
			try {
				specPath = resolveSpecPath(parsed.specPath, ctx.cwd, specDir);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
				return;
			}

			const displayPath = toDisplayPath(specPath, ctx.cwd);
			ctx.ui.setStatus(STATUS_KEY, `Preparing ${displayPath}...`);

			try {
				const draft = await fsPromises.readFile(specPath, "utf8");
				const analysis = analyzeSpec(draft, specPath);
				const promptTemplate = await loadPromptTemplate(ctx.cwd);
				const prompt = buildSpecwriterPrompt(specPath, analysis, promptTemplate);

				if (ctx.isIdle()) {
					pi.sendUserMessage(prompt);
				} else {
					pi.sendUserMessage(prompt, { deliverAs: "followUp" });
					ctx.ui.notify("Queued /specwriter follow-up request.", "info");
				}
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});
}

function usageText(specDir: string): string {
	return [
		"Usage:",
		"  /specwriter <spec-filename-or-path>",
		"",
		"Behavior:",
		"  - Reads a markdown spec draft and prepares a guided rewrite request.",
		"  - Improves the spec in place via the agent.",
		"  - Adds .md automatically when no extension is given.",
		`  - Plain filenames resolve from ${specDir} first, then the current directory.`,
		"",
		"Environment:",
		`  SPECWRITER_DIR overrides the default spec directory (default: ${DEFAULT_SPEC_DIR})`,
	].join("\n");
}

function parseArgs(rawArgs: string): ParsedArgs {
	const tokens = splitShellArgs(rawArgs);
	const out: ParsedArgs = {
		specPath: undefined,
		help: false,
	};

	for (const token of tokens) {
		switch (token) {
			case "--help":
			case "-h":
				out.help = true;
				break;
			default:
				if (token.startsWith("--")) {
					throw new Error(`unknown option: ${token}`);
				}
				if (out.specPath) {
					throw new Error("only one spec filename/path is supported");
				}
				out.specPath = token;
		}
	}

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
	const configured = process.env.SPECWRITER_DIR?.trim();
	if (!configured) return DEFAULT_SPEC_DIR;
	return toAbsolutePath(configured, cwd);
}

function listMarkdownFiles(dir: string): string[] {
	try {
		if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && MARKDOWN_EXTENSION_RE.test(entry.name))
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

function resolveSpecPath(inputPath: string, cwd: string, specDir: string): string {
	const normalizedInput = normalizeRequestedSpecPath(inputPath);
	const looksLikePath = isPathLike(normalizedInput);
	const candidates: string[] = [];

	if (looksLikePath) {
		candidates.push(toAbsolutePath(normalizedInput, cwd));
	} else {
		candidates.push(path.join(specDir, normalizedInput));
		candidates.push(path.join(cwd, normalizedInput));
	}

	for (const candidate of dedupe(candidates)) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			if (!MARKDOWN_EXTENSION_RE.test(candidate)) {
				throw new Error(`Spec file must be markdown (.md/.markdown): ${candidate}`);
			}
			return path.normalize(candidate);
		}
	}

	throw new Error(`Spec file not found: ${normalizedInput}`);
}

function normalizeRequestedSpecPath(inputPath: string): string {
	const trimmed = inputPath.trim();
	if (!trimmed) {
		throw new Error("spec filename/path is required");
	}

	const ext = path.extname(trimmed);
	if (!ext) return `${trimmed}.md`;
	if (!MARKDOWN_EXTENSION_RE.test(trimmed)) {
		throw new Error("specwriter only supports markdown files (.md or .markdown)");
	}
	return trimmed;
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

function toDisplayPath(target: string, cwd: string): string {
	const relative = path.relative(cwd, target);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
		return relative;
	}
	return target;
}

function analyzeSpec(markdown: string, specPath?: string): SpecDraftAnalysis {
	const headings = parseHeadings(markdown);
	const headingMap = new Map<string, Heading[]>();
	for (const heading of headings) {
		const list = headingMap.get(heading.normalized) ?? [];
		list.push(heading);
		headingMap.set(heading.normalized, list);
	}

	const frontmatter = parseYamlFrontmatter(markdown);
	const frontmatterTitle = frontmatter ? parseFrontmatterTitle(frontmatter.body) : undefined;
	const tableTitleCandidate = extractTitleFromTopTable(markdown, TITLE_TABLE_SCAN_LINES);
	const suggestedTitle = chooseSuggestedTitle(markdown, specPath, headings, frontmatterTitle, tableTitleCandidate);
	const suggestedTitleSource: TitleSuggestionSource = frontmatterTitle
		? "frontmatter"
		: tableTitleCandidate
			? "table"
			: "synthesized";

	const requiredMissing: string[] = [];
	const requiredWrongLevel: WrongLevelSection[] = [];
	const duplicateH1Sections: string[] = [];

	for (const section of REQUIRED_H1_SECTIONS) {
		const normalized = normalizeHeadingTitle(section);
		const matches = headingMap.get(normalized) ?? [];
		const h1Matches = matches.filter((heading) => heading.level === 1);

		if (h1Matches.length === 0) {
			if (matches.length > 0) {
				requiredWrongLevel.push({
					section,
					line: matches[0].line,
					level: matches[0].level,
				});
			} else {
				requiredMissing.push(section);
			}
		}

		if (h1Matches.length > 1) {
			duplicateH1Sections.push(section);
		}
	}

	const optionalNormalized = normalizeHeadingTitle(OPTIONAL_H1_SECTIONS[0]);
	const optionalMatches = headingMap.get(optionalNormalized) ?? [];
	const optionalH1Matches = optionalMatches.filter((heading) => heading.level === 1);
	const hasFurtherInformation = optionalH1Matches.length > 0;
	if (optionalH1Matches.length > 1) {
		duplicateH1Sections.push(OPTIONAL_H1_SECTIONS[0]);
	}

	const allowedH1 = new Set(ALLOWED_H1_SECTIONS.map((section) => normalizeHeadingTitle(section)));
	const unexpectedH1 = unique(
		headings
			.filter((heading) => heading.level === 1 && !allowedH1.has(heading.normalized))
			.map((heading) => heading.title),
	);

	const lines = markdown.split(/\r?\n/);
	const specificationRange = getSectionRange(headings, normalizeHeadingTitle("Specification"), lines.length);
	const hasSpecificationSection = specificationRange !== undefined;

	const specificationHeadings = specificationRange
		? headings.filter(
				(heading) =>
					heading.line > specificationRange.startLine && heading.line < specificationRange.endExclusiveLine,
			)
		: [];

	const specificationBody = specificationRange
		? lines.slice(specificationRange.startLine, specificationRange.endExclusiveLine - 1).join("\n")
		: "";
	const specificationBodyLower = specificationBody.toLowerCase();

	let phaseCount = 0;
	let milestoneCount = 0;
	let milestonesWithoutPhase = 0;
	let unnumberedPhaseHeadings = 0;
	let unnumberedMilestoneHeadings = 0;

	const milestonesPerPhase: number[] = [];
	let currentPhaseIndex = -1;

	for (const heading of specificationHeadings) {
		if (heading.level === 2) {
			if (isPhaseHeading(heading.title)) {
				phaseCount += 1;
				milestonesPerPhase.push(0);
				currentPhaseIndex = milestonesPerPhase.length - 1;
				continue;
			}
			if (isAnyPhaseHeading(heading.title)) {
				unnumberedPhaseHeadings += 1;
			}
			currentPhaseIndex = -1;
			continue;
		}

		if (heading.level === 3) {
			if (isMilestoneHeading(heading.title)) {
				milestoneCount += 1;
				if (currentPhaseIndex < 0) {
					milestonesWithoutPhase += 1;
				} else {
					milestonesPerPhase[currentPhaseIndex] += 1;
				}
				continue;
			}
			if (isAnyMilestoneHeading(heading.title)) {
				unnumberedMilestoneHeadings += 1;
			}
		}
	}

	const phasesWithoutMilestones = milestonesPerPhase.filter((count) => count === 0).length;
	const specWordCount = countWords(specificationBody);
	const shouldRecommendPhases = hasSpecificationSection && phaseCount === 0 && specWordCount >= LARGE_SPEC_WORD_THRESHOLD;

	return {
		requiredMissing,
		requiredWrongLevel,
		duplicateH1Sections: unique(duplicateH1Sections),
		unexpectedH1,
		hasYamlFrontmatter: frontmatter !== undefined,
		hasFrontmatterTitle: Boolean(frontmatterTitle),
		frontmatterTitle,
		tableTitleCandidate,
		suggestedTitle,
		suggestedTitleSource,
		hasFurtherInformation,
		hasSpecificationSection,
		phaseCount,
		milestoneCount,
		milestonesWithoutPhase,
		phasesWithoutMilestones,
		unnumberedPhaseHeadings,
		unnumberedMilestoneHeadings,
		specWordCount,
		shouldRecommendPhases,
		hasImplementationSignal: /\b(implement|implementation|build|develop|delivery|deliverable|architecture|rollout)\b/.test(
			specificationBodyLower,
		),
		hasTestingSignal: /\b(test|tests|testing|qa|verification|validate|validation|ci)\b/.test(specificationBodyLower),
		hasDocumentationSignal: /\b(doc|docs|documentation|readme|runbook|guide|guides)\b/.test(
			specificationBodyLower,
		),
		openQuestionCount: (markdown.match(/\bxxx\b/gi) ?? []).length,
	};
}

function parseYamlFrontmatter(markdown: string): ParsedYamlFrontmatter | undefined {
	const lines = markdown.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return undefined;
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end === -1) return undefined;
	return { body: lines.slice(1, end).join("\n") };
}

function parseFrontmatterTitle(frontmatterBody: string): string | undefined {
	const lines = frontmatterBody.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^title\s*:\s*(.+?)\s*$/i.exec(line);
		if (!match) continue;
		const rawValue = match[1].trim();
		if (!rawValue || rawValue === "|" || rawValue === ">") return undefined;
		const cleaned = sanitizeTitleCandidate(rawValue);
		return cleaned || undefined;
	}
	return undefined;
}

function extractTitleFromTopTable(markdown: string, maxLines: number): string | undefined {
	const lines = markdown.split(/\r?\n/).slice(0, maxLines);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line.startsWith("|")) continue;
		const cells = parseMarkdownTableRow(line);
		if (cells.length < 2) continue;
		if (normalizeHeadingTitle(cells[0]) !== "title") continue;

		for (let i = 1; i < cells.length; i++) {
			const candidateCell = cells[i].trim();
			if (!candidateCell || isMarkdownTableDividerCell(candidateCell)) continue;
			const candidate = sanitizeTitleCandidate(candidateCell);
			if (candidate) return candidate;
		}
	}
	return undefined;
}

function parseMarkdownTableRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return trimmed.split("|").map((cell) => cell.trim());
}

function isMarkdownTableDividerCell(value: string): boolean {
	const normalized = value.replace(/\s+/g, "");
	return /^:?-{3,}:?$/.test(normalized);
}

function chooseSuggestedTitle(
	markdown: string,
	specPath: string | undefined,
	headings: Heading[],
	frontmatterTitle: string | undefined,
	tableTitleCandidate: string | undefined,
): string {
	if (frontmatterTitle) return frontmatterTitle;
	if (tableTitleCandidate) return tableTitleCandidate;
	return synthesizeSpecTitle(markdown, specPath, headings);
}

function synthesizeSpecTitle(markdown: string, specPath: string | undefined, headings: Heading[]): string {
	const structuralHeadings = new Set(ALLOWED_H1_SECTIONS.map((section) => normalizeHeadingTitle(section)));
	const nonStructuralH1 = headings.find(
		(heading) => heading.level === 1 && !structuralHeadings.has(heading.normalized),
	);
	if (nonStructuralH1) {
		const cleaned = sanitizeTitleCandidate(nonStructuralH1.title);
		if (cleaned) return cleaned;
	}

	const titleLikeLine = findFirstTitleLikeLine(stripFrontmatter(markdown));
	if (titleLikeLine) return titleLikeLine;

	const pathTitle = synthesizeTitleFromPath(specPath);
	if (pathTitle) return pathTitle;

	return "Untitled Spec";
}

function findFirstTitleLikeLine(markdown: string): string | undefined {
	const lines = markdown.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line === "---" || line === "...") continue;
		if (line.startsWith("#")) continue;
		if (line.startsWith("|")) continue;
		if (/^[-*+]\s+/.test(line)) continue;
		if (/^\d+[.)]\s+/.test(line)) continue;
		if (/^```/.test(line)) continue;

		const cleaned = sanitizeTitleCandidate(line.replace(/[.!?:;]+$/, "").trim());
		if (!cleaned) continue;
		return truncateTitle(cleaned);
	}
	return undefined;
}

function synthesizeTitleFromPath(specPath?: string): string | undefined {
	if (!specPath) return undefined;
	const stem = path.basename(specPath, path.extname(specPath)).trim();
	if (!stem) return undefined;

	const words = stem
		.split(/[\s._-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1));
	if (words.length === 0) return undefined;
	return sanitizeTitleCandidate(words.join(" "));
}

function sanitizeTitleCandidate(value: string): string {
	let out = value.trim();
	if (!out) return "";

	out = stripWrappingQuotes(out);
	out = out.replace(/\[(.+?)\]\((.+?)\)/g, "$1");
	out = out.replace(/[`*_]/g, "");
	out = out.replace(/\s+/g, " ").trim();
	return out;
}

function stripWrappingQuotes(value: string): string {
	if (value.length < 2) return value;
	const startsWithDouble = value.startsWith('"') && value.endsWith('"');
	const startsWithSingle = value.startsWith("'") && value.endsWith("'");
	if (!startsWithDouble && !startsWithSingle) return value;
	return value.slice(1, -1).trim();
}

function truncateTitle(value: string, maxLength = 80): string {
	if (value.length <= maxLength) return value;
	const truncated = value.slice(0, maxLength).trimEnd();
	const lastSpace = truncated.lastIndexOf(" ");
	if (lastSpace > 20) {
		return truncated.slice(0, lastSpace).replace(/[\s:;,.!?-]+$/, "").trim();
	}
	return truncated.replace(/[\s:;,.!?-]+$/, "").trim();
}

function parseHeadings(markdown: string): Heading[] {
	const out: Heading[] = [];
	const lines = markdown.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (!match) continue;

		const title = match[2].trim();
		if (!title) continue;

		out.push({
			line: i + 1,
			level: match[1].length,
			title,
			normalized: normalizeHeadingTitle(title),
		});
	}

	return out;
}

function normalizeHeadingTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[`*_]/g, "")
		.replace(/[:：]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function getSectionRange(
	headings: Heading[],
	normalizedSectionTitle: string,
	totalLines: number,
): { startLine: number; endExclusiveLine: number } | undefined {
	const section = headings.find(
		(heading) => heading.level === 1 && heading.normalized === normalizedSectionTitle,
	);
	if (!section) return undefined;

	const nextH1 = headings.find((heading) => heading.level === 1 && heading.line > section.line);
	return {
		startLine: section.line,
		endExclusiveLine: nextH1 ? nextH1.line : totalLines + 1,
	};
}

function isPhaseHeading(title: string): boolean {
	return /^phase\s+(?:\d+|[ivxlcdm]+)(?:[.:)\-–—\s]|$)/i.test(title.trim());
}

function isAnyPhaseHeading(title: string): boolean {
	return /^phase\b/i.test(title.trim());
}

function isMilestoneHeading(title: string): boolean {
	return /^milestone\s+(?:\d+(?:\.\d+)*|[ivxlcdm]+)(?:[.:)\-–—\s]|$)/i.test(title.trim());
}

function isAnyMilestoneHeading(title: string): boolean {
	return /^milestone\b/i.test(title.trim());
}

function countWords(text: string): number {
	const matches = text.match(/\S+/g);
	return matches ? matches.length : 0;
}

function formatYamlTitleValue(value: string): string {
	return JSON.stringify(value);
}

function describeTitleSuggestionSource(source: TitleSuggestionSource): string {
	switch (source) {
		case "frontmatter":
			return "using the existing frontmatter title";
		case "table":
			return `derived from a \`| Title | ...\` row in the first ${TITLE_TABLE_SCAN_LINES} lines`;
		default:
			return "synthesized from the draft content/path";
	}
}

function buildPreflightNotes(analysis: SpecDraftAnalysis): string[] {
	const notes: string[] = [];

	if (!analysis.hasYamlFrontmatter) {
		notes.push(
			`No YAML frontmatter detected at the top of the file. Add frontmatter with \`title: ${formatYamlTitleValue(analysis.suggestedTitle)}\` (${describeTitleSuggestionSource(analysis.suggestedTitleSource)}).`,
		);
	} else if (!analysis.hasFrontmatterTitle) {
		notes.push(
			`YAML frontmatter exists but is missing \`title:\`. Add \`title: ${formatYamlTitleValue(analysis.suggestedTitle)}\` (${describeTitleSuggestionSource(analysis.suggestedTitleSource)}).`,
		);
	}

	if (analysis.requiredMissing.length > 0) {
		notes.push(`Missing required H1 sections: ${analysis.requiredMissing.join(", ")}.`);
	}

	if (analysis.requiredWrongLevel.length > 0) {
		const details = analysis.requiredWrongLevel
			.map((entry) => `${entry.section} is H${entry.level} on line ${entry.line}`)
			.join("; ");
		notes.push(`Required sections must be H1. Found: ${details}.`);
	}

	if (analysis.duplicateH1Sections.length > 0) {
		notes.push(`Duplicate H1 sections detected: ${analysis.duplicateH1Sections.join(", ")}.`);
	}

	if (analysis.unexpectedH1.length > 0) {
		notes.push(`Unexpected H1 headings detected: ${analysis.unexpectedH1.join(", ")}.`);
	}

	if (!analysis.hasSpecificationSection) {
		notes.push("No `# Specification` section detected.");
	} else {
		notes.push(
			`Specification body length: ~${analysis.specWordCount} words, ${analysis.phaseCount} numbered phase(s), ${analysis.milestoneCount} numbered milestone(s).`,
		);
	}

	if (analysis.unnumberedPhaseHeadings > 0) {
		notes.push(`Found ${analysis.unnumberedPhaseHeadings} unnumbered phase heading(s).`);
	}

	if (analysis.unnumberedMilestoneHeadings > 0) {
		notes.push(`Found ${analysis.unnumberedMilestoneHeadings} unnumbered milestone heading(s).`);
	}

	if (analysis.milestonesWithoutPhase > 0) {
		notes.push(`Found ${analysis.milestonesWithoutPhase} milestone heading(s) without a numbered parent phase.`);
	}

	if (analysis.phasesWithoutMilestones > 0) {
		notes.push(`Found ${analysis.phasesWithoutMilestones} phase(s) without numbered milestones.`);
	}

	if (analysis.shouldRecommendPhases) {
		notes.push(
			"Specification is large and has no numbered phases. Consider splitting into phases + milestones.",
		);
	}

	if (!analysis.hasImplementationSignal) {
		notes.push("Specification may be missing explicit implementation planning details.");
	}

	if (!analysis.hasTestingSignal) {
		notes.push("Specification may be missing explicit testing strategy details.");
	}

	if (!analysis.hasDocumentationSignal) {
		notes.push("Specification may be missing explicit documentation plan details.");
	}

	if (analysis.openQuestionCount === 0) {
		notes.push("No existing `xxx` open-question markers detected.");
	}

	if (!analysis.hasFurtherInformation) {
		notes.push("Optional `# Further Information` section is not present.");
	}

	return notes;
}

async function loadPromptTemplate(cwd: string): Promise<string | undefined> {
	const templatePath = path.join(cwd, PROMPT_TEMPLATE_PATH);
	try {
		const raw = await fsPromises.readFile(templatePath, "utf8");
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

function buildSpecwriterPrompt(
	specPath: string,
	analysis: SpecDraftAnalysis,
	template?: string,
): string {
	const notes = buildPreflightNotes(analysis);
	const notesBlock =
		notes.length > 0
			? notes.map((note) => `- ${note}`).join("\n")
			: "- No structural issues detected by preflight checks.";
	const guidingQuestionsBlock = GUIDING_QUESTIONS.map((question) => `- ${question}`).join("\n");

	if (template?.trim()) {
		return renderTemplate(template, {
			SPEC_PATH: specPath,
			GUIDING_QUESTIONS: guidingQuestionsBlock,
			PREFLIGHT_NOTES: notesBlock,
		}).trim();
	}

	return [
		`Please act as SpecWriter and improve the markdown spec draft at \`${specPath}\`.`,
		"",
		"Workflow:",
		`1. Read \`${specPath}\`.`,
		"2. Improve it in place via edit/write tools.",
		"3. Keep the result in Markdown.",
		"",
		"Required document structure:",
		"- Start the file with YAML frontmatter and include a `title:` field.",
		"- If a `| Title | ...` table row exists within the first 20 lines, use it as the title candidate.",
		"- Otherwise synthesize a concise, descriptive title.",
		"- Use H1 headings for the primary sections:",
		"  - `# Abstract` (overview)",
		"  - `# Rationale` (problem statement and why this spec exists)",
		"  - `# Specification` (implementation, testing, and documentation plans)",
		"- Optional H1 section: `# Further Information`.",
		"- For larger specs, split `# Specification` into numbered phases and milestones:",
		"  - `## Phase 1: ...`",
		"  - `### Milestone 1.1: ...`",
		"- Ensure every phase and milestone has clear outcomes/deliverables.",
		"",
		"Guiding questions:",
		guidingQuestionsBlock,
		"",
		"Iteration rule:",
		"- If later phases or milestones are underspecified, add explicit open questions marked with `xxx`.",
		"- Use a clear format such as `- xxx: clarify ...`.",
		"",
		"Preflight observations from the extension:",
		notesBlock,
		"",
		"After editing, reply with:",
		"- A short summary of what you changed",
		"- Remaining `xxx` questions that still require decisions",
	].join("\n");
}

function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

function unique(values: string[]): string[] {
	return dedupe(values);
}

function publishInfo(pi: ExtensionAPI, content: string, details: Record<string, unknown>): void {
	pi.sendMessage({
		customType: "specwriter",
		content,
		details,
		display: true,
	});
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export const __test = {
	parseArgs,
	splitShellArgs,
	resolveSpecPath,
	normalizeRequestedSpecPath,
	resolveSpecDirectory,
	loadPromptTemplate,
	stripFrontmatter,
	renderTemplate,
	analyzeSpec,
	buildPreflightNotes,
	buildSpecwriterPrompt,
	normalizeHeadingTitle,
	isPhaseHeading,
	isMilestoneHeading,
};
