import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { finalizeGeneratedPlan } from "../planner-runtime/plan-finalization.ts";

async function withTempDir(prefix: string, run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("finalizeGeneratedPlan repairs missing validation profiles, patches repo metadata, and writes the active pointer", async () => {
	await withTempDir("planner-plan-finalization-", async (root) => {
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
				"  origin_url: null",
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

		const finalized = await finalizeGeneratedPlan({
			repoRoot,
			planDir,
			originUrl: "git@github.com:org/demo.git",
			defaultBranch: "main",
		});

		assert.equal(finalized.ignoreStrategy, "git-info-exclude");
		assert.deepEqual(finalized.repairedValidationMilestoneIds, ["m1"]);
		assert.deepEqual(finalized.patchedPlanRepoFields.sort(), [
			"repo.default_branch",
			"repo.origin_url",
			"repo.root",
		]);

		const pointer = await fs.readFile(path.join(repoRoot, ".pi", "active_plan"), "utf8");
		assert.equal(pointer.trim(), planDir);

		const exclude = await fs.readFile(path.join(repoRoot, ".git", "info", "exclude"), "utf8");
		assert.ok(exclude.includes(".pi/active_plan"));

		const spec = await fs.readFile(path.join(milestoneDir, "spec.yaml"), "utf8");
		assert.ok(spec.includes("validation:"));
		assert.ok(spec.includes("command: npm test"));
		assert.ok(spec.includes("command: npm run build"));
		assert.ok(spec.includes("command: npx tsc --noEmit"));

		const planYaml = await fs.readFile(path.join(planDir, "plan.yaml"), "utf8");
		assert.ok(planYaml.includes(`root: ${repoRoot}`));
		assert.ok(planYaml.includes("origin_url: git@github.com:org/demo.git"));
		assert.ok(planYaml.includes("default_branch: main"));
	});
});

test("finalizeGeneratedPlan accepts an explicit empty validation profile on repos without detected validation commands", async () => {
	await withTempDir("planner-plan-finalization-empty-validation-", async (root) => {
		const repoRoot = path.join(root, "repo");
		const planDir = path.join(root, "plans", "demo-plan");
		const milestoneDir = path.join(planDir, "milestones", "m1-alpha");
		await fs.mkdir(path.join(repoRoot, ".git", "info"), { recursive: true });
		await fs.mkdir(milestoneDir, { recursive: true });
		await fs.writeFile(path.join(planDir, "README.md"), "# Demo plan\n", "utf8");
		await fs.writeFile(
			path.join(planDir, "plan.yaml"),
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
		await fs.writeFile(
			path.join(milestoneDir, "spec.yaml"),
			[
				"goal: demo milestone",
				"tasks:",
				"  - id: m1-t1",
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

		const finalized = await finalizeGeneratedPlan({
			repoRoot,
			planDir,
			defaultBranch: "main",
		});

		assert.deepEqual(finalized.repairedValidationMilestoneIds, ["m1"]);
		const spec = await fs.readFile(path.join(milestoneDir, "spec.yaml"), "utf8");
		assert.ok(spec.includes("validation:"));
		assert.ok(spec.includes("commands: []"));
	});
});
