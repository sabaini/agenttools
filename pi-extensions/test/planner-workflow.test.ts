import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test } from "../planner-workflow.ts";

async function withTempDir(prefix: string, run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("parseArgs handles quoted arguments", () => {
	const parsed = __test.parseArgs('m1-foo "extra value"');
	assert.equal(parsed.raw, 'm1-foo "extra value"');
	assert.deepEqual(parsed.tokens, ["m1-foo", "extra value"]);
});

test("parsePlanYaml extracts repo metadata and milestones", () => {
	const parsed = __test.parsePlanYaml(
		[
			"schema_version: 1",
			"repo:",
			"  root: /tmp/repo",
			"  origin_url: git@github.com:org/project.git",
			"  default_branch: main",
			"milestones:",
			"  - id: m1",
			"    name: first",
			"    slug: first",
			"    path: milestones/m1-first/",
			"  - id: m2",
			"    slug: second",
			"    path: milestones/m2-second/",
		].join("\n"),
		"/tmp/plan/plan.yaml",
	);

	assert.equal(parsed.repo.root, "/tmp/repo");
	assert.equal(parsed.repo.originUrl, "git@github.com:org/project.git");
	assert.equal(parsed.repo.defaultBranch, "main");
	assert.equal(parsed.milestones.length, 2);
	assert.equal(parsed.milestones[0].id, "m1");
	assert.equal(parsed.milestones[1].slug, "second");
});

test("resolveMilestoneSelector supports id slug and directory", () => {
	const milestones = [
		{ id: "m1", slug: "alpha", path: "milestones/m1-alpha/" },
		{ id: "m2", slug: "beta", path: "milestones/m2-beta/" },
	];

	assert.equal(__test.resolveMilestoneSelector("m1", milestones).id, "m1");
	assert.equal(__test.resolveMilestoneSelector("beta", milestones).id, "m2");
	assert.equal(__test.resolveMilestoneSelector("m2-beta", milestones).id, "m2");
});

test("normalizeOriginUrl normalizes ssh and https forms", () => {
	const ssh = __test.normalizeOriginUrl("git@github.com:org/repo.git");
	const https = __test.normalizeOriginUrl("https://github.com/org/repo");
	assert.equal(ssh, https);
});

test("expandTemplate substitutes positional and all-args placeholders", () => {
	const expanded = __test.expandTemplate(
		"A=$1 B=$2 ALL=$ARGUMENTS SLICE=${@:2}",
		"one two three",
		["one", "two", "three"],
	);
	assert.equal(expanded, "A=one B=two ALL=one two three SLICE=two three");
});

test("stripFrontmatter removes yaml header", () => {
	const result = __test.stripFrontmatter(["---", "description: x", "---", "body"].join("\n"));
	assert.equal(result.trim(), "body");
});

test("parseTaskIdLine handles list and nested forms", () => {
	assert.equal(__test.parseTaskIdLine("- id: m2-t1"), "m2-t1");
	assert.equal(__test.parseTaskIdLine('id: "m2-t2" # comment'), "m2-t2");
	assert.equal(__test.parseTaskIdLine("title: hello"), undefined);
});

test("milestone command completions derive ids/slugs from active plan", async () => {
	await withTempDir("planner-workflow-complete-milestones-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const planRoot = path.join(root, "plans", "demo-plan");
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		await fs.mkdir(path.join(repoRoot, ".pi"), { recursive: true });
		await fs.mkdir(path.join(planRoot, "milestones"), { recursive: true });

		await fs.writeFile(
			path.join(planRoot, "plan.yaml"),
			[
				"schema_version: 1",
				"repo:",
				`  root: ${repoRoot}`,
				"  default_branch: main",
				"milestones:",
				"  - id: m1",
				"    slug: alpha",
				"    path: milestones/m1-alpha/",
				"  - id: m2",
				"    slug: beta",
				"    path: milestones/m2-beta/",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(repoRoot, ".pi", "active_plan"), `${planRoot}\n`, "utf8");

		const completions = __test.getArgumentCompletionsForCommand(
			"milestone_start",
			__test.commandSpecs.milestone_start,
			"",
			repoRoot,
		);
		assert.ok(completions);
		assert.ok(completions.some((item: { value: string }) => item.value === "m1"));
		assert.ok(completions.some((item: { value: string }) => item.value === "alpha"));

		const filtered = __test.getArgumentCompletionsForCommand(
			"milestone_start",
			__test.commandSpecs.milestone_start,
			"bet",
			repoRoot,
		);
		assert.ok(filtered);
		assert.ok(filtered.some((item: { value: string }) => item.value === "beta"));
	});
});

test("tasker completions derive task ids from spec/state files", async () => {
	await withTempDir("planner-workflow-complete-tasks-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const planRoot = path.join(root, "plans", "demo-plan");
		const milestoneDir = path.join(planRoot, "milestones", "m1-alpha");
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		await fs.mkdir(path.join(repoRoot, ".pi"), { recursive: true });
		await fs.mkdir(milestoneDir, { recursive: true });

		await fs.writeFile(
			path.join(planRoot, "plan.yaml"),
			[
				"schema_version: 1",
				"repo:",
				`  root: ${repoRoot}`,
				"  default_branch: main",
				"milestones:",
				"  - id: m1",
				"    slug: alpha",
				"    path: milestones/m1-alpha/",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(repoRoot, ".pi", "active_plan"), `${planRoot}\n`, "utf8");
		await fs.writeFile(
			path.join(milestoneDir, "spec.yaml"),
			[
				"tasks:",
				"  - id: m1-t1",
				"    title: first",
				"  - id: m1-t2",
				"    title: second",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"tasks:",
				"  - id: m1-t1",
				"    status: planned",
				"  - id: m1-t2",
				"    status: planned",
			].join("\n"),
			"utf8",
		);

		const completions = __test.getArgumentCompletionsForCommand(
			"tasker",
			__test.commandSpecs.tasker,
			"m1-",
			repoRoot,
		);
		assert.ok(completions);
		assert.deepEqual(
			completions.map((item: { value: string }) => item.value).sort(),
			["m1-t1", "m1-t2"],
		);
	});
});
