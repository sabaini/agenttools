import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test } from "../specwriter.ts";

async function withTempDir(prefix: string, run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("parseArgs parses spec path and help", () => {
	const parsed = __test.parseArgs("draft-spec --help");
	assert.equal(parsed.specPath, "draft-spec");
	assert.equal(parsed.help, true);
});

test("parseArgs rejects unknown options", () => {
	assert.throws(() => __test.parseArgs("--wat"), /unknown option: --wat/);
});

test("parseArgs rejects multiple filenames", () => {
	assert.throws(
		() => __test.parseArgs("one two"),
		/only one spec filename\/path is supported/,
	);
});

test("resolveSpecPath prefers SPECWRITER_DIR and adds .md", async () => {
	await withTempDir("specwriter-path-", async (root) => {
		const specDir = path.join(root, "specs");
		const cwd = path.join(root, "cwd");
		await fs.mkdir(specDir, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });

		const expected = path.join(specDir, "draft.md");
		await fs.writeFile(expected, "# Abstract\n# Rationale\n# Specification\n", "utf8");

		const resolved = __test.resolveSpecPath("draft", cwd, specDir);
		assert.equal(resolved, expected);
	});
});

test("resolveSpecPath falls back to cwd", async () => {
	await withTempDir("specwriter-cwd-", async (root) => {
		const specDir = path.join(root, "specs");
		const cwd = path.join(root, "cwd");
		await fs.mkdir(specDir, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });

		const expected = path.join(cwd, "local.md");
		await fs.writeFile(expected, "# Abstract\n# Rationale\n# Specification\n", "utf8");

		const resolved = __test.resolveSpecPath("local", cwd, specDir);
		assert.equal(resolved, expected);
	});
});

test("resolveSpecPath rejects non-markdown paths", () => {
	assert.throws(
		() => __test.resolveSpecPath("draft.txt", process.cwd(), process.cwd()),
		/specwriter only supports markdown files/,
	);
});

test("analyzeSpec catches wrong heading levels and orphan milestones", () => {
	const analysis = __test.analyzeSpec(
		[
			"## Abstract",
			"",
			"# Rationale",
			"",
			"# Specification",
			"",
			"### Milestone 1: Define baseline",
		].join("\n"),
	);

	assert.equal(analysis.requiredMissing.length, 0);
	assert.equal(analysis.requiredWrongLevel.length, 1);
	assert.equal(analysis.requiredWrongLevel[0].section, "Abstract");
	assert.equal(analysis.requiredWrongLevel[0].level, 2);
	assert.equal(analysis.phaseCount, 0);
	assert.equal(analysis.milestoneCount, 1);
	assert.equal(analysis.milestonesWithoutPhase, 1);
});

test("analyzeSpec counts numbered phases and milestones", () => {
	const analysis = __test.analyzeSpec(
		[
			"# Abstract",
			"Overview.",
			"",
			"# Rationale",
			"Problem statement.",
			"",
			"# Specification",
			"Implementation plan with architecture details.",
			"Testing strategy with CI coverage.",
			"Documentation plan with README updates.",
			"",
			"## Phase 1: Foundation",
			"### Milestone 1.1: Setup core module",
			"### Milestone 1.2: Add integration tests",
			"",
			"## Phase 2: Rollout",
			"### Milestone 2.1: Document operations",
			"",
			"# Further Information",
			"Links.",
		].join("\n"),
	);

	assert.deepEqual(analysis.requiredMissing, []);
	assert.deepEqual(analysis.requiredWrongLevel, []);
	assert.equal(analysis.hasFurtherInformation, true);
	assert.equal(analysis.phaseCount, 2);
	assert.equal(analysis.milestoneCount, 3);
	assert.equal(analysis.milestonesWithoutPhase, 0);
	assert.equal(analysis.phasesWithoutMilestones, 0);
	assert.equal(analysis.hasImplementationSignal, true);
	assert.equal(analysis.hasTestingSignal, true);
	assert.equal(analysis.hasDocumentationSignal, true);
});

test("analyzeSpec recommends phases for large unphased specs", () => {
	const longBody = Array.from({ length: 350 }, (_unused, i) => `token-${i}`).join(" ");
	const analysis = __test.analyzeSpec(
		[
			"# Abstract",
			"Overview.",
			"",
			"# Rationale",
			"Problem.",
			"",
			"# Specification",
			longBody,
		].join("\n"),
	);

	assert.equal(analysis.phaseCount, 0);
	assert.equal(analysis.shouldRecommendPhases, true);
});

test("analyzeSpec keeps existing frontmatter title", () => {
	const analysis = __test.analyzeSpec(
		[
			"---",
			'title: "Cross Region Replication"',
			"owner: infra",
			"---",
			"",
			"# Abstract",
			"",
			"# Rationale",
			"",
			"# Specification",
		].join("\n"),
	);

	assert.equal(analysis.hasYamlFrontmatter, true);
	assert.equal(analysis.hasFrontmatterTitle, true);
	assert.equal(analysis.frontmatterTitle, "Cross Region Replication");
	assert.equal(analysis.suggestedTitle, "Cross Region Replication");
	assert.equal(analysis.suggestedTitleSource, "frontmatter");
});

test("analyzeSpec uses top table title candidate when frontmatter is missing", () => {
	const analysis = __test.analyzeSpec(
		[
			"| Field | Value |",
			"| --- | --- |",
			"| Title | Payments Retry Design |",
			"| Owner | Runtime |",
			"",
			"# Abstract",
			"",
			"# Rationale",
			"",
			"# Specification",
		].join("\n"),
	);

	assert.equal(analysis.hasYamlFrontmatter, false);
	assert.equal(analysis.hasFrontmatterTitle, false);
	assert.equal(analysis.tableTitleCandidate, "Payments Retry Design");
	assert.equal(analysis.suggestedTitle, "Payments Retry Design");
	assert.equal(analysis.suggestedTitleSource, "table");
});

test("analyzeSpec synthesizes title when no explicit candidate exists", () => {
	const analysis = __test.analyzeSpec(
		[
			"# Abstract",
			"",
			"# Rationale",
			"",
			"# Specification",
		].join("\n"),
		"/tmp/cache-invalidation-plan.md",
	);

	assert.equal(analysis.suggestedTitle, "Cache Invalidation Plan");
	assert.equal(analysis.suggestedTitleSource, "synthesized");
});

test("buildPreflightNotes includes open-question reminder", () => {
	const analysis = __test.analyzeSpec(
		[
			"# Abstract",
			"",
			"# Rationale",
			"",
			"# Specification",
			"Implementation and testing only.",
		].join("\n"),
	);
	const notes = __test.buildPreflightNotes(analysis);
	assert.ok(notes.some((note: string) => note.includes("No existing `xxx` open-question markers detected.")));
});

test("buildPreflightNotes flags missing yaml frontmatter title with suggestion", () => {
	const analysis = __test.analyzeSpec(
		[
			"| Title | Queue Recovery Plan |",
			"",
			"# Abstract",
			"",
			"# Rationale",
			"",
			"# Specification",
		].join("\n"),
	);
	const notes = __test.buildPreflightNotes(analysis);
	assert.ok(notes.some((note: string) => note.includes("No YAML frontmatter detected")));
	assert.ok(notes.some((note: string) => note.includes('title: "Queue Recovery Plan"')));
});

test("stripFrontmatter removes yaml header", () => {
	const stripped = __test.stripFrontmatter([
		"---",
		"description: test",
		"---",
		"Body",
	].join("\n"));
	assert.equal(stripped.trim(), "Body");
});

test("buildSpecwriterPrompt renders template placeholders", () => {
	const analysis = __test.analyzeSpec(
		[
			"# Abstract",
			"",
			"# Rationale",
			"",
			"# Specification",
			"Testing docs.",
		].join("\n"),
	);
	const prompt = __test.buildSpecwriterPrompt(
		"/tmp/spec.md",
		analysis,
		"Path={{SPEC_PATH}}\nQuestions:\n{{GUIDING_QUESTIONS}}\nNotes:\n{{PREFLIGHT_NOTES}}",
	);

	assert.ok(prompt.includes("Path=/tmp/spec.md"));
	assert.ok(prompt.includes("- Do I understand what needs to be done for the task?"));
	assert.ok(prompt.includes("Notes:"));
	assert.equal(prompt.includes("{{SPEC_PATH}}"), false);
});

test("buildSpecwriterPrompt default guidance requires yaml title frontmatter", () => {
	const analysis = __test.analyzeSpec(
		[
			"# Abstract",
			"",
			"# Rationale",
			"",
			"# Specification",
		].join("\n"),
		"/tmp/disaster-recovery-spec.md",
	);
	const prompt = __test.buildSpecwriterPrompt("/tmp/disaster-recovery-spec.md", analysis);
	assert.ok(prompt.includes("YAML frontmatter"));
	assert.ok(prompt.includes("`| Title | ...`"));
});

test("loadPromptTemplate reads pi-prompts/specwriter.md", async () => {
	await withTempDir("specwriter-template-", async (root) => {
		const promptsDir = path.join(root, "pi-prompts");
		await fs.mkdir(promptsDir, { recursive: true });
		await fs.writeFile(
			path.join(promptsDir, "specwriter.md"),
			["---", "description: prompt", "---", "Hello {{SPEC_PATH}}"].join("\n"),
			"utf8",
		);

		const template = await __test.loadPromptTemplate(root);
		assert.equal(template?.trim(), "Hello {{SPEC_PATH}}");
	});
});
