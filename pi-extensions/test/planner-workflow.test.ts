import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

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

test("resolvePackageRootFromModuleUrl follows symlinked extension paths back to the real package root", async () => {
	await withTempDir("planner-workflow-package-root-symlink-", async (root) => {
		const packageRoot = path.join(root, "agenttools");
		const realExtensionsDir = path.join(packageRoot, "pi-extensions");
		const linkedAgentRoot = path.join(root, ".pi", "agent");
		const symlinkedExtensionsDir = path.join(linkedAgentRoot, "extensions");
		const realModulePath = path.join(realExtensionsDir, "planner-workflow.ts");
		const symlinkedModulePath = path.join(symlinkedExtensionsDir, "planner-workflow.ts");

		await fs.mkdir(realExtensionsDir, { recursive: true });
		await fs.mkdir(linkedAgentRoot, { recursive: true });
		await fs.writeFile(realModulePath, "export default {}\n", "utf8");
		await fs.symlink(realExtensionsDir, symlinkedExtensionsDir, "dir");

		assert.equal(__test.resolvePackageRootFromModuleUrl(pathToFileURL(symlinkedModulePath).href), packageRoot);
		assert.equal(__test.resolveWorkflowContractPath(packageRoot), path.join(packageRoot, "docs", "planner-workflow.md"));
	});
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

test("planner dispatches a native kickoff brief with repo-derived validation profile guidance", async () => {
	await withTempDir("planner-workflow-planner-native-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const promptPath = path.join(root, "planner.md");
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		await fs.writeFile(
			path.join(repoRoot, "package.json"),
			JSON.stringify(
				{
					name: "demo",
					scripts: {
						test: "vitest run",
						build: "vite build",
					},
					devDependencies: {
						typescript: "^5.0.0",
					},
				},
				null,
				2,
			),
			"utf8",
		);
		await fs.writeFile(path.join(repoRoot, "package-lock.json"), "{}\n", "utf8");
		await fs.writeFile(path.join(repoRoot, "tsconfig.json"), "{}\n", "utf8");
		await fs.writeFile(
			promptPath,
			["---", "description: planner reference", "---", "SENTINEL TEMPLATE BODY"].join("\n"),
			"utf8",
		);

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool() {},
			getCommands() {
				return [{ source: "prompt", name: "planner", path: promptPath }];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
					return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "remote", "get-url", "origin"])) {
					return { code: 0, stdout: "git@github.com:org/demo.git\n", stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD"])) {
					return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const planner = commands.get("planner");
		assert.ok(planner);

		await planner.handler("Add milestone-local validation profiles", {
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

		assert.equal(
			notifications.filter((entry) => entry.level === "error").length,
			0,
			"expected /planner native kickoff to avoid wrapper-level errors",
		);
		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0].includes("Continue the native /planner workflow for this repository."));
		assert.ok(sentMessages[0].includes("Native repo inspection already completed"));
		assert.ok(sentMessages[0].includes("Default branch hint: `main`"));
		assert.ok(!sentMessages[0].includes("SENTINEL TEMPLATE BODY"));
		assert.ok(sentMessages[0].includes("Every generated milestone `spec.yaml` must include an explicit `validation:` block."));
		assert.ok(sentMessages[0].includes("planner_apply_validation_profile"));
		assert.ok(sentMessages[0].includes("planner_finalize_plan"));
		assert.ok(sentMessages[0].includes("validation:"));
		assert.ok(sentMessages[0].includes("\"npm test\""));
		assert.ok(sentMessages[0].includes("\"npm run build\""));
		assert.ok(sentMessages[0].includes("\"npx tsc --noEmit\""));
	});
});

test("planner_apply_validation_profile stamps repo-derived validation commands into a spec file", async () => {
	await withTempDir("planner-workflow-apply-validation-profile-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const specPath = path.join(repoRoot, "tmp-plan", "m1", "spec.yaml");
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		await fs.mkdir(path.dirname(specPath), { recursive: true });
		await fs.writeFile(
			path.join(repoRoot, "package.json"),
			JSON.stringify(
				{
					name: "demo",
					scripts: {
						test: "vitest run",
						build: "vite build",
					},
					devDependencies: {
						typescript: "^5.0.0",
					},
				},
				null,
				2,
			),
			"utf8",
		);
		await fs.writeFile(path.join(repoRoot, "package-lock.json"), "{}\n", "utf8");
		await fs.writeFile(path.join(repoRoot, "tsconfig.json"), "{}\n", "utf8");
		await fs.writeFile(
			specPath,
			[
				"goal: demo",
				"tasks:",
				"  - id: m1-t1",
				"    title: first task",
			].join("\n"),
			"utf8",
		);

		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(definition.name, definition);
			},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
				return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
			},
		};

		plannerWorkflowExtension(pi as never);
		const tool = tools.get("planner_apply_validation_profile");
		assert.ok(tool);

		const result = await tool.execute(
			"tool-apply-validation-profile",
			{
				specPath: path.relative(repoRoot, specPath),
				excludeKinds: ["build"],
				additionalCommands: [
					{ command: "npm run test:e2e", kind: "test", origin: "exploratory", label: "e2e smoke" },
				],
			},
			undefined,
			undefined,
			{
				cwd: repoRoot,
				ui: {
					notify() {},
				},
			} as never,
		) as {
			content: Array<{ type: string; text: string }>;
			details: {
				specPath: string;
				commandCount: number;
				validationCommands: Array<{ command: string; kind?: string; origin?: string; label?: string }>;
			};
		};

		assert.equal(result.details.specPath, specPath);
		assert.equal(result.details.commandCount, 3);
		assert.deepEqual(result.details.validationCommands, [
			{ command: "npm test", kind: "test", origin: "canonical" },
			{ command: "npx tsc --noEmit", kind: "typecheck", origin: "exploratory" },
			{ command: "npm run test:e2e", kind: "test", origin: "exploratory", label: "e2e smoke" },
		]);
		assert.ok(result.content[0]?.text.includes(`Applied validation profile to ${specPath}`));

		const spec = await fs.readFile(specPath, "utf8");
		assert.ok(spec.includes("validation:"));
		assert.ok(spec.includes("command: npm test"));
		assert.ok(!spec.includes("command: npm run build"));
		assert.ok(spec.includes("command: npx tsc --noEmit"));
		assert.ok(spec.includes("command: npm run test:e2e"));
	});
});

test("planner_finalize_plan verifies generated structure, repairs missing validation blocks, and activates the plan pointer", async () => {
	await withTempDir("planner-workflow-finalize-plan-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const planDir = path.join(root, "plans", "demo-plan");
		const milestoneDir = path.join(planDir, "milestones", "m1-alpha");
		await fs.mkdir(path.join(repoRoot, ".git", "info"), { recursive: true });
		await fs.mkdir(milestoneDir, { recursive: true });
		await fs.writeFile(
			path.join(repoRoot, "package.json"),
			JSON.stringify(
				{
					name: "demo",
					scripts: {
						test: "vitest run",
						build: "vite build",
					},
					devDependencies: {
						typescript: "^5.0.0",
					},
				},
				null,
				2,
			),
			"utf8",
		);
		await fs.writeFile(path.join(repoRoot, "package-lock.json"), "{}\n", "utf8");
		await fs.writeFile(path.join(repoRoot, "tsconfig.json"), "{}\n", "utf8");
		await fs.writeFile(path.join(planDir, "README.md"), "# Demo plan\n", "utf8");
		await fs.writeFile(
			path.join(planDir, "plan.yaml"),
			[
				"schema_version: 1",
				"repo:",
				"  root: null",
				"  default_branch: null",
				"milestones:",
				"  - id: m1",
				"    slug: alpha",
				"    path: milestones/m1-alpha/",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "spec.yaml"),
			[
				"goal: demo milestone",
				"tasks:",
				"  - id: m1-t1",
				"    title: first task",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: planned",
				"phase: not_started",
				"tasks:",
				"  - id: m1-t1",
				"    status: planned",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "milestone.md"), "# milestone\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(definition.name, definition);
			},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				if (JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])) {
					return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "remote", "get-url", "origin"])) {
					return { code: 0, stdout: "git@github.com:org/demo.git\n", stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD"])) {
					return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
		};

		plannerWorkflowExtension(pi as never);
		const tool = tools.get("planner_finalize_plan");
		assert.ok(tool);

		const result = await tool.execute(
			"tool-finalize-plan",
			{ planDir },
			undefined,
			undefined,
			{
				cwd: repoRoot,
				ui: {
					notify() {},
				},
			} as never,
		) as {
			content: Array<{ type: string; text: string }>;
			details: {
				pointerPath: string;
				ignoreStrategy: string;
				repairedValidationMilestoneIds: string[];
				patchedPlanRepoFields: string[];
			};
		};

		assert.equal(result.details.ignoreStrategy, "git-info-exclude");
		assert.deepEqual(result.details.repairedValidationMilestoneIds, ["m1"]);
		assert.ok(result.details.patchedPlanRepoFields.includes("repo.root"));
		assert.ok(result.content[0]?.text.includes(`Finalized generated plan at ${planDir}`));

		const pointer = await fs.readFile(path.join(repoRoot, ".pi", "active_plan"), "utf8");
		assert.equal(pointer.trim(), planDir);

		const exclude = await fs.readFile(path.join(repoRoot, ".git", "info", "exclude"), "utf8");
		assert.ok(exclude.includes(".pi/active_plan"));

		const spec = await fs.readFile(path.join(milestoneDir, "spec.yaml"), "utf8");
		assert.ok(spec.includes("validation:"));
		assert.ok(spec.includes("command: npm test"));
	});
});

test("planner_run_validation_profile blocks on canonical failures and logs advisory exploratory failures", async () => {
	await withTempDir("planner-workflow-run-validation-profile-", async (root) => {
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
				"    title: first task",
				"validation:",
				"  commands:",
				"    - command: npm test",
				"      kind: test",
				"      origin: canonical",
				"    - command: npx tsc --noEmit",
				"      kind: typecheck",
				"      origin: exploratory",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: hardening",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: done",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc123",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "milestone.md"), "# milestone\n", "utf8");

		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const notifications: Array<{ message: string; level: string }> = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(definition.name, definition);
			},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				if (command === "git") {
					if (JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])) {
						return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
					}
					if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"])) {
						return { code: 0, stdout: "feat/alpha\n", stderr: "" };
					}
					if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "remote", "get-url", "origin"])) {
						return { code: 1, stdout: "", stderr: "" };
					}
				}
				if (command === "bash") {
					if (JSON.stringify(args) === JSON.stringify(["-lc", "npm test"])) {
						return { code: 1, stdout: "", stderr: "tests failed" };
					}
					if (JSON.stringify(args) === JSON.stringify(["-lc", "npx tsc --noEmit"])) {
						return { code: 1, stdout: "", stderr: "type errors" };
					}
				}
				throw new Error(`unexpected exec: ${command} ${JSON.stringify(args)}`);
			},
		};

		plannerWorkflowExtension(pi as never);
		const tool = tools.get("planner_run_validation_profile");
		assert.ok(tool);

		const result = await tool.execute(
			"tool-run-validation-profile",
			{
				milestone: "m1",
				stage: "hardening",
				note: "Typecheck remains advisory for this milestone.",
			},
			undefined,
			undefined,
			{
				cwd: repoRoot,
				ui: {
					notify(message: string, level: string) {
						notifications.push({ message, level });
					},
				},
			} as never,
		) as {
			content: Array<{ type: string; text: string }>;
			details: {
				blocked: boolean;
				blockerPath?: string;
				blockingFailures: Array<{ command: string }>;
				advisoryFailures: Array<{ command: string }>;
				nextCommand?: string;
			};
		};

		assert.equal(notifications.filter((entry) => entry.level === "error").length, 0);
		assert.equal(result.details.blocked, true);
		assert.equal(result.details.nextCommand, "/resume_milestone m1");
		assert.deepEqual(result.details.blockingFailures.map((entry) => entry.command), ["npm test"]);
		assert.deepEqual(result.details.advisoryFailures.map((entry) => entry.command), ["npx tsc --noEmit"]);
		assert.ok(result.content[0]?.text.includes("Validation blocked milestone m1 during hardening."));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("hardening validation"));
		assert.ok(execution.includes("FAIL (blocking): `npm test` (test / canonical)"));
		assert.ok(execution.includes("FAIL (advisory): `npx tsc --noEmit` (typecheck / exploratory)"));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: blocked"));
		assert.ok(state.includes("stage: hardening_validation"));

		const blocker = await fs.readFile(path.join(milestoneDir, "blocker.md"), "utf8");
		assert.ok(blocker.includes("Recommended next command: /resume_milestone m1"));
		assert.ok(blocker.includes("Validation failed during hardening."));

		const resultArtifact = JSON.parse(await fs.readFile(path.join(milestoneDir, "milestone-result.json"), "utf8"));
		assert.equal(resultArtifact.status, "blocked");
		assert.equal(resultArtifact.stage, "hardening_validation");
	});
});

test("planner_run_validation_profile records advisory exploratory failures without blocking the milestone", async () => {
	await withTempDir("planner-workflow-run-validation-profile-advisory-", async (root) => {
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
				"    title: first task",
				"validation:",
				"  commands:",
				"    - command: npx tsc --noEmit",
				"      kind: typecheck",
				"      origin: exploratory",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: hardening",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: done",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc123",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const notifications: Array<{ message: string; level: string }> = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(definition.name, definition);
			},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				if (command === "git") {
					if (JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])) {
						return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
					}
					if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"])) {
						return { code: 0, stdout: "feat/alpha\n", stderr: "" };
					}
					if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "remote", "get-url", "origin"])) {
						return { code: 1, stdout: "", stderr: "" };
					}
				}
				if (command === "bash") {
					if (JSON.stringify(args) === JSON.stringify(["-lc", "npx tsc --noEmit"])) {
						return { code: 1, stdout: "", stderr: "type errors" };
					}
				}
				throw new Error(`unexpected exec: ${command} ${JSON.stringify(args)}`);
			},
		};

		plannerWorkflowExtension(pi as never);
		const tool = tools.get("planner_run_validation_profile");
		assert.ok(tool);

		const result = await tool.execute(
			"tool-run-validation-profile-advisory",
			{
				milestone: "m1",
				stage: "hardening",
				note: "Exploratory typecheck is advisory for this milestone.",
			},
			undefined,
			undefined,
			{
				cwd: repoRoot,
				ui: {
					notify(message: string, level: string) {
						notifications.push({ message, level });
					},
				},
			} as never,
		) as {
			content: Array<{ type: string; text: string }>;
			details: {
				blocked: boolean;
				blockingFailures: Array<{ command: string }>;
				advisoryFailures: Array<{ command: string }>;
				passed: Array<{ command: string }>;
			};
		};

		assert.equal(notifications.filter((entry) => entry.level === "error").length, 0);
		assert.equal(result.details.blocked, false);
		assert.deepEqual(result.details.blockingFailures, []);
		assert.deepEqual(result.details.advisoryFailures.map((entry) => entry.command), ["npx tsc --noEmit"]);
		assert.deepEqual(result.details.passed, []);
		assert.ok(result.content[0]?.text.includes("Completed hardening validation for milestone m1."));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("hardening validation"));
		assert.ok(execution.includes("FAIL (advisory): `npx tsc --noEmit` (typecheck / exploratory)"));
		assert.ok(execution.includes("Exploratory typecheck is advisory for this milestone."));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: in_progress"));
		assert.ok(state.includes("blocked_on: null"));
		await assert.rejects(fs.access(path.join(milestoneDir, "blocker.md")));
		await assert.rejects(fs.access(path.join(milestoneDir, "milestone-result.json")));
	});
});

test("tasker blocks natively on spec/state task drift and writes blocker artifacts", async () => {
	await withTempDir("planner-workflow-tasker-drift-", async (root) => {
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
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: started",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: null",
				"  step: not_started",
				"tasks:",
				"  - id: m1-t1",
				"    status: planned",
				"    commit: null",
				"  - id: m1-t2",
				"    status: planned",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			getCommands() {
				return [];
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

		assert.equal(sentMessages.length, 0);
		assert.ok(
			notifications.some(
				(entry) =>
					entry.level === "error" &&
					entry.message.includes("/tasker blocked at stage 'task_alignment'.") &&
					entry.message.includes("Recommended next command: /replanner m1"),
			),
			"expected native tasker plan-defect blocker notification",
		);

		const blocker = await fs.readFile(path.join(milestoneDir, "blocker.md"), "utf8");
		assert.ok(blocker.includes("Blocker type: plan_defect"));
		assert.ok(blocker.includes("Recommended next command: /replanner m1"));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: blocked"));
		assert.ok(state.includes("stage: task_alignment"));

		const result = JSON.parse(await fs.readFile(path.join(milestoneDir, "milestone-result.json"), "utf8"));
		assert.equal(result.status, "blocked");
		assert.equal(result.blockerType, "plan_defect");
	});
});

test("tasker blocks natively when non-TDD execution_mode is missing its explicit rationale", async () => {
	await withTempDir("planner-workflow-tasker-mode-defect-", async (root) => {
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
				"    title: docs task",
				"    execution_mode: docs_only",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: started",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: null",
				"  step: not_started",
				"tasks:",
				"  - id: m1-t1",
				"    status: planned",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			getCommands() {
				return [];
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

		assert.equal(sentMessages.length, 0);
		assert.ok(
			notifications.some(
				(entry) =>
					entry.level === "error" &&
					entry.message.includes("/tasker blocked at stage 'task_contract'.") &&
					entry.message.includes("execution_mode 'docs_only'") &&
					entry.message.includes("missing execution_mode_reason") &&
					entry.message.includes("Recommended next command: /replanner m1"),
			),
			"expected native tasker execution-mode defect blocker notification",
		);

		const blocker = await fs.readFile(path.join(milestoneDir, "blocker.md"), "utf8");
		assert.ok(blocker.includes("Blocker type: plan_defect"));
		assert.ok(blocker.includes("missing execution_mode_reason"));

		const result = JSON.parse(await fs.readFile(path.join(milestoneDir, "milestone-result.json"), "utf8"));
		assert.equal(result.status, "blocked");
		assert.equal(result.stage, "task_contract");
		assert.equal(result.blockerType, "plan_defect");
	});
});

test("tasker runs natively, updates state/evidence, and dispatches a generated task brief", async () => {
	await withTempDir("planner-workflow-tasker-native-", async (root) => {
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
				"    title: first task",
				"    execution_mode: docs_only",
				"    execution_mode_reason: Documentation-only task with no meaningful red/green cycle.",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: started",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: null",
				"  step: not_started",
				"tasks:",
				"  - id: m1-t1",
				"    status: planned",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "milestone.md"), "# milestone\n", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const execCalls: string[][] = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			getCommands() {
				return [];
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
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
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

		assert.equal(
			notifications.filter((entry) => entry.level === "error").length,
			0,
			"expected native tasker kickoff to avoid wrapper-level errors",
		);
		assert.ok(
			execCalls.some(
				(args) =>
					JSON.stringify(args) ===
					JSON.stringify(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]),
			),
			"expected tasker to verify the milestone branch natively",
		);
		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0].includes("Continue the native /tasker workflow for task `m1-t1`."));
		assert.ok(sentMessages[0].includes("Execution mode: `docs_only`"));
		assert.ok(sentMessages[0].includes("Documentation-only task with no meaningful red/green cycle."));
		assert.ok(sentMessages[0].includes("Completion gate: checkpoint must reach `implementation_started` before final task completion."));
		assert.ok(sentMessages[0].includes("Native state already set:"));
		assert.ok(sentMessages[0].includes("task `m1-t1` status: `in_progress`"));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("phase: task_execution"));
		assert.ok(state.includes("status: in_progress"));
		assert.ok(state.includes("task_id: m1-t1"));
		assert.ok(state.includes("step: not_started"));
		assert.ok(state.includes("execution_mode: docs_only"));
		assert.ok(state.includes("execution_mode_reason: Documentation-only task with no meaningful red/green cycle."));
		assert.ok(state.includes("- id: m1-t1\n    status: in_progress"));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("task `m1-t1` started"));
		assert.ok(execution.includes("Execution mode: `docs_only`"));
		assert.ok(execution.includes("Native checkpoint set"));
	});
});

test("tasker re-entry preserves checkpoint state and does not append duplicate start evidence", async () => {
	await withTempDir("planner-workflow-tasker-rerun-", async (root) => {
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
				"    title: first task",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: tests_red_verified",
				"tasks:",
				"  - id: m1-t1",
				"    status: in_progress",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "execution.md"),
			[
				"# execution",
				"",
				"## 2026-03-08T15:50:00.000Z — task `m1-t1` started",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "milestone.md"), "# milestone\n", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
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
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
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

		assert.equal(
			notifications.filter((entry) => entry.level === "error").length,
			0,
			"expected tasker re-entry to avoid wrapper-level errors",
		);
		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0].includes("step: tests_red_verified"));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("task_id: m1-t1"));
		assert.ok(state.includes("step: tests_red_verified"));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.equal(execution.match(/task `m1-t1` started/g)?.length ?? 0, 1);
	});
});

test("milestoner starts a planned milestone and kicks off the first ordered task natively", async () => {
	await withTempDir("planner-workflow-milestoner-native-start-", async (root) => {
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
				"    title: first task",
				"  - id: m1-t2",
				"    title: second task",
				"    depends_on:",
				"      - m1-t1",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: planned",
				"phase: not_started",
				"branch: null",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: null",
				"  step: not_started",
				"tasks:",
				"  - id: m1-t1",
				"    status: planned",
				"    commit: null",
				"  - id: m1-t2",
				"    status: planned",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "milestone.md"), "# milestone\n", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const execCalls: string[][] = [];
		let currentBranch = "main";

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			getCommands() {
				return [];
			},
			getAllTools() {
				return [{ name: "prepare_review" }];
			},
			getActiveTools() {
				return ["prepare_review"];
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
					return { code: 0, stdout: `${currentBranch}\n`, stderr: "" };
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
				if (
					args[0] === "-C" &&
					args[1] === repoRoot &&
					args[2] === "show-ref" &&
					args[3] === "--verify" &&
					args[4] === "--quiet" &&
					args[5] === "refs/heads/feat/alpha"
				) {
					return { code: 1, stdout: "", stderr: "" };
				}
				if (
					args[0] === "-C" &&
					args[1] === repoRoot &&
					args[2] === "switch" &&
					args[3] === "-c" &&
					args[4] === "feat/alpha"
				) {
					currentBranch = "feat/alpha";
					return { code: 0, stdout: "Switched\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const milestoner = commands.get("milestoner");
		assert.ok(milestoner);

		await milestoner.handler("m1", {
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

		assert.equal(
			notifications.filter((entry) => entry.level === "error").length,
			0,
			"expected milestoner native kickoff to avoid wrapper-level errors",
		);
		assert.ok(
			notifications.some(
				(entry) =>
					entry.level === "info" &&
					entry.message.includes("Started milestone m1 (alpha).") &&
					entry.message.includes("Branch: feat/alpha") &&
					entry.message.includes("Next: continuing under /milestoner m1"),
			),
			"expected milestone_start summary during native milestoner orchestration",
		);
		assert.ok(
			execCalls.some(
				(args) =>
					JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "switch", "-c", "feat/alpha"]),
			),
			"expected milestoner to create the milestone branch natively",
		);
		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0].includes("Continue the native /milestoner workflow for milestone `m1` / `alpha`. Current task: `m1-t1`."));
		assert.ok(sentMessages[0].includes("Do not redirect the user to run /tasker manually"));
		assert.ok(sentMessages[0].includes("`planner_continue_milestoner`"));
		assert.ok(sentMessages[0].includes("stage: \"task_execution\""));
		assert.ok(!sentMessages[0].includes("m1-t2"), "expected topological ordering to pick the first ready task");

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("branch: feat/alpha"));
		assert.ok(state.includes("phase: task_execution"));
		assert.ok(state.includes("task_id: m1-t1"));
		assert.ok(state.includes("- id: m1-t1\n    status: in_progress"));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("milestone start"));
		assert.ok(execution.includes("task `m1-t1` started"));
	});
});

test("milestoner runs milestone_harden natively after tasks are complete", async () => {
	await withTempDir("planner-workflow-milestoner-harden-", async (root) => {
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
				"    title: first task",
				"validation:",
				"  commands:",
				"    - command: npm test",
				"      kind: test",
				"      origin: canonical",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: done",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc123",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const execCalls: string[][] = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool() {},
			getCommands() {
				return [];
			},
			getAllTools() {
				return [{ name: "prepare_review" }];
			},
			getActiveTools() {
				return ["prepare_review"];
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
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const milestoner = commands.get("milestoner");
		assert.ok(milestoner);

		await milestoner.handler("m1", {
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

		assert.equal(
			notifications.filter((entry) => entry.level === "error").length,
			0,
			"expected milestoner to advance cleanly into hardening",
		);
		assert.ok(
			execCalls.some(
				(args) =>
					JSON.stringify(args) ===
					JSON.stringify(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]),
			),
			"expected native hardening to verify the milestone branch",
		);
		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0].includes("Continue the native /milestone_harden workflow"));
		assert.ok(sentMessages[0].includes("`planner_run_validation_profile`"));
		assert.ok(sentMessages[0].includes("`planner_append_execution_section`"));
		assert.ok(sentMessages[0].includes("`planner_continue_milestoner`"));
		assert.ok(sentMessages[0].includes("stage: \"hardening\""));
		assert.ok(sentMessages[0].includes("`npm test` (test / canonical)"));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("phase: hardening"));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("milestone hardening started"));
	});
});

test("milestoner blocks natively on cyclic task dependencies and writes blocker artifacts", async () => {
	await withTempDir("planner-workflow-milestoner-cycle-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const planRoot = path.join(root, "plans", "demo-plan");
		const milestoneDir = path.join(planRoot, "milestones", "m1-alpha");
		const promptPath = path.join(root, "milestoner.md");
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
				"    depends_on:",
				"      - m1-t2",
				"  - id: m1-t2",
				"    title: second",
				"    depends_on:",
				"      - m1-t1",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: planned",
				"phase: not_started",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"tasks:",
				"  - id: m1-t1",
				"    status: planned",
				"    commit: null",
				"  - id: m1-t2",
				"    status: planned",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(promptPath, "Run milestoner $1", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			getCommands() {
				return [{ source: "prompt", name: "milestoner", path: promptPath }];
			},
			getAllTools() {
				return [{ name: "prepare_review" }];
			},
			getActiveTools() {
				return ["prepare_review"];
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
		const milestoner = commands.get("milestoner");
		assert.ok(milestoner);

		await milestoner.handler("m1", {
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
					entry.message.includes("blocked at stage 'task_ordering'") &&
					entry.message.includes("Recommended next command: /replanner m1"),
			),
			"expected native milestoner cycle blocker notification",
		);

		const blocker = await fs.readFile(path.join(milestoneDir, "blocker.md"), "utf8");
		assert.ok(blocker.includes("Blocker type: plan_defect"));
		assert.ok(blocker.includes("Cycle-involved tasks: m1-t1, m1-t2"));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: blocked"));
		assert.ok(state.includes("stage: task_ordering"));

		const result = JSON.parse(
			await fs.readFile(path.join(milestoneDir, "milestone-result.json"), "utf8"),
		);
		assert.equal(result.status, "blocked");
		assert.equal(result.blockerType, "plan_defect");
		assert.equal(result.nextCommand, "/replanner m1");
	});
});

test("milestoner stops immediately when the milestone is already blocked", async () => {
	await withTempDir("planner-workflow-milestoner-blocked-", async (root) => {
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
				"    title: first task",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: blocked",
				"phase: task_execution",
				"blocked_at: 2026-03-08T18:00:00.000Z",
				"updated_at: 2026-03-08T18:00:00.000Z",
				"blocked_on:",
				"  type: test_failure",
				"  stage: task_execution",
				"  reason: Narrow tests are still red.",
				"  recommended_next_command: /resume_milestone m1",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: tests_written",
				"tasks:",
				"  - id: m1-t1",
				"    status: blocked",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "blocker.md"), "# Blocker\n", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const execCalls: string[][] = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool() {},
			getCommands() {
				return [];
			},
			getAllTools() {
				return [{ name: "prepare_review" }];
			},
			getActiveTools() {
				return ["prepare_review"];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				execCalls.push(args);
				assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
				return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const milestoner = commands.get("milestoner");
		assert.ok(milestoner);

		await milestoner.handler("m1", {
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

		assert.equal(execCalls.length, 1);
		assert.equal(sentMessages.length, 0);
		assert.ok(
			notifications.some(
				(entry) =>
					entry.level === "error" &&
					entry.message.includes("/milestoner cannot continue because milestone 'm1' is currently blocked.") &&
					entry.message.includes("Blocker type: test_failure") &&
					entry.message.includes("Recommended next command: /resume_milestone m1"),
			),
			"expected milestoner to stop at the active blocker",
		);
	});
});

test("milestoner blocks native orchestration defects when multiple tasks are already in progress", async () => {
	await withTempDir("planner-workflow-milestoner-multi-active-", async (root) => {
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
				"  - id: m1-t0",
				"    title: completed task",
				"  - id: m1-t1",
				"    title: first active task",
				"  - id: m1-t2",
				"    title: second active task",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: implementation_started",
				"tasks:",
				"  - id: m1-t0",
				"    status: done",
				"    commit: abc1234",
				"  - id: m1-t1",
				"    status: in_progress",
				"    commit: null",
				"  - id: m1-t2",
				"    status: in_progress",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const execCalls: string[][] = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool() {},
			getCommands() {
				return [];
			},
			getAllTools() {
				return [{ name: "prepare_review" }];
			},
			getActiveTools() {
				return ["prepare_review"];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				execCalls.push(args);
				assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
				return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const milestoner = commands.get("milestoner");
		assert.ok(milestoner);

		await milestoner.handler("m1", {
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

		assert.equal(execCalls.length, 1);
		assert.equal(sentMessages.length, 0);
		assert.ok(
			notifications.some(
				(entry) =>
					entry.level === "error" &&
					entry.message.includes("blocked at stage 'task_execution'") &&
					entry.message.includes("Multiple tasks are marked in_progress simultaneously: m1-t1, m1-t2") &&
					entry.message.includes("Recommended next command: /replanner m1"),
			),
			"expected native milestoner to block multiple active tasks as a plan defect",
		);

		const blocker = await fs.readFile(path.join(milestoneDir, "blocker.md"), "utf8");
		assert.ok(blocker.includes("Blocker type: plan_defect"));
		assert.ok(blocker.includes("Multiple tasks are marked in_progress simultaneously: m1-t1, m1-t2"));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: blocked"));
		assert.ok(state.includes("stage: task_execution"));
		assert.ok(state.includes("recommended_next_command: /replanner m1"));

		const result = JSON.parse(await fs.readFile(path.join(milestoneDir, "milestone-result.json"), "utf8"));
		assert.equal(result.status, "blocked");
		assert.equal(result.stage, "task_execution");
		assert.equal(result.blockerType, "plan_defect");
		assert.equal(result.nextCommand, "/replanner m1");
		assert.deepEqual(result.commitShas, ["abc1234"]);
	});
});

test("planner task tools apply checkpoint/completion updates and append execution evidence", async () => {
	await withTempDir("planner-workflow-tools-task-", async (root) => {
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
				"    title: first task",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: not_started",
				"tasks:",
				"  - id: m1-t1",
				"    status: in_progress",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const toolNotifications: Array<{ message: string; level: string }> = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(definition.name, definition);
			},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				if (JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])) {
					return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"])) {
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "rev-parse", "--verify", "abc1234^{commit}"])) {
					return { code: 0, stdout: "abc1234\n", stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "merge-base", "--is-ancestor", "abc1234", "HEAD"])) {
					return { code: 0, stdout: "", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
		};

		plannerWorkflowExtension(pi as never);
		const checkpointTool = tools.get("planner_task_checkpoint");
		const evidenceTool = tools.get("planner_append_execution_section");
		const completeTool = tools.get("planner_complete_task");
		const finalizeTool = tools.get("planner_finalize_task_outcome");
		assert.ok(checkpointTool);
		assert.ok(evidenceTool);
		assert.ok(completeTool);
		assert.ok(finalizeTool);

		const toolCtx = {
			cwd: repoRoot,
			ui: {
				notify(message: string, level: string) {
					toolNotifications.push({ message, level });
				},
			},
		};

		await checkpointTool.execute("tool-1", {
			taskId: "m1-t1",
			step: "tests_green_verified",
		}, undefined, undefined, toolCtx as never);
		await evidenceTool.execute("tool-2", {
			milestone: "m1",
			title: "task progress",
			body: "- Narrow tests are green",
		}, undefined, undefined, toolCtx as never);
		await completeTool.execute("tool-3", {
			taskId: "m1-t1",
			commitSha: "abc1234",
		}, undefined, undefined, toolCtx as never);

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("step: done"));
		assert.ok(state.includes("last_completed_task: m1-t1"));
		assert.ok(state.includes("commit: abc1234"));
		assert.ok(state.includes("status: done"));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("task progress"));
		assert.ok(execution.includes("Narrow tests are green"));
		assert.ok(
			toolNotifications.some(
				(entry) =>
					entry.level === "warning" &&
					entry.message.includes("planner_complete_task is a low-level recovery tool"),
			),
			"expected planner_complete_task to warn that planner_finalize_task_outcome is preferred",
		);
	});
});

test("planner_block_milestone warns when used for routine task-execution blocking", async () => {
	await withTempDir("planner-workflow-tool-block-warning-", async (root) => {
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
		await fs.writeFile(path.join(milestoneDir, "spec.yaml"), "tasks:\n  - id: m1-t1\n", "utf8");
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"tasks:",
				"  - id: m1-t1",
				"    status: in_progress",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const toolNotifications: Array<{ message: string; level: string }> = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(definition.name, definition);
			},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
				return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
			},
		};

		plannerWorkflowExtension(pi as never);
		const blockTool = tools.get("planner_block_milestone");
		assert.ok(blockTool);

		await blockTool.execute(
			"tool-block-warning",
			{
				milestone: "m1",
				stage: "task_execution",
				blockerType: "test_failure",
				taskId: "m1-t1",
				reason: "Narrow tests remain red.",
			},
			undefined,
			undefined,
			{
				cwd: repoRoot,
				ui: {
					notify(message: string, level: string) {
						toolNotifications.push({ message, level });
					},
				},
			} as never,
		);

		assert.ok(
			toolNotifications.some(
				(entry) =>
					entry.level === "warning" &&
					entry.message.includes("planner_block_milestone is a low-level recovery tool") &&
					entry.message.includes("planner_finalize_task_outcome"),
			),
			"expected planner_block_milestone to warn when used for routine task blocking",
		);
	});
});

test("planner_continue_milestoner queues the next task as a follow-up after successful task completion", async () => {
	await withTempDir("planner-workflow-tool-continue-milestoner-task-", async (root) => {
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
				"    title: first task",
				"  - id: m1-t2",
				"    title: second task",
				"    depends_on:",
				"      - m1-t1",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: done",
				"last_completed_task: m1-t1",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc1234",
				"  - id: m1-t2",
				"    status: planned",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "milestone.md"), "# milestone\n", "utf8");

		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const sentMessages: Array<{ message: string; options?: { deliverAs?: string } }> = [];
		const notifications: Array<{ message: string; level: string }> = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(definition.name, definition);
			},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				if (JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])) {
					return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"])) {
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
			sendUserMessage(message: string, options?: { deliverAs?: string }) {
				sentMessages.push({ message, options });
			},
		};

		plannerWorkflowExtension(pi as never);
		const continueTool = tools.get("planner_continue_milestoner");
		assert.ok(continueTool);

		await continueTool.execute(
			"tool-continue-milestoner",
			{
				milestone: "m1",
				stage: "task_execution",
			},
			undefined,
			undefined,
			{
				cwd: repoRoot,
				ui: {
					notify(message: string, level: string) {
						notifications.push({ message, level });
					},
				},
			} as never,
		);

		assert.equal(sentMessages.length, 1);
		assert.equal(sentMessages[0].options?.deliverAs, "followUp");
		assert.ok(sentMessages[0].message.includes("Current task: `m1-t2`"));
		assert.ok(sentMessages[0].message.includes("`planner_continue_milestoner`"));
		assert.ok(sentMessages[0].message.includes("stage: \"task_execution\""));
		assert.ok(
			notifications.some(
				(entry) => entry.level === "info" && entry.message.includes("Queued validated /milestoner workflow as follow-up."),
			),
			"expected continuation tool to queue the next milestoner step as a follow-up",
		);

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("task_id: m1-t2"));
		assert.ok(state.includes("step: not_started"));
		assert.ok(state.includes("- id: m1-t2\n    status: in_progress"));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("task `m1-t2` started"));
	});
});

test("planner_finalize_task_outcome rejects commits that are not reachable from the current milestone branch", async () => {
	await withTempDir("planner-workflow-tool-finalize-task-commit-check-", async (root) => {
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
				"    title: first task",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: tests_green_verified",
				"tasks:",
				"  - id: m1-t1",
				"    status: in_progress",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(definition.name, definition);
			},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				if (JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])) {
					return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"])) {
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "rev-parse", "--verify", "deadbee^{commit}"])) {
					return { code: 0, stdout: "deadbee\n", stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "merge-base", "--is-ancestor", "deadbee", "HEAD"])) {
					return { code: 1, stdout: "", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
		};

		plannerWorkflowExtension(pi as never);
		const finalizeTool = tools.get("planner_finalize_task_outcome");
		assert.ok(finalizeTool);

		await assert.rejects(
			finalizeTool.execute(
				"tool-finalize-task-commit-check",
				{
					taskId: "m1-t1",
					outcome: "done",
					commitSha: "deadbee",
					summary: "Tried to record a commit that is not on the milestone branch.",
				},
				undefined,
				undefined,
				{
					cwd: repoRoot,
					ui: {
						notify() {},
					},
				} as never,
			),
			/not reachable from the current milestone branch/,
		);

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: in_progress"));
		assert.ok(state.includes("step: tests_green_verified"));
		assert.ok(state.includes("commit: null"));
	});
});

test("planner_finalize_task_outcome atomically records a successful task outcome", async () => {
	await withTempDir("planner-workflow-tool-finalize-task-done-", async (root) => {
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
				"    title: first task",
				"    execution_mode: docs_only",
				"    execution_mode_reason: Documentation-only task with no meaningful red/green cycle.",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: implementation_started",
				"  execution_mode: docs_only",
				"  execution_mode_reason: Documentation-only task with no meaningful red/green cycle.",
				"tasks:",
				"  - id: m1-t1",
				"    status: in_progress",
				"    execution_mode: docs_only",
				"    execution_mode_reason: Documentation-only task with no meaningful red/green cycle.",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(definition.name, definition);
			},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				if (JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])) {
					return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"])) {
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "rev-parse", "--verify", "abc1234^{commit}"])) {
					return { code: 0, stdout: "abc1234\n", stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "merge-base", "--is-ancestor", "abc1234", "HEAD"])) {
					return { code: 0, stdout: "", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
		};

		plannerWorkflowExtension(pi as never);
		const finalizeTool = tools.get("planner_finalize_task_outcome");
		assert.ok(finalizeTool);

		const result = await finalizeTool.execute(
			"tool-finalize-task-done",
			{
				taskId: "m1-t1",
				outcome: "done",
				commitSha: "abc1234",
				summary: "Updated the milestone documentation set and confirmed the task commit.",
			},
			undefined,
			undefined,
			{
				cwd: repoRoot,
				ui: {
					notify() {},
				},
			} as never,
		) as { content: Array<{ text: string }>; details: { outcome: string; commitSha: string } };

		assert.equal(result.details.outcome, "done");
		assert.equal(result.details.commitSha, "abc1234");
		assert.ok(result.content[0]?.text.includes("Finalized task m1-t1 as done."));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("step: done"));
		assert.ok(state.includes("last_completed_task: m1-t1"));
		assert.ok(state.includes("commit: abc1234"));
		assert.ok(state.includes("status: done"));
		assert.ok(state.includes("execution_mode: docs_only"));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("task `m1-t1` completed"));
		assert.ok(execution.includes("Execution mode: `docs_only`"));
		assert.ok(execution.includes("Documentation-only task with no meaningful red/green cycle."));
		assert.ok(execution.includes("Outcome: `done`"));
		assert.ok(execution.includes("Commit: `abc1234`"));
		assert.ok(execution.includes("Updated the milestone documentation set"));
	});
});

test("planner_finalize_task_outcome atomically records a blocked task outcome", async () => {
	await withTempDir("planner-workflow-tool-finalize-task-blocked-", async (root) => {
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
				"    title: first task",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: implementation_started",
				"tasks:",
				"  - id: m1-t1",
				"    status: in_progress",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(definition.name, definition);
			},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				if (JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])) {
					return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
				}
				if (JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"])) {
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
		};

		plannerWorkflowExtension(pi as never);
		const finalizeTool = tools.get("planner_finalize_task_outcome");
		assert.ok(finalizeTool);

		const result = await finalizeTool.execute(
			"tool-finalize-task-blocked",
			{
				taskId: "m1-t1",
				outcome: "blocked",
				blockerType: "test_failure",
				summary: "Narrow tests remain red after implementation attempt.",
			},
			undefined,
			undefined,
			{
				cwd: repoRoot,
				ui: {
					notify() {},
				},
			} as never,
		) as { content: Array<{ text: string }>; details: { outcome: string; blockerType: string; recommendedNextCommand: string } };

		assert.equal(result.details.outcome, "blocked");
		assert.equal(result.details.blockerType, "test_failure");
		assert.equal(result.details.recommendedNextCommand, "/resume_milestone m1");
		assert.ok(result.content[0]?.text.includes("Finalized task m1-t1 as blocked."));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: blocked"));
		assert.ok(state.includes("stage: task_execution"));
		assert.ok(state.includes("type: test_failure"));
		assert.ok(state.includes("status: blocked"));

		const blocker = await fs.readFile(path.join(milestoneDir, "blocker.md"), "utf8");
		assert.ok(blocker.includes("Blocker type: test_failure"));
		assert.ok(blocker.includes("Recommended next command: /resume_milestone m1"));
		assert.ok(blocker.includes("Narrow tests remain red after implementation attempt."));

		const resultArtifact = JSON.parse(await fs.readFile(path.join(milestoneDir, "milestone-result.json"), "utf8"));
		assert.equal(resultArtifact.status, "blocked");
		assert.equal(resultArtifact.stage, "task_execution");
		assert.equal(resultArtifact.blockerType, "test_failure");
		assert.equal(resultArtifact.nextCommand, "/resume_milestone m1");

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("task `m1-t1` blocked"));
		assert.ok(execution.includes("Outcome: `blocked`"));
		assert.ok(execution.includes("Blocker type: `test_failure`"));
		assert.ok(execution.includes("Recommended next command: `/resume_milestone m1`"));
	});
});

test("milestone_start runs natively, ignores untracked files during preflight, and updates state/evidence", async () => {
	await withTempDir("planner-workflow-milestone-start-untracked-", async (root) => {
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
		await fs.writeFile(path.join(milestoneDir, "spec.yaml"), "tasks:\n  - id: m1-t1\n", "utf8");
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: planned",
				"phase: not_started",
				"branch: null",
				"started_at: null",
				"updated_at: null",
				"checkpoint:",
				"  task_id: null",
				"  step: not_started",
				"tasks:",
				"  - id: m1-t1",
				"    status: planned",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const execCalls: string[][] = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			getCommands() {
				return [];
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
				if (
					args[0] === "-C" &&
					args[1] === repoRoot &&
					args[2] === "show-ref" &&
					args[3] === "--verify" &&
					args[4] === "--quiet" &&
					args[5] === "refs/heads/feat/alpha"
				) {
					return { code: 1, stdout: "", stderr: "" };
				}
				if (
					args[0] === "-C" &&
					args[1] === repoRoot &&
					args[2] === "switch" &&
					args[3] === "-c" &&
					args[4] === "feat/alpha"
				) {
					return { code: 0, stdout: "Switched\n", stderr: "" };
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

		assert.equal(sentMessages.length, 0);
		assert.ok(
			execCalls.some(
				(args) =>
					JSON.stringify(args) ===
					JSON.stringify(["-C", repoRoot, "status", "--porcelain", "--untracked-files=no"]),
			),
			"expected milestone_start preflight to ignore untracked files",
		);
		assert.ok(
			execCalls.some(
				(args) =>
					JSON.stringify(args) ===
					JSON.stringify(["-C", repoRoot, "switch", "-c", "feat/alpha"]),
			),
			"expected milestone_start to create and switch branch natively",
		);
		assert.equal(
			notifications.filter((entry) => entry.level === "error").length,
			0,
			"expected milestone_start to proceed when only untracked files exist",
		);
		assert.ok(
			notifications.some(
				(entry) =>
					entry.level === "info" &&
					entry.message.includes("Started milestone m1 (alpha).") &&
					entry.message.includes("Branch: feat/alpha"),
			),
			"expected native milestone_start summary notification",
		);

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: in_progress"));
		assert.ok(state.includes("phase: started"));
		assert.ok(state.includes("branch: feat/alpha"));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("milestone start"));
		assert.ok(execution.includes("Created branch: `feat/alpha`"));
	});
});

test("milestone_start validates milestone state before creating a branch", async () => {
	await withTempDir("planner-workflow-milestone-start-invalid-state-", async (root) => {
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
		await fs.writeFile(path.join(milestoneDir, "spec.yaml"), "tasks:\n  - id: m1-t1\n", "utf8");
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: started",
				"branch: feat/alpha",
				"tasks:",
				"  - id: m1-t1",
				"    status: planned",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const execCalls: string[][] = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			getCommands() {
				return [];
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
			sendUserMessage() {},
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

		assert.ok(
			notifications.some(
				(entry) => entry.level === "error" && entry.message.includes("invalid milestone status transition 'in_progress' -> 'in_progress'"),
			),
			"expected milestone_start to fail before creating a branch when the milestone is already started",
		);
		assert.ok(
			!execCalls.some(
				(args) => JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "switch", "-c", "feat/alpha"]),
			),
			"expected milestone_start to avoid branch creation when prevalidation fails",
		);
	});
});

test("milestone_start runs plan-defect preflight before creating a branch", async () => {
	await withTempDir("planner-workflow-milestone-start-plan-defect-", async (root) => {
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
		await fs.writeFile(path.join(milestoneDir, "spec.yaml"), "tasks:\n  - id: m1-t1\n", "utf8");
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: planned",
				"phase: not_started",
				"tasks:",
				"  - id: m1-t2",
				"    status: planned",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");

		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const execCalls: string[][] = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			getCommands() {
				return [];
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
			sendUserMessage() {},
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

		assert.ok(
			notifications.some(
				(entry) => entry.level === "error" && entry.message.includes("spec.yaml.tasks and state.yaml.tasks are out of sync."),
			),
			"expected milestone_start to stop on plan defects before creating a branch",
		);
		assert.ok(
			!execCalls.some(
				(args) => JSON.stringify(args) === JSON.stringify(["-C", repoRoot, "switch", "-c", "feat/alpha"]),
			),
			"expected no branch creation when milestone_start plan-defect preflight fails",
		);
	});
});

test("milestone_review runs natively, advances phase, and dispatches a prepared branch review packet", async () => {
	await withTempDir("planner-workflow-milestone-review-native-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const planRoot = path.join(root, "plans", "demo-plan");
		const milestoneDir = path.join(planRoot, "milestones", "m1-alpha");
		const reviewPromptPath = path.join(root, "review-correctness.md");
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
				"    title: first task",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: hardening",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: done",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc123",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(
			reviewPromptPath,
			[
				"---",
				"description: correctness review",
				"---",
				"Review the code for correctness.",
			].join("\n"),
			"utf8",
		);

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const execCalls: string[][] = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool() {},
			getCommands() {
				return [{ source: "prompt", name: "review-correctness", path: reviewPromptPath }];
			},
			getAllTools() {
				return [{ name: "prepare_review" }];
			},
			getActiveTools() {
				return ["prepare_review"];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				execCalls.push(args);
				if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
					return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
				}
				if (
					(args[0] === "-C" &&
						args[1] === repoRoot &&
						args[2] === "rev-parse" &&
						args[3] === "--abbrev-ref" &&
						args[4] === "HEAD") ||
					(args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD")
				) {
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "main") {
					return { code: 0, stdout: "main\n", stderr: "" };
				}
				if (args[0] === "diff" && args[1] === "main...feat/alpha") {
					return {
						code: 0,
						stdout: "diff --git a/file.ts b/file.ts\n+const value = 1;\n",
						stderr: "",
					};
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

		assert.equal(
			notifications.filter((entry) => entry.level === "error").length,
			0,
			"expected native milestone_review kickoff to avoid wrapper-level errors",
		);
		assert.ok(
			execCalls.some(
				(args) =>
					JSON.stringify(args) === JSON.stringify(["diff", "main...feat/alpha"]),
			),
			"expected milestone_review to prepare a deterministic branch diff",
		);
		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0].includes("Continue the native /milestone_review workflow"));
		assert.ok(sentMessages[0].includes("`planner_run_validation_profile`"));
		assert.ok(sentMessages[0].includes("Please review the following changes."));
		assert.ok(sentMessages[0].includes("review.md"));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("phase: review"));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("milestone review started"));
		assert.ok(execution.includes("Review output path"));
	});
});

test("milestone_finish runs natively, finalizes state, and writes a completion result artifact", async () => {
	await withTempDir("planner-workflow-milestone-finish-native-", async (root) => {
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
				"    title: first task",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: review",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"completed_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: done",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc1234",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "execution.md"),
			[
				"# execution",
				"",
				"- Previous commit: `abc1234`",
				"- Duplicate previous commit: `ABC1234`",
				"- Review fix commit: `def4567`",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "review.md"),
			[
				"# Review",
				"",
				"### High / medium fixed",
				"",
				"1. **Medium** issue fixed in commit `def4567`.",
				"2. Duplicate note references `DEF4567` again.",
			].join("\n"),
			"utf8",
		);

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const execCalls: string[][] = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool() {},
			getCommands() {
				return [];
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
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const milestoneFinish = commands.get("milestone_finish");
		assert.ok(milestoneFinish);

		await milestoneFinish.handler("m1", {
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
		assert.equal(
			notifications.filter((entry) => entry.level === "error").length,
			0,
			"expected native milestone_finish to avoid wrapper-level errors",
		);
		assert.ok(
			execCalls.some(
				(args) =>
					JSON.stringify(args) ===
					JSON.stringify(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]),
			),
			"expected milestone_finish to verify the milestone branch",
		);
		assert.ok(
			notifications.some(
				(entry) => entry.level === "info" && entry.message.includes("Finished milestone m1 (alpha)."),
			),
			"expected native milestone_finish summary notification",
		);

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: done"));
		assert.ok(state.includes("phase: finished"));
		assert.match(state, /completed_at: 20/);

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("milestone finish"));
		assert.ok(execution.includes("Review evidence"));
		assert.ok(execution.includes("abc1234"));
		assert.ok(execution.includes("def4567"));

		const result = JSON.parse(await fs.readFile(path.join(milestoneDir, "milestone-result.json"), "utf8"));
		assert.equal(result.milestoneId, "m1");
		assert.equal(result.milestoneSlug, "alpha");
		assert.equal(result.status, "completed");
		assert.equal(result.stage, "finished");
		assert.deepEqual(result.commitShas, ["abc1234", "def4567"]);
	});
});

test("milestoner finishes a review-phase milestone natively", async () => {
	await withTempDir("planner-workflow-milestoner-finish-", async (root) => {
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
				"    title: first task",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: review",
				"branch: feat/alpha",
				"blocked_at: null",
				"updated_at: null",
				"completed_at: null",
				"blocked_on: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: done",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc123",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n- Task commit: `abc123`\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "review.md"), "# Review\n\n### High / medium fixed\n", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool() {},
			getCommands() {
				return [];
			},
			getAllTools() {
				return [{ name: "prepare_review" }];
			},
			getActiveTools() {
				return ["prepare_review"];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
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
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const milestoner = commands.get("milestoner");
		assert.ok(milestoner);

		await milestoner.handler("m1", {
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
				(entry) => entry.level === "info" && entry.message.includes("Finished milestone m1 (alpha)."),
			),
			"expected milestoner to finish natively instead of dispatching milestone_finish prompt",
		);
	});
});

test("resume_milestone resumes a blocked task checkpoint natively and archives blocker evidence", async () => {
	await withTempDir("planner-workflow-resume-native-", async (root) => {
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
				"    title: first task",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: blocked",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_at: 2026-03-08T16:00:00.000Z",
				"updated_at: 2026-03-08T16:00:00.000Z",
				"unblocked_at: null",
				"blocked_on:",
				"  type: test_failure",
				"  stage: task_execution",
				"  reason: narrow test failed unexpectedly",
				"  task_id: m1-t1",
				"  recommended_next_command: /resume_milestone m1",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: tests_red_verified",
				"tasks:",
				"  - id: m1-t1",
				"    status: blocked",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "blocker.md"), "# Blocker\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "milestone.md"), "# milestone\n", "utf8");
		await fs.writeFile(
			path.join(milestoneDir, "milestone-result.json"),
			JSON.stringify({ status: "blocked", nextCommand: "/resume_milestone m1" }, null, 2),
			"utf8",
		);

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();
		const execCalls: string[][] = [];

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool() {},
			getCommands() {
				return [];
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
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const resumeMilestone = commands.get("resume_milestone");
		assert.ok(resumeMilestone);

		await resumeMilestone.handler("m1", {
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

		assert.equal(
			notifications.filter((entry) => entry.level === "error").length,
			0,
			"expected native resume_milestone to avoid wrapper-level errors",
		);
		assert.ok(
			execCalls.some(
				(args) =>
					JSON.stringify(args) ===
					JSON.stringify(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]),
			),
			"expected resume_milestone to verify the milestone branch",
		);
		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0].includes("Continue the native /resume_milestone workflow"));
		assert.ok(sentMessages[0].includes("tests_red_verified"));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: in_progress"));
		assert.ok(state.includes("blocked_on: null"));
		assert.match(state, /unblocked_at: 20/);
		assert.ok(state.includes("- id: m1-t1\n    status: in_progress"));

		const blockers = await fs.readdir(path.join(milestoneDir, "blockers"));
		assert.equal(blockers.length, 1);
		await assert.rejects(fs.access(path.join(milestoneDir, "blocker.md")));
		await assert.rejects(fs.access(path.join(milestoneDir, "milestone-result.json")));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("milestone resume"));
		assert.ok(execution.includes("Resumed checkpoint"));
	});
});

test("resume_milestone reruns hardening after a blocked hardening validation", async () => {
	await withTempDir("planner-workflow-resume-hardening-validation-", async (root) => {
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
				"validation:",
				"  commands:",
				"    - command: npm test",
				"      kind: test",
				"      origin: canonical",
				"tasks:",
				"  - id: m1-t1",
				"    title: first task",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: blocked",
				"phase: hardening",
				"branch: feat/alpha",
				"blocked_at: 2026-03-08T16:00:00.000Z",
				"updated_at: 2026-03-08T16:00:00.000Z",
				"unblocked_at: null",
				"blocked_on:",
				"  type: test_failure",
				"  stage: hardening_validation",
				"  reason: npm test failed during hardening",
				"  task_id: null",
				"  recommended_next_command: /resume_milestone m1",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: done",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc1234",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "blocker.md"), "# Blocker\n", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool() {},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
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
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const resumeMilestone = commands.get("resume_milestone");
		assert.ok(resumeMilestone);

		await resumeMilestone.handler("m1", {
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

		assert.equal(notifications.filter((entry) => entry.level === "error").length, 0);
		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0].includes("Continue the native /milestone_harden workflow"));
		assert.ok(!sentMessages[0].includes("Continue the native /milestone_review workflow"));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: in_progress"));
		assert.ok(state.includes("phase: hardening"));
		assert.ok(state.includes("blocked_on: null"));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("Cleared blocker stage: `hardening_validation`"));
		assert.ok(execution.includes("milestone hardening resumed"));
	});
});

test("resume_milestone reruns review after a blocked review validation", async () => {
	await withTempDir("planner-workflow-resume-review-validation-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const planRoot = path.join(root, "plans", "demo-plan");
		const milestoneDir = path.join(planRoot, "milestones", "m1-alpha");
		const reviewPromptPath = path.join(root, "review-correctness.md");
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
				"    title: first task",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: blocked",
				"phase: review",
				"branch: feat/alpha",
				"blocked_at: 2026-03-08T16:00:00.000Z",
				"updated_at: 2026-03-08T16:00:00.000Z",
				"unblocked_at: null",
				"blocked_on:",
				"  type: unknown",
				"  stage: review_validation",
				"  reason: validation failed after review fixes",
				"  task_id: null",
				"  recommended_next_command: /resume_milestone m1",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: done",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc1234",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "blocker.md"), "# Blocker\n", "utf8");
		await fs.writeFile(
			reviewPromptPath,
			[
				"---",
				"description: correctness review",
				"---",
				"Review the code for correctness.",
			].join("\n"),
			"utf8",
		);

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool() {},
			getCommands() {
				return [{ source: "prompt", name: "review-correctness", path: reviewPromptPath }];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
					return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
				}
				if (
					(args[0] === "-C" &&
						args[1] === repoRoot &&
						args[2] === "rev-parse" &&
						args[3] === "--abbrev-ref" &&
						args[4] === "HEAD") ||
					(args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD")
				) {
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "main") {
					return { code: 0, stdout: "main\n", stderr: "" };
				}
				if (args[0] === "diff" && args[1] === "main...feat/alpha") {
					return { code: 0, stdout: "diff --git a/file.ts b/file.ts\n+const value = 1;\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
			sendUserMessage(message: string) {
				sentMessages.push(message);
			},
		};

		plannerWorkflowExtension(pi as never);
		const resumeMilestone = commands.get("resume_milestone");
		assert.ok(resumeMilestone);

		await resumeMilestone.handler("m1", {
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

		assert.equal(notifications.filter((entry) => entry.level === "error").length, 0);
		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0].includes("Continue the native /milestone_review workflow"));
		assert.ok(sentMessages[0].includes("Please review the following changes."));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: in_progress"));
		assert.ok(state.includes("phase: review"));
		assert.ok(state.includes("blocked_on: null"));

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("Cleared blocker stage: `review_validation`"));
		assert.ok(execution.includes("milestone review resumed"));
	});
});

test("resume_milestone rejects active plan defects and recommends replanner", async () => {
	await withTempDir("planner-workflow-resume-plan-defect-", async (root) => {
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
		await fs.writeFile(path.join(milestoneDir, "spec.yaml"), "tasks:\n  - id: m1-t1\n", "utf8");
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: blocked",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_on:",
				"  type: plan_defect",
				"  stage: task_alignment",
				"  reason: spec/state drift",
				"  task_id: null",
				"  recommended_next_command: /replanner m1",
				"checkpoint:",
				"  task_id: null",
				"  step: not_started",
				"tasks:",
				"  - id: m1-t1",
				"    status: blocked",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "blocker.md"), "# Blocker\n", "utf8");

		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool() {},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
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
					return { code: 0, stdout: "feat/alpha\n", stderr: "" };
				}
				throw new Error(`unexpected git args: ${JSON.stringify(args)}`);
			},
			sendUserMessage() {},
		};

		plannerWorkflowExtension(pi as never);
		const resumeMilestone = commands.get("resume_milestone");
		assert.ok(resumeMilestone);

		await resumeMilestone.handler("m1", {
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

		assert.ok(
			notifications.some(
				(entry) =>
					entry.level === "error" &&
					entry.message.includes("cannot continue milestone 'm1' while blocker type 'plan_defect' is active") &&
					entry.message.includes("Recommended next command: /replanner m1"),
			),
			"expected deterministic plan_defect resume rejection",
		);
	});
});

test("replanner runs natively and dispatches a generated replanning brief", async () => {
	await withTempDir("planner-workflow-replanner-native-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const planRoot = path.join(root, "plans", "demo-plan");
		const milestoneDir = path.join(planRoot, "milestones", "m1-alpha");
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		await fs.mkdir(path.join(repoRoot, ".pi"), { recursive: true });
		await fs.mkdir(path.join(milestoneDir, "blockers"), { recursive: true });

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
		await fs.writeFile(path.join(milestoneDir, "state.yaml"), "status: blocked\nphase: task_execution\ntasks:\n  - id: m1-t1\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "milestone.md"), "# milestone\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "blocker.md"), "# Blocker\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "blockers", "older.md"), "# Older blocker\n", "utf8");

		const sentMessages: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool() {},
			getCommands() {
				return [];
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
		const replanner = commands.get("replanner");
		assert.ok(replanner);

		await replanner.handler("m1", {
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

		assert.equal(
			notifications.filter((entry) => entry.level === "error").length,
			0,
			"expected native replanner kickoff to avoid wrapper-level errors",
		);
		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0].includes("Continue the native /replanner workflow"));
		assert.ok(sentMessages[0].includes("Plan index:"));
		assert.ok(sentMessages[0].includes("Current blocker"));
		assert.ok(sentMessages[0].includes("older.md"));
		assert.ok(sentMessages[0].includes("planner_apply_replan"));
	});
});

test("planner_apply_replan repairs state alignment, clears blocker artifacts, and recommends the next command", async () => {
	await withTempDir("planner-workflow-apply-replan-tool-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const planRoot = path.join(root, "plans", "demo-plan");
		const milestoneDir = path.join(planRoot, "milestones", "m1-alpha");
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		await fs.mkdir(path.join(repoRoot, ".pi"), { recursive: true });
		await fs.mkdir(path.join(milestoneDir, "blockers"), { recursive: true });

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
				"    title: keep completed work",
				"  - id: m1-t2a",
				"    title: replacement task",
				"    depends_on:",
				"      - m1-t1",
				"  - id: m1-t3",
				"    title: deferred task",
				"    depends_on:",
				"      - m1-t2a",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: blocked",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_at: 2026-03-08T16:00:00.000Z",
				"updated_at: 2026-03-08T16:00:00.000Z",
				"blocked_on:",
				"  type: plan_defect",
				"  stage: task_alignment",
				"  reason: state drift",
				"  recommended_next_command: /replanner m1",
				"checkpoint:",
				"  task_id: m1-t2",
				"  step: implementation_started",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc123",
				"  - id: m1-t2",
				"    status: blocked",
				"    commit: null",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "execution.md"), "# execution\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "milestone.md"), "# milestone\n", "utf8");
		await fs.writeFile(path.join(milestoneDir, "blocker.md"), "# Blocker\n", "utf8");
		await fs.writeFile(
			path.join(milestoneDir, "milestone-result.json"),
			JSON.stringify({ status: "blocked", nextCommand: "/replanner m1" }, null, 2),
			"utf8",
		);

		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const commands = new Map<string, { handler: (rawArgs: string, ctx: unknown) => Promise<void> }>();

		const pi = {
			registerCommand(name: string, command: { handler: (rawArgs: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(definition.name, definition);
			},
			getCommands() {
				return [];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
				return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
			},
		};

		plannerWorkflowExtension(pi as never);
		const applyReplanTool = tools.get("planner_apply_replan");
		assert.ok(applyReplanTool);

		const result = await applyReplanTool.execute(
			"tool-apply-replan",
			{
				milestone: "m1",
				summary: "- Replaced oversized task `m1-t2` with smaller follow-up tasks.\n- Deferred low-value work to `m1-t3`.",
				skippedTaskIds: ["m1-t3"],
			},
			undefined,
			undefined,
			{
				cwd: repoRoot,
				ui: {
					notify() {},
				},
			} as never,
		) as {
			content: Array<{ type: string; text: string }>;
			details: {
				nextCommand: string;
				checkpoint: { taskId?: string; step: string };
				archivedBlockerPath?: string;
				clearedResultPath?: string;
			};
		};

		assert.equal(result.details.nextCommand, "/resume_milestone m1");
		assert.deepEqual(result.details.checkpoint, { taskId: "m1-t2a", step: "not_started" });
		assert.ok(result.details.archivedBlockerPath);
		assert.ok(result.details.clearedResultPath);
		assert.ok(result.content[0]?.text.includes("Recommended next command: /resume_milestone m1"));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: in_progress"));
		assert.ok(state.includes("phase: task_execution"));
		assert.ok(state.includes("blocked_on: null"));
		assert.ok(state.includes("task_id: m1-t2a"));
		assert.ok(state.includes("- id: m1-t1"));
		assert.ok(state.includes("title: keep completed work"));
		assert.ok(state.includes("status: done"));
		assert.ok(state.includes("commit: abc123"));
		assert.ok(state.includes("- id: m1-t2a"));
		assert.ok(state.includes("title: replacement task"));
		assert.ok(state.includes("status: in_progress"));
		assert.ok(state.includes("- id: m1-t3"));
		assert.ok(state.includes("title: deferred task"));
		assert.ok(state.includes("status: skipped"));
		assert.ok(!state.includes("- id: m1-t2\n"));

		await assert.rejects(fs.access(path.join(milestoneDir, "blocker.md")));
		await assert.rejects(fs.access(path.join(milestoneDir, "milestone-result.json")));

		const archivedBlockers = await fs.readdir(path.join(milestoneDir, "blockers"));
		assert.equal(archivedBlockers.length, 1);

		const execution = await fs.readFile(path.join(milestoneDir, "execution.md"), "utf8");
		assert.ok(execution.includes("milestone replanned"));
		assert.ok(execution.includes("Replaced oversized task `m1-t2`"));
		assert.ok(execution.includes("Recommended next command: `/resume_milestone m1`"));
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
