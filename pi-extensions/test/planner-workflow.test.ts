import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import plannerWorkflowExtension, { __test } from "../planner-workflow.ts";

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

test("parsePlanYaml strips inline comments from scalar values", () => {
	const parsed = __test.parsePlanYaml(
		[
			"repo: # repo metadata",
			"  root: /tmp/repo # checkout",
			"  default_branch: main # trunk",
			"milestones: # work list",
			"  - id: m1 # auth",
			"    slug: alpha # slug",
			"    path: milestones/m1-alpha/ # dir",
		].join("\n"),
		"/tmp/plan/plan.yaml",
	);

	assert.equal(parsed.repo.root, "/tmp/repo");
	assert.equal(parsed.repo.defaultBranch, "main");
	assert.equal(parsed.milestones[0].id, "m1");
	assert.equal(parsed.milestones[0].slug, "alpha");
	assert.equal(parsed.milestones[0].path, "milestones/m1-alpha/");
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

test("parseTaskIdsFromYaml ignores nested ids inside a task body", () => {
	const ids = __test.parseTaskIdsFromYaml(
		[
			"tasks:",
			"  - id: m1-t1",
			"    checks:",
			"      - id: nested-check",
			"    metadata:",
			"      owner:",
			"        id: nested-owner",
			"  - title: second task",
			"    id: m1-t2",
		].join("\n"),
	);

	assert.deepEqual(Array.from(ids), ["m1-t1", "m1-t2"]);
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

test("tasker wrapper still dispatches when spec/state task ids drift", async () => {
	await withTempDir("planner-workflow-tasker-drift-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const planRoot = path.join(root, "plans", "demo-plan");
		const milestoneDir = path.join(planRoot, "milestones", "m1-alpha");
		const promptPath = path.join(root, "tasker.md");
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
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(promptPath, "Run task $1", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			getCommands() {
				return [{ source: "prompt", name: "tasker", path: promptPath }];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
				return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const tasker = commands.get("tasker");
		assert.ok(tasker);

		await tasker.handler("m1-t1", {
			cwd: repoRoot,
			ui: {
				setStatus() {},
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
			isIdle() {
				return true;
			},
		} as never);

		assert.equal(sentMessages.length, 1);
		assert.equal(sentMessages[0], "Run task m1-t1");
		assert.equal(
			notifications.filter((entry) => entry.level === "error").length,
			0,
			"expected tasker to dispatch instead of failing in the wrapper",
		);
	});
});

test("milestone_start ignores untracked files during preflight", async () => {
	await withTempDir("planner-workflow-milestone-start-untracked-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const planRoot = path.join(root, "plans", "demo-plan");
		const milestoneDir = path.join(planRoot, "milestones", "m1-alpha");
		const promptPath = path.join(root, "milestone_start.md");
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
		await fs.writeFile(path.join(milestoneDir, "spec.yaml"), "tasks:\n  - id: m1-t1\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "state.yaml"), "tasks:\n  - id: m1-t1\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(promptPath, "Start milestone $1", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const execCalls: string[][] = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			getCommands() {
				return [{ source: "prompt", name: "milestone_start", path: promptPath }];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				execCalls.push(args);
				if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
					return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
				}
				if (
					args[0] === "-C" &&
					args[1] === repoRoot &&
					args[2] === "rev-parse" &&
					args[3] === "--abbrev-ref" &&
					args[4] === "HEAD"
				) {
					return { code: 0, stdout: "main\n", stderr: "" };
				}
				if (
					args[0] === "-C" &&
					args[1] === repoRoot &&
					args[2] === "status" &&
					args[3] === "--porcelain" &&
					args[4] === "--untracked-files=no"
				) {
					return { code: 0, stdout: "", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const milestoneStart = commands.get("milestone_start");
		assert.ok(milestoneStart);

		await milestoneStart.handler("m1", {
			cwd: repoRoot,
			ui: {
				setStatus() {},
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
			isIdle() {
				return true;
			},
		} as never);

		assert.equal(sentMessages.length, 1);
		assert.equal(sentMessages[0], "Start milestone m1");
		assert.ok(
			execCalls.some(
				(args) =>
					JSON.stringify(args) ===
					JSON.stringify(["-C", repoRoot, "status", "--porcelain", "--untracked-files=no"]),
			),
			"expected milestone_start preflight to ignore untracked files",
		);
		assert.equal(
			notifications.filter((entry) => entry.level === "error").length,
			0,
			"expected milestone_start to proceed when only untracked files exist",
		);
	});
});

test("milestone_review fails fast when prepare_review tool is missing", async () => {
	await withTempDir("planner-workflow-milestone-review-missing-tool-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const planRoot = path.join(root, "plans", "demo-plan");
		const milestoneDir = path.join(planRoot, "milestones", "m1-alpha");
		const promptPath = path.join(root, "milestone_review.md");
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
		await fs.writeFile(path.join(milestoneDir, "spec.yaml"), "tasks:\n  - id: m1-t1\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "state.yaml"), "tasks:\n  - id: m1-t1\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(promptPath, "Review milestone $1", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			getCommands() {
				return [{ source: "prompt", name: "milestone_review", path: promptPath }];
			},
			getAllTools() {
				return [{ name: "read" }, { name: "bash" }];
			},
			getActiveTools() {
				return ["read", "bash"];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
					return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const milestoneReview = commands.get("milestone_review");
		assert.ok(milestoneReview);

		await milestoneReview.handler("m1", {
			cwd: repoRoot,
			ui: {
				setStatus() {},
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
			isIdle() {
				return true;
			},
		} as never);

		assert.equal(sentMessages.length, 0);
		assert.ok(
			notifications.some(
				(entry) =>
					entry.level === "error" &&
					entry.message.includes("Missing tool(s): prepare_review") &&
					entry.message.includes("/milestone_review requires active review tooling"),
			),
			"expected missing prepare_review error notification",
		);
	});
});

test("milestone_review fails fast when prepare_review tool is inactive", async () => {
	await withTempDir("planner-workflow-milestone-review-inactive-tool-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const planRoot = path.join(root, "plans", "demo-plan");
		const milestoneDir = path.join(planRoot, "milestones", "m1-alpha");
		const promptPath = path.join(root, "milestone_review.md");
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
		await fs.writeFile(path.join(milestoneDir, "spec.yaml"), "tasks:\n  - id: m1-t1\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "state.yaml"), "tasks:\n  - id: m1-t1\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(promptPath, "Review milestone $1", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			getCommands() {
				return [{ source: "prompt", name: "milestone_review", path: promptPath }];
			},
			getAllTools() {
				return [{ name: "read" }, { name: "bash" }, { name: "prepare_review" }];
			},
			getActiveTools() {
				return ["read", "bash"];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
					return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const milestoneReview = commands.get("milestone_review");
		assert.ok(milestoneReview);

		await milestoneReview.handler("m1", {
			cwd: repoRoot,
			ui: {
				setStatus() {},
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
			isIdle() {
				return true;
			},
		} as never);

		assert.equal(sentMessages.length, 0);
		assert.ok(
			notifications.some(
				(entry) =>
					entry.level === "error" &&
					entry.message.includes("Inactive tool(s): prepare_review") &&
					entry.message.includes("/milestone_review requires active review tooling"),
			),
			"expected inactive prepare_review error notification",
		);
	});
});
