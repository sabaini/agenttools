import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

const DEFAULT_SPECS_DIR = path.join(homedir(), "data", "specs");

const ACTIONS = ["create", "update", "review", "list"] as const;
type Action = (typeof ACTIONS)[number];
type Mode = "create" | "update";

type RequiredSectionKey =
	| "abstract"
	| "rationale"
	| "implementationOverview"
	| "milestones"
	| "dataModel"
	| "proposedTests"
	| "documentationImpact";

interface SpecDraft {
	title: string;
	abstract: string;
	rationale: string;
	implementationOverview: string;
	milestones: string;
	dataModel: string;
	proposedTests: string;
	documentationImpact: string;
	alternatives?: string;
	references?: string;
}

interface RequiredSectionConfig {
	key: RequiredSectionKey;
	title: string;
	guidance: string;
	defaultQuestion: string;
	template?: string;
	minLength: number;
}

interface SectionBlock {
	content: string;
	start: number;
	end: number;
}

interface ReviewItem {
	question: string;
	status: "yes" | "needs-work" | "manual-check";
	note: string;
}

const REQUIRED_SECTIONS: RequiredSectionConfig[] = [
	{
		key: "abstract",
		title: "Abstract",
		guidance: "Short overview of what this spec is about.",
		defaultQuestion: "What is the core idea and scope of this spec?",
		minLength: 24,
	},
	{
		key: "rationale",
		title: "Rationale",
		guidance: "Problem statement and why this spec is needed.",
		defaultQuestion: "Why is this change needed now, and what problem does it solve?",
		minLength: 40,
	},
	{
		key: "implementationOverview",
		title: "Specification → Implementation Overview",
		guidance: "High-level proposal and implementation strategy.",
		defaultQuestion: "What is the proposed implementation approach?",
		minLength: 40,
	},
	{
		key: "milestones",
		title: "Specification → Milestones",
		guidance: "Use numbered phases with clear outcomes.",
		defaultQuestion: "What implementation phases and outcomes are expected?",
		template:
			"1. **Phase 1 — xxx**\n   - Outcome: xxx\n   - Notes: xxx\n\n2. **Phase 2 — xxx**\n   - Outcome: xxx\n   - Notes: xxx",
		minLength: 30,
	},
	{
		key: "dataModel",
		title: "Specification → Data Model",
		guidance: "Describe schema/data shape/storage impact.",
		defaultQuestion: "What data model changes are required?",
		minLength: 20,
	},
	{
		key: "proposedTests",
		title: "Specification → Proposed Tests",
		guidance: "Describe tests to write and expected validation.",
		defaultQuestion: "What tests prove this implementation works?",
		minLength: 24,
	},
	{
		key: "documentationImpact",
		title: "Specification → Documentation Impact",
		guidance: "What docs/readmes/changelogs must be updated?",
		defaultQuestion: "Which documentation changes are needed?",
		minLength: 20,
	},
];

function normalizeAction(value: string | undefined): Action | undefined {
	if (!value) return undefined;
	const lower = value.trim().toLowerCase();
	if ((ACTIONS as readonly string[]).includes(lower)) return lower as Action;
	if (lower === "new") return "create";
	return undefined;
}

function parseArgs(args: string): { action?: Action; rawTarget?: string } {
	const trimmed = args.trim();
	if (!trimmed) return {};
	const parts = trimmed.split(/\s+/);
	const action = normalizeAction(parts[0]);
	if (!action) return { rawTarget: trimmed };
	const rawTarget = parts.slice(1).join(" ").trim();
	return { action, rawTarget: rawTarget || undefined };
}

function expandHomePath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
	return value;
}

function getSpecsDir(): string {
	const customDir = process.env.SPECWRITER_DIR?.trim();
	return expandHomePath(customDir && customDir.length > 0 ? customDir : DEFAULT_SPECS_DIR);
}

async function ensureSpecsDir(): Promise<string> {
	const specsDir = getSpecsDir();
	await mkdir(specsDir, { recursive: true });
	return specsDir;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || "spec";
}

async function allocateSpecPath(specsDir: string, title: string): Promise<string> {
	const date = new Date().toISOString().slice(0, 10);
	const base = `${date}-${slugify(title)}`;
	let candidate = path.join(specsDir, `${base}.md`);
	let index = 2;
	while (await fileExists(candidate)) {
		candidate = path.join(specsDir, `${base}-${index}.md`);
		index++;
	}
	return candidate;
}

async function listSpecFiles(specsDir: string): Promise<Array<{ name: string; fullPath: string; mtimeMs: number }>> {
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(specsDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
	const withStats = await Promise.all(
		files.map(async (entry) => {
			const fullPath = path.join(specsDir, entry.name);
			const details = await stat(fullPath);
			return {
				name: entry.name,
				fullPath,
				mtimeMs: details.mtimeMs,
			};
		}),
	);

	return withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function resolveSpecPath(
	ctx: ExtensionCommandContext,
	specsDir: string,
	rawTarget: string | undefined,
	purpose: string,
): Promise<string | undefined> {
	if (rawTarget && rawTarget.trim().length > 0) {
		let candidate = expandHomePath(rawTarget.trim());
		if (!path.isAbsolute(candidate)) {
			candidate = path.join(specsDir, candidate);
		}
		const withMd = candidate.toLowerCase().endsWith(".md") ? candidate : `${candidate}.md`;
		if (await fileExists(candidate)) return candidate;
		if (await fileExists(withMd)) return withMd;
		ctx.ui.notify(`Spec file not found: ${rawTarget}`, "error");
		return undefined;
	}

	const specs = await listSpecFiles(specsDir);
	if (specs.length === 0) {
		ctx.ui.notify(`No specs found in ${specsDir}`, "warning");
		return undefined;
	}

	const selected = await ctx.ui.select(`Select spec to ${purpose}`, specs.map((spec) => spec.name));
	if (!selected) return undefined;
	return path.join(specsDir, selected);
}

function containsXxx(value: string): boolean {
	return /(^|\W)xxx(\W|$)/i.test(value);
}

function sectionStatus(value: string, minLength: number): "missing" | "has-xxx" | "short" | "good" {
	const trimmed = value.trim();
	if (!trimmed) return "missing";
	if (containsXxx(trimmed)) return "has-xxx";
	if (trimmed.length < minLength) return "short";
	return "good";
}

function ensureSectionContent(value: string, defaultQuestion: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return `xxx\n- Question: ${defaultQuestion}`;
	}
	if (containsXxx(trimmed) && !/question\s*:/i.test(trimmed)) {
		return `${trimmed}\n- Question: ${defaultQuestion}`;
	}
	return trimmed;
}

function appendOpenQuestion(value: string, question: string): string {
	const trimmedQuestion = question.trim();
	if (!trimmedQuestion) return value;
	return `${value}\n\nxxx\n- Question: ${trimmedQuestion}`;
}

async function askTitle(ctx: ExtensionCommandContext, prefill = ""): Promise<string | undefined> {
	let current = prefill;
	while (true) {
		const input = await ctx.ui.input("Spec title", current || "Short descriptive title");
		if (input === undefined) return undefined;
		const trimmed = input.trim();
		if (trimmed.length > 0) return trimmed;
		ctx.ui.notify("Title is required.", "warning");
		current = "";
	}
}

async function editRequiredSection(
	ctx: ExtensionCommandContext,
	section: RequiredSectionConfig,
	prefill: string,
): Promise<string | undefined> {
	let current = prefill.trim() || section.template || "";

	while (true) {
		const edited = await ctx.ui.editor(`${section.title}\n\n${section.guidance}`, current);
		if (edited === undefined) return undefined;

		const trimmed = edited.trim();
		if (!trimmed) {
			const usePlaceholder = await ctx.ui.confirm(
				`${section.title} incomplete`,
				"Mark this section as `xxx` and continue?",
			);
			if (!usePlaceholder) {
				current = "";
				continue;
			}
			const followUp = await ctx.ui.input(`${section.title} follow-up question`, section.defaultQuestion);
			if (followUp === undefined) return undefined;
			return `xxx\n- Question: ${followUp.trim() || section.defaultQuestion}`;
		}

		let normalized = ensureSectionContent(trimmed, section.defaultQuestion);
		const unresolved = await ctx.ui.input(
			`${section.title} unresolved question (optional)`,
			"Leave empty if this section is clear for now",
		);
		if (unresolved === undefined) return undefined;
		normalized = appendOpenQuestion(normalized, unresolved);

		const keep = await ctx.ui.confirm(`Use ${section.title}?`, "Keep this section text?");
		if (keep) return normalized;
		current = trimmed;
	}
}

async function editOptionalSection(
	ctx: ExtensionCommandContext,
	title: string,
	prefill: string,
	defaultQuestion: string,
): Promise<string | undefined> {
	const edited = await ctx.ui.editor(title, prefill);
	if (edited === undefined) return undefined;
	const trimmed = edited.trim();
	if (!trimmed) return "";
	return ensureSectionContent(trimmed, defaultQuestion);
}

async function collectFurtherInfo(
	ctx: ExtensionCommandContext,
	seed: Partial<SpecDraft>,
	mode: Mode,
): Promise<{ alternatives?: string; references?: string } | undefined> {
	let alternatives = (seed.alternatives || "").trim();
	let references = (seed.references || "").trim();

	const hasExisting = alternatives.length > 0 || references.length > 0;
	const includeFurther =
		mode === "create"
			? await ctx.ui.confirm("Further Information", "Add optional Further Information section?")
			: hasExisting
				? await ctx.ui.confirm("Further Information", "Keep/edit existing Further Information section?")
				: await ctx.ui.confirm("Further Information", "Add optional Further Information section?");

	if (!includeFurther) {
		return { alternatives: "", references: "" };
	}

	if (alternatives) {
		const editExisting = mode === "create" ? true : await ctx.ui.confirm("Alternatives", "Edit existing Alternatives?");
		if (editExisting) {
			const next = await editOptionalSection(
				ctx,
				"Further Information → Alternatives",
				alternatives,
				"Which alternative approaches should be evaluated?",
			);
			if (next === undefined) return undefined;
			alternatives = next;
		}
	} else {
		const add = await ctx.ui.confirm("Alternatives", "Add Alternatives subsection?");
		if (add) {
			const next = await editOptionalSection(
				ctx,
				"Further Information → Alternatives",
				"",
				"Which alternative approaches should be evaluated?",
			);
			if (next === undefined) return undefined;
			alternatives = next;
		}
	}

	if (references) {
		const editExisting = mode === "create" ? true : await ctx.ui.confirm("References", "Edit existing References?");
		if (editExisting) {
			const next = await editOptionalSection(
				ctx,
				"Further Information → References",
				references,
				"Which links or supporting docs should be added?",
			);
			if (next === undefined) return undefined;
			references = next;
		}
	} else {
		const add = await ctx.ui.confirm("References", "Add References subsection?");
		if (add) {
			const next = await editOptionalSection(
				ctx,
				"Further Information → References",
				"- [Name](https://example.com)",
				"Which links or supporting docs should be added?",
			);
			if (next === undefined) return undefined;
			references = next;
		}
	}

	return {
		alternatives,
		references,
	};
}

async function collectSpecDraft(
	ctx: ExtensionCommandContext,
	seed: Partial<SpecDraft>,
	mode: Mode,
): Promise<SpecDraft | undefined> {
	let title = (seed.title || "").trim();
	if (mode === "create" || !title) {
		title = (await askTitle(ctx, title)) || "";
		if (!title) return undefined;
	} else {
		const changeTitle = await ctx.ui.confirm("Spec title", `Current title: ${title}\n\nChange title?`);
		if (changeTitle) {
			const updatedTitle = await askTitle(ctx, title);
			if (!updatedTitle) return undefined;
			title = updatedTitle;
		}
	}

	const result: Partial<SpecDraft> = { title };

	for (const section of REQUIRED_SECTIONS) {
		const previous = String(seed[section.key] || "");
		const status = sectionStatus(previous, section.minLength);
		let shouldEdit = true;

		if (mode === "update" && previous.trim().length > 0) {
			if (status === "good") {
				shouldEdit = await ctx.ui.confirm(section.title, "Section looks complete. Edit anyway?");
			} else {
				shouldEdit = await ctx.ui.confirm(
					`${section.title} needs clarification`,
					`Current status: ${status}. Clarify this section now?`,
				);
			}
		}

		if (!shouldEdit) {
			result[section.key] = ensureSectionContent(previous, section.defaultQuestion);
			continue;
		}

		const updated = await editRequiredSection(ctx, section, previous);
		if (updated === undefined) return undefined;
		result[section.key] = updated;
	}

	const furtherInfo = await collectFurtherInfo(ctx, seed, mode);
	if (furtherInfo === undefined) return undefined;

	result.alternatives = furtherInfo.alternatives?.trim();
	result.references = furtherInfo.references?.trim();

	return normalizeSpec(result as SpecDraft);
}

function normalizeSpec(spec: SpecDraft): SpecDraft {
	const normalized: SpecDraft = {
		title: spec.title.trim(),
		abstract: ensureSectionContent(spec.abstract || "", REQUIRED_SECTIONS[0].defaultQuestion),
		rationale: ensureSectionContent(spec.rationale || "", REQUIRED_SECTIONS[1].defaultQuestion),
		implementationOverview: ensureSectionContent(
			spec.implementationOverview || "",
			REQUIRED_SECTIONS[2].defaultQuestion,
		),
		milestones: ensureSectionContent(spec.milestones || "", REQUIRED_SECTIONS[3].defaultQuestion),
		dataModel: ensureSectionContent(spec.dataModel || "", REQUIRED_SECTIONS[4].defaultQuestion),
		proposedTests: ensureSectionContent(spec.proposedTests || "", REQUIRED_SECTIONS[5].defaultQuestion),
		documentationImpact: ensureSectionContent(
			spec.documentationImpact || "",
			REQUIRED_SECTIONS[6].defaultQuestion,
		),
		alternatives: spec.alternatives?.trim() ? ensureSectionContent(spec.alternatives, "What alternatives should be considered?") : "",
		references: spec.references?.trim() ? ensureSectionContent(spec.references, "What references should be added?") : "",
	};

	if (!normalized.title) {
		normalized.title = "Untitled Spec";
	}

	return normalized;
}

function buildSpecMarkdown(spec: SpecDraft): string {
	const normalized = normalizeSpec(spec);
	const lines: string[] = [
		`# ${normalized.title}`,
		"",
		"## Abstract",
		"",
		normalized.abstract,
		"",
		"## Rationale",
		"",
		normalized.rationale,
		"",
		"## Specification",
		"",
		"### Implementation Overview",
		"",
		normalized.implementationOverview,
		"",
		"### Milestones",
		"",
		normalized.milestones,
		"",
		"### Data Model",
		"",
		normalized.dataModel,
		"",
		"### Proposed Tests",
		"",
		normalized.proposedTests,
		"",
		"### Documentation Impact",
		"",
		normalized.documentationImpact,
	];

	const hasAlternatives = Boolean(normalized.alternatives && normalized.alternatives.trim());
	const hasReferences = Boolean(normalized.references && normalized.references.trim());

	if (hasAlternatives || hasReferences) {
		lines.push("", "## Further Information", "");
		if (hasAlternatives) {
			lines.push("### Alternatives", "", normalized.alternatives!.trim(), "");
		}
		if (hasReferences) {
			lines.push("### References", "", normalized.references!.trim(), "");
		}
	}

	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findSectionBlock(
	lines: string[],
	level: number,
	titles: string[],
	start = 0,
	end = lines.length,
): SectionBlock | undefined {
	for (let i = start; i < end; i++) {
		const line = lines[i].trim();
		const target = titles.some((title) => {
			const pattern = new RegExp(`^${"#".repeat(level)}\\s+${escapeRegExp(title)}\\s*$`, "i");
			return pattern.test(line);
		});
		if (!target) continue;

		let j = i + 1;
		while (j < end) {
			const headingMatch = /^(#{1,6})\s+/.exec(lines[j].trim());
			if (headingMatch && headingMatch[1].length <= level) break;
			j++;
		}
		return {
			content: lines.slice(i + 1, j).join("\n").trim(),
			start: i + 1,
			end: j,
		};
	}
	return undefined;
}

function parseSpecMarkdown(markdown: string): Partial<SpecDraft> {
	const lines = markdown.split(/\r?\n/);
	const titleMatch = /^#\s+(.+)$/m.exec(markdown);
	const title = titleMatch?.[1]?.trim() || "";

	const abstract = findSectionBlock(lines, 2, ["Abstract"])?.content || "";
	const rationale = findSectionBlock(lines, 2, ["Rationale"])?.content || "";

	const specification = findSectionBlock(lines, 2, ["Specification"]);
	const specStart = specification?.start ?? 0;
	const specEnd = specification?.end ?? lines.length;

	const implementationOverview =
		findSectionBlock(lines, 3, ["Implementation Overview", "Overview"], specStart, specEnd)?.content || "";
	const milestones = findSectionBlock(lines, 3, ["Milestones", "Implementation Phases"], specStart, specEnd)?.content || "";
	const dataModel = findSectionBlock(lines, 3, ["Data Model"], specStart, specEnd)?.content || "";
	const proposedTests = findSectionBlock(lines, 3, ["Proposed Tests", "Tests"], specStart, specEnd)?.content || "";
	const documentationImpact =
		findSectionBlock(lines, 3, ["Documentation Impact"], specStart, specEnd)?.content || "";

	const furtherInfo = findSectionBlock(lines, 2, ["Further Information"]);
	const alternatives = furtherInfo
		? findSectionBlock(lines, 3, ["Alternatives"], furtherInfo.start, furtherInfo.end)?.content || ""
		: "";
	const references = furtherInfo
		? findSectionBlock(lines, 3, ["References"], furtherInfo.start, furtherInfo.end)?.content || ""
		: "";

	return {
		title,
		abstract,
		rationale,
		implementationOverview,
		milestones,
		dataModel,
		proposedTests,
		documentationImpact,
		alternatives,
		references,
	};
}

function countMatches(value: string, expression: RegExp): number {
	const matches = value.match(expression);
	return matches ? matches.length : 0;
}

function hasDefinedMilestoneOutcomes(value: string): boolean {
	const hasNumberedItems = /^\s*\d+\.\s+/m.test(value);
	const hasOutcomeLines = /^\s*[-*]\s+Outcome\s*:/im.test(value);
	return hasNumberedItems && hasOutcomeLines;
}

function computeReview(spec: SpecDraft, markdown: string): { unresolvedMarkers: number; review: ReviewItem[] } {
	const unresolvedMarkers = countMatches(markdown, /(^|\W)xxx(\W|$)/gi);
	const purposeClear = !containsXxx(spec.abstract) && !containsXxx(spec.rationale) && spec.abstract.length >= 24;
	const milestonesClear = hasDefinedMilestoneOutcomes(spec.milestones) && !containsXxx(spec.milestones);
	const implementationClear = !containsXxx(spec.implementationOverview) && spec.implementationOverview.length >= 40;
	const testsClear = !containsXxx(spec.proposedTests) && spec.proposedTests.length >= 24;
	const alternativesPresent = Boolean(spec.alternatives && spec.alternatives.trim());
	const requiredComplete = REQUIRED_SECTIONS.every((section) => {
		const value = String(spec[section.key] || "");
		return sectionStatus(value, section.minLength) !== "missing";
	});

	const review: ReviewItem[] = [
		{
			question: "Is the purpose of the spec clear?",
			status: purposeClear ? "yes" : "needs-work",
			note: purposeClear
				? "Abstract + Rationale look specific enough."
				: "Abstract or Rationale is missing/placeholder-heavy.",
		},
		{
			question: "Does the spec contain clear milestones with a defined outcome?",
			status: milestonesClear ? "yes" : "needs-work",
			note: milestonesClear
				? "Milestones include numbered phases and outcome lines."
				: "Add numbered phases and explicit `Outcome:` lines.",
		},
		{
			question: "Do I understand what needs to be done for the task?",
			status: implementationClear && milestonesClear ? "yes" : "needs-work",
			note:
				implementationClear && milestonesClear
					? "Implementation overview + milestones give actionable direction."
					: "Clarify implementation overview and milestone outcomes.",
		},
		{
			question: "Do I understand what is described in the spec?",
			status: requiredComplete && unresolvedMarkers === 0 ? "yes" : "needs-work",
			note:
				requiredComplete && unresolvedMarkers === 0
					? "Required sections are present and currently resolved."
					: "Some required sections are weak or still marked with `xxx`.",
		},
		{
			question: "Does the spec solve the task it is written for?",
			status: implementationClear && !containsXxx(spec.rationale) ? "yes" : "needs-work",
			note:
				implementationClear && !containsXxx(spec.rationale)
					? "Rationale and proposal align reasonably well."
					: "Need stronger rationale/proposal alignment.",
		},
		{
			question: "Is there an alternative solution that may be easier to implement?",
			status: alternativesPresent ? "yes" : "needs-work",
			note: alternativesPresent
				? "Alternatives section exists."
				: "No alternatives documented yet (optional but recommended).",
		},
		{
			question: "Is the spec self-contradictory?",
			status: "manual-check",
			note: "Requires human review; automated checks are limited.",
		},
		{
			question: "Is the spec self-consistent?",
			status: "manual-check",
			note: "Requires human review across all sections.",
		},
		{
			question: "Is it clear what kind of tests need to be written?",
			status: testsClear ? "yes" : "needs-work",
			note: testsClear ? "Proposed tests section is populated." : "Clarify test scope and expected outcomes.",
		},
	];

	return { unresolvedMarkers, review };
}

function buildReviewMarkdown(specPath: string, unresolvedMarkers: number, reviewItems: ReviewItem[]): string {
	const lines = [`Specwriter review for \`${specPath}\``, "", `Unresolved \`xxx\` markers: **${unresolvedMarkers}**`, ""];

	for (const item of reviewItems) {
		const prefix = item.status === "yes" ? "✅" : item.status === "needs-work" ? "⚠️" : "🧭";
		lines.push(`- ${prefix} ${item.question}`);
		lines.push(`  - ${item.note}`);
	}

	return lines.join("\n");
}

async function maybePolishMarkdown(
	ctx: ExtensionCommandContext,
	markdown: string,
): Promise<string | undefined> {
	const shouldPolish = await ctx.ui.confirm("Final spec draft", "Open full markdown for a final manual pass before saving?");
	if (!shouldPolish) return markdown;
	const edited = await ctx.ui.editor("Spec Markdown", markdown);
	if (edited === undefined) return undefined;
	const trimmed = edited.trim();
	if (!trimmed) return markdown;
	return trimmed + "\n";
}

async function publishReview(pi: ExtensionAPI, specPath: string, markdown: string): Promise<void> {
	const parsed = normalizeSpec(parseSpecMarkdown(markdown) as SpecDraft);
	const { unresolvedMarkers, review } = computeReview(parsed, markdown);
	pi.sendMessage({
		customType: "specwriter-review",
		content: buildReviewMarkdown(specPath, unresolvedMarkers, review),
		display: true,
		details: {
			specPath,
			unresolvedMarkers,
			review,
		},
	});
}

async function createSpec(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	specsDir: string,
	initialTitle: string | undefined,
): Promise<void> {
	const seed: Partial<SpecDraft> = {
		title: initialTitle || "",
		milestones: REQUIRED_SECTIONS.find((s) => s.key === "milestones")?.template,
	};

	const draft = await collectSpecDraft(ctx, seed, "create");
	if (!draft) {
		ctx.ui.notify("Specwriter cancelled.", "info");
		return;
	}

	let markdown = buildSpecMarkdown(draft);
	const polished = await maybePolishMarkdown(ctx, markdown);
	if (polished === undefined) {
		ctx.ui.notify("Specwriter cancelled.", "info");
		return;
	}
	markdown = polished;

	const specPath = await allocateSpecPath(specsDir, draft.title);
	await writeFile(specPath, markdown, "utf8");
	ctx.ui.notify(`Saved spec: ${specPath}`, "info");
	await publishReview(pi, specPath, markdown);
}

async function updateSpec(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	specsDir: string,
	rawTarget: string | undefined,
): Promise<void> {
	const specPath = await resolveSpecPath(ctx, specsDir, rawTarget, "update");
	if (!specPath) return;

	const currentMarkdown = await readFile(specPath, "utf8");
	const parsed = parseSpecMarkdown(currentMarkdown);
	if (!parsed.title) {
		parsed.title = path.basename(specPath, path.extname(specPath));
	}

	const draft = await collectSpecDraft(ctx, parsed, "update");
	if (!draft) {
		ctx.ui.notify("Specwriter cancelled.", "info");
		return;
	}

	let markdown = buildSpecMarkdown(draft);
	const polished = await maybePolishMarkdown(ctx, markdown);
	if (polished === undefined) {
		ctx.ui.notify("Specwriter cancelled.", "info");
		return;
	}
	markdown = polished;

	await writeFile(specPath, markdown, "utf8");
	ctx.ui.notify(`Updated spec: ${specPath}`, "info");
	await publishReview(pi, specPath, markdown);
}

async function reviewSpec(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	specsDir: string,
	rawTarget: string | undefined,
): Promise<void> {
	const specPath = await resolveSpecPath(ctx, specsDir, rawTarget, "review");
	if (!specPath) return;

	const markdown = await readFile(specPath, "utf8");
	await publishReview(pi, specPath, markdown);

	const clarify = await ctx.ui.confirm("Review complete", "Run guided update to clarify this spec now?");
	if (clarify) {
		await updateSpec(pi, ctx, specsDir, specPath);
	}
}

async function listSpecs(pi: ExtensionAPI, ctx: ExtensionCommandContext, specsDir: string): Promise<void> {
	const specs = await listSpecFiles(specsDir);
	if (specs.length === 0) {
		ctx.ui.notify(`No specs found in ${specsDir}`, "info");
		return;
	}

	const lines = specs.map((spec) => `- ${spec.name}`);
	pi.sendMessage({
		customType: "specwriter-list",
		content: `Specs in \`${specsDir}\`:\n\n${lines.join("\n")}`,
		display: true,
		details: { specsDir, files: specs.map((spec) => spec.name) },
	});

	const selected = await ctx.ui.select("Review a spec now?", ["(skip)", ...specs.map((spec) => spec.name)]);
	if (!selected || selected === "(skip)") return;
	await reviewSpec(pi, ctx, specsDir, selected);
}

function actionCompletions(prefix: string) {
	const value = prefix.trim().toLowerCase();
	if (value.includes(" ")) return null;
	const items = ACTIONS.filter((action) => action.startsWith(value)).map((action) => ({
		value: action,
		label: action,
	}));
	return items.length > 0 ? items : null;
}

async function runSpecwriter(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("specwriter requires interactive mode.", "error");
		return;
	}

	const specsDir = await ensureSpecsDir();
	const parsed = parseArgs(args);
	let action = parsed.action;

	if (!action) {
		const selected = await ctx.ui.select("Specwriter", ACTIONS.map((entry) => entry));
		if (!selected) return;
		action = normalizeAction(selected);
	}

	if (!action) return;

	switch (action) {
		case "create":
			await createSpec(pi, ctx, specsDir, parsed.rawTarget);
			break;
		case "update":
			await updateSpec(pi, ctx, specsDir, parsed.rawTarget);
			break;
		case "review":
			await reviewSpec(pi, ctx, specsDir, parsed.rawTarget);
			break;
		case "list":
			await listSpecs(pi, ctx, specsDir);
			break;
	}
}

export default function specwriter(pi: ExtensionAPI) {
	const handler = async (args: string, ctx: ExtensionCommandContext) => {
		try {
			await runSpecwriter(pi, args, ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`specwriter failed: ${message}`, "error");
		}
	};

	pi.registerCommand("specwriter", {
		description: "Interactive spec drafting assistant (create/update/review)",
		getArgumentCompletions: actionCompletions,
		handler,
	});

	pi.registerCommand("spec", {
		description: "Alias for /specwriter",
		getArgumentCompletions: actionCompletions,
		handler,
	});
}
