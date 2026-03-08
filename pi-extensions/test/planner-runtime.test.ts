import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { blockMilestone, clearMilestoneBlocker } from "../planner-runtime/blockers.ts";
import {
	parseMilestoneSpecData,
	parseMilestoneStateData,
	parsePlanData,
	parseTaskIdsFromYaml,
} from "../planner-runtime/plan-files.ts";
import { clearMilestoneResult, milestoneResultPath, writeMilestoneResult } from "../planner-runtime/results.ts";
import { applyMilestoneReplan } from "../planner-runtime/replanner.ts";
import {
	setMilestoneFinished,
	setMilestoneHardeningStart,
	setMilestoneResumed,
	setMilestoneReviewStart,
	setMilestoneStartState,
	setTaskCheckpointStep,
	setTaskExecutionDone,
	setTaskExecutionStart,
} from "../planner-runtime/state.ts";
import { resolveTaskGraph } from "../planner-runtime/task-graph.ts";

async function withTempDir(prefix: string, run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("parsePlanData reads repo metadata and milestone index via YAML parser", () => {
	const parsed = parsePlanData(
		[
			"schema_version: 1",
			"repo:",
			"  root: /tmp/repo",
			"  origin_url: git@github.com:org/project.git",
			"  default_branch: main",
			"milestones:",
			"  - id: m1",
			"    slug: alpha",
			"    path: milestones/m1-alpha/",
			"  - id: m2",
			"    slug: beta",
			"    path: milestones/m2-beta/",
		].join("\n"),
		"/tmp/plan/plan.yaml",
	);

	assert.equal(parsed.repo.root, "/tmp/repo");
	assert.equal(parsed.repo.originUrl, "git@github.com:org/project.git");
	assert.equal(parsed.repo.defaultBranch, "main");
	assert.deepEqual(
		parsed.milestones.map((milestone) => ({ id: milestone.id, slug: milestone.slug })),
		[
			{ id: "m1", slug: "alpha" },
			{ id: "m2", slug: "beta" },
		],
	);
});

test("parseMilestoneSpecData extracts task dependencies, execution modes, and milestone-local validation commands", () => {
	const parsed = parseMilestoneSpecData(
		[
			"tasks:",
			"  - id: m1-t1",
			"    title: first",
			"    depends_on: []",
			"  - id: m1-t2",
			"    title: second",
			"    depends_on:",
			"      - m1-t1",
			"    execution_mode: docs_only",
			"    execution_mode_reason: Documentation-only task with no meaningful red/green loop.",
			"validation:",
			"  commands:",
			"    - command: npm test",
			"      kind: test",
			"      origin: canonical",
			"    - command: npx tsc --noEmit",
			"      kind: typecheck",
			"      origin: exploratory",
		].join("\n"),
		"/tmp/plan/spec.yaml",
	);

	assert.deepEqual(parsed.tasks, [
		{ id: "m1-t1", title: "first", dependsOn: [] },
		{
			id: "m1-t2",
			title: "second",
			dependsOn: ["m1-t1"],
			executionMode: "docs_only",
			executionModeReason: "Documentation-only task with no meaningful red/green loop.",
		},
	]);
	assert.deepEqual(parsed.validation?.commands, [
		{ command: "npm test", kind: "test", origin: "canonical", label: undefined },
		{ command: "npx tsc --noEmit", kind: "typecheck", origin: "exploratory", label: undefined },
	]);
});

test("parseMilestoneSpecData preserves an explicit empty validation profile", () => {
	const parsed = parseMilestoneSpecData(
		[
			"tasks:",
			"  - id: m1-t1",
			"validation:",
			"  commands: []",
		].join("\n"),
		"/tmp/plan/spec.yaml",
	);

	assert.deepEqual(parsed.validation, { commands: [] });
});

test("parseMilestoneStateData extracts milestone phase and task state summary", () => {
	const parsed = parseMilestoneStateData(
		[
			"status: in_progress",
			"phase: task_execution",
			"tasks:",
			"  - id: m1-t1",
			"    title: first",
			"    status: done",
			"    commit: abc123",
			"  - id: m1-t2",
			"    title: second",
			"    status: planned",
			"    commit: null",
		].join("\n"),
		"/tmp/plan/state.yaml",
	);

	assert.equal(parsed.status, "in_progress");
	assert.equal(parsed.phase, "task_execution");
	assert.deepEqual(parsed.tasks, [
		{ id: "m1-t1", title: "first", status: "done", commit: "abc123" },
		{ id: "m1-t2", title: "second", status: "planned", commit: null },
	]);
});

test("setMilestoneStartState initializes branch and checkpoint metadata", async () => {
	await withTempDir("planner-runtime-milestone-start-state-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: planned",
				"phase: not_started",
				"branch: null",
				"started_at: null",
				"updated_at: null",
				"tasks:",
				"  - id: m1-t1",
				"    status: planned",
			].join("\n"),
			"utf8",
		);

		await setMilestoneStartState(statePath, {
			branchName: "feat/alpha",
			timestamp: "2026-03-08T15:45:00.000Z",
		});

		const state = await fs.readFile(statePath, "utf8");
		assert.ok(state.includes("status: in_progress"));
		assert.ok(state.includes("phase: started"));
		assert.ok(state.includes("branch: feat/alpha"));
		assert.ok(state.includes("task_id: null"));
		assert.ok(state.includes("step: not_started"));
	});
});

test("setTaskExecutionStart moves one task into progress and records the checkpoint", async () => {
	await withTempDir("planner-runtime-task-start-state-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: in_progress",
				"phase: started",
				"branch: feat/alpha",
				"updated_at: null",
				"checkpoint:",
				"  task_id: null",
				"  step: not_started",
				"tasks:",
				"  - id: m1-t1",
				"    status: planned",
				"  - id: m1-t2",
				"    status: done",
			].join("\n"),
			"utf8",
		);

		const result = await setTaskExecutionStart(statePath, {
			milestoneId: "m1",
			taskId: "m1-t1",
			timestamp: "2026-03-08T15:50:00.000Z",
		});

		assert.equal(result.firstActivation, true);
		const state = await fs.readFile(statePath, "utf8");
		assert.ok(state.includes("phase: task_execution"));
		assert.ok(state.includes("task_id: m1-t1"));
		assert.ok(state.includes("step: not_started"));
		assert.ok(state.includes("- id: m1-t1\n    status: in_progress"));
	});
});

test("setTaskExecutionStart stamps explicit non-TDD execution metadata into state", async () => {
	await withTempDir("planner-runtime-task-start-mode-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: in_progress",
				"phase: started",
				"branch: feat/alpha",
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

		await setTaskExecutionStart(statePath, {
			milestoneId: "m1",
			taskId: "m1-t1",
			executionMode: "docs_only",
			executionModeReason: "Documentation-only change.",
			timestamp: "2026-03-08T15:51:00.000Z",
		});

		const state = await fs.readFile(statePath, "utf8");
		assert.ok(state.includes("execution_mode: docs_only"));
		assert.ok(state.includes("execution_mode_reason: Documentation-only change."));
	});
});

test("setTaskExecutionStart preserves the checkpoint when re-entering an in-progress task", async () => {
	await withTempDir("planner-runtime-task-start-rerun-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"updated_at: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: tests_red_verified",
				"tasks:",
				"  - id: m1-t1",
				"    status: in_progress",
			].join("\n"),
			"utf8",
		);

		const result = await setTaskExecutionStart(statePath, {
			milestoneId: "m1",
			taskId: "m1-t1",
			timestamp: "2026-03-08T15:52:00.000Z",
		});

		assert.equal(result.firstActivation, false);
		const state = await fs.readFile(statePath, "utf8");
		assert.ok(state.includes("task_id: m1-t1"));
		assert.ok(state.includes("step: tests_red_verified"));
	});
});

test("setTaskCheckpointStep advances checkpoint for the active task", async () => {
	await withTempDir("planner-runtime-task-checkpoint-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"updated_at: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: tests_written",
				"tasks:",
				"  - id: m1-t1",
				"    status: in_progress",
				"    commit: null",
			].join("\n"),
			"utf8",
		);

		await setTaskCheckpointStep(statePath, {
			milestoneId: "m1",
			taskId: "m1-t1",
			step: "tests_red_verified",
			timestamp: "2026-03-08T15:55:00.000Z",
		});

		const state = await fs.readFile(statePath, "utf8");
		assert.ok(state.includes("step: tests_red_verified"));
		assert.ok(state.includes("task_id: m1-t1"));
	});
});

test("setTaskExecutionDone records commit sha and last completed task", async () => {
	await withTempDir("planner-runtime-task-done-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"updated_at: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: tests_green_verified",
				"last_completed_task: null",
				"tasks:",
				"  - id: m1-t1",
				"    status: in_progress",
				"    commit: null",
			].join("\n"),
			"utf8",
		);

		await setTaskExecutionDone(statePath, {
			milestoneId: "m1",
			taskId: "m1-t1",
			commitSha: "abc1234",
			timestamp: "2026-03-08T15:58:00.000Z",
		});

		const state = await fs.readFile(statePath, "utf8");
		assert.ok(state.includes("step: done"));
		assert.ok(state.includes("last_completed_task: m1-t1"));
		assert.ok(state.includes("status: done"));
		assert.ok(state.includes("commit: abc1234"));
	});
});

test("setTaskExecutionDone rejects completion before tests are green", async () => {
	await withTempDir("planner-runtime-task-done-too-early-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"updated_at: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: implementation_started",
				"last_completed_task: null",
				"tasks:",
				"  - id: m1-t1",
				"    status: in_progress",
				"    commit: null",
			].join("\n"),
			"utf8",
		);

		await assert.rejects(
			setTaskExecutionDone(statePath, {
				milestoneId: "m1",
				taskId: "m1-t1",
				commitSha: "abc1234",
				timestamp: "2026-03-08T15:59:00.000Z",
			}),
			/task 'm1-t1' before checkpoint step 'tests_green_verified'/,
		);
	});
});

test("setTaskExecutionDone allows explicit docs_only tasks to complete from implementation_started", async () => {
	await withTempDir("planner-runtime-task-done-docs-only-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"updated_at: null",
				"checkpoint:",
				"  task_id: m1-t1",
				"  step: implementation_started",
				"  execution_mode: docs_only",
				"  execution_mode_reason: Documentation-only task.",
				"last_completed_task: null",
				"tasks:",
				"  - id: m1-t1",
				"    status: in_progress",
				"    execution_mode: docs_only",
				"    execution_mode_reason: Documentation-only task.",
				"    commit: null",
			].join("\n"),
			"utf8",
		);

		await setTaskExecutionDone(statePath, {
			milestoneId: "m1",
			taskId: "m1-t1",
			commitSha: "abc1234",
			timestamp: "2026-03-08T16:00:00.000Z",
		});

		const state = await fs.readFile(statePath, "utf8");
		assert.ok(state.includes("step: done"));
		assert.ok(state.includes("execution_mode: docs_only"));
		assert.ok(state.includes("execution_mode_reason: Documentation-only task."));
		assert.ok(state.includes("commit: abc1234"));
	});
});

test("setMilestoneHardeningStart advances phase after all tasks are done", async () => {
	await withTempDir("planner-runtime-hardening-start-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: in_progress",
				"phase: task_execution",
				"branch: feat/alpha",
				"updated_at: null",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc123",
				"  - id: m1-t2",
				"    status: skipped",
				"    commit: null",
			].join("\n"),
			"utf8",
		);

		await setMilestoneHardeningStart(statePath, {
			milestoneId: "m1",
			timestamp: "2026-03-08T16:00:00.000Z",
		});

		const state = await fs.readFile(statePath, "utf8");
		assert.ok(state.includes("phase: hardening"));
	});
});

test("setMilestoneReviewStart advances phase from hardening to review", async () => {
	await withTempDir("planner-runtime-review-start-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: in_progress",
				"phase: hardening",
				"branch: feat/alpha",
				"updated_at: null",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc123",
			].join("\n"),
			"utf8",
		);

		await setMilestoneReviewStart(statePath, {
			milestoneId: "m1",
			timestamp: "2026-03-08T16:05:00.000Z",
		});

		const state = await fs.readFile(statePath, "utf8");
		assert.ok(state.includes("phase: review"));
	});
});

test("setMilestoneFinished marks the milestone done and records completion timestamp", async () => {
	await withTempDir("planner-runtime-finish-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: in_progress",
				"phase: review",
				"branch: feat/alpha",
				"updated_at: null",
				"completed_at: null",
				"blocked_on:",
				"  type: test_failure",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc123",
			].join("\n"),
			"utf8",
		);

		await setMilestoneFinished(statePath, {
			milestoneId: "m1",
			timestamp: "2026-03-08T16:10:00.000Z",
		});

		const state = await fs.readFile(statePath, "utf8");
		assert.ok(state.includes("status: done"));
		assert.ok(state.includes("phase: finished"));
		assert.ok(state.includes("completed_at: 2026-03-08T16:10:00.000Z"));
		assert.ok(state.includes("blocked_on: null"));
	});
});

test("setMilestoneResumed clears blocked state and reactivates the checkpoint task", async () => {
	await withTempDir("planner-runtime-resume-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: blocked",
				"phase: task_execution",
				"branch: feat/alpha",
				"updated_at: null",
				"unblocked_at: null",
				"blocked_on:",
				"  type: test_failure",
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

		await setMilestoneResumed(statePath, {
			milestoneId: "m1",
			taskId: "m1-t1",
			checkpointStep: "tests_red_verified",
			timestamp: "2026-03-08T16:20:00.000Z",
		});

		const state = await fs.readFile(statePath, "utf8");
		assert.ok(state.includes("status: in_progress"));
		assert.ok(state.includes("blocked_on: null"));
		assert.ok(state.includes("unblocked_at: 2026-03-08T16:20:00.000Z"));
		assert.ok(state.includes("step: tests_red_verified"));
		assert.ok(state.includes("- id: m1-t1\n    status: in_progress"));
	});
});

test("clearMilestoneBlocker archives the current blocker file", async () => {
	await withTempDir("planner-runtime-clear-blocker-", async (root) => {
		const milestoneDir = path.join(root, "m1-alpha");
		await fs.mkdir(milestoneDir, { recursive: true });
		await fs.writeFile(path.join(milestoneDir, "blocker.md"), "# Blocker\n", "utf8");

		const cleared = await clearMilestoneBlocker({
			milestoneDir,
			timestamp: "2026-03-08T16:22:00.000Z",
			archiveSuffix: "resume",
		});

		assert.ok(cleared.archivedBlockerPath);
		const archived = await fs.readFile(cleared.archivedBlockerPath!, "utf8");
		assert.ok(archived.includes("# Blocker"));
		await assert.rejects(fs.access(path.join(milestoneDir, "blocker.md")));
	});
});

test("applyMilestoneReplan realigns tasks, clears blocked state, and selects the next checkpoint", async () => {
	await withTempDir("planner-runtime-apply-replan-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: blocked",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_at: 2026-03-08T16:00:00.000Z",
				"updated_at: 2026-03-08T16:00:00.000Z",
				"unblocked_at: null",
				"blocked_on:",
				"  type: plan_defect",
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

		const replanned = await applyMilestoneReplan(statePath, {
			milestoneId: "m1",
			specTasks: [
				{ id: "m1-t1", title: "keep completed work", dependsOn: [] },
				{ id: "m1-t2a", title: "replacement task", dependsOn: ["m1-t1"] },
				{ id: "m1-t3", title: "deferred task", dependsOn: ["m1-t2a"] },
			],
			skippedTaskIds: ["m1-t3"],
			timestamp: "2026-03-08T16:30:00.000Z",
		});

		assert.equal(replanned.milestoneStatus, "in_progress");
		assert.equal(replanned.checkpoint.taskId, "m1-t2a");
		assert.equal(replanned.checkpoint.step, "not_started");
		assert.equal(replanned.nextCommand, "/resume_milestone m1");
		assert.deepEqual(replanned.addedTaskIds, ["m1-t2a", "m1-t3"]);
		assert.deepEqual(replanned.removedTaskIds, ["m1-t2"]);
		assert.deepEqual(replanned.skippedTaskIds, ["m1-t3"]);

		const state = await fs.readFile(statePath, "utf8");
		assert.ok(state.includes("status: in_progress"));
		assert.ok(state.includes("phase: task_execution"));
		assert.ok(state.includes("blocked_on: null"));
		assert.ok(state.includes("unblocked_at: 2026-03-08T16:30:00.000Z"));
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
	});
});

test("applyMilestoneReplan recommends /milestoner when no pending task remains after repair", async () => {
	await withTempDir("planner-runtime-apply-replan-finishable-", async (root) => {
		const statePath = path.join(root, "state.yaml");
		await fs.writeFile(
			statePath,
			[
				"status: blocked",
				"phase: task_execution",
				"branch: feat/alpha",
				"blocked_at: 2026-03-08T16:00:00.000Z",
				"updated_at: 2026-03-08T16:00:00.000Z",
				"unblocked_at: null",
				"blocked_on:",
				"  type: plan_defect",
				"checkpoint:",
				"  task_id: m1-t2",
				"  step: implementation_started",
				"tasks:",
				"  - id: m1-t1",
				"    status: done",
				"    commit: abc1234",
				"  - id: m1-t2",
				"    status: blocked",
				"    commit: null",
			].join("\n"),
			"utf8",
		);

		const replanned = await applyMilestoneReplan(statePath, {
			milestoneId: "m1",
			specTasks: [{ id: "m1-t1", title: "keep completed work", dependsOn: [] }],
			timestamp: "2026-03-08T16:45:00.000Z",
		});

		assert.equal(replanned.milestoneStatus, "in_progress");
		assert.equal(replanned.checkpoint.taskId, undefined);
		assert.equal(replanned.checkpoint.step, "not_started");
		assert.equal(replanned.nextCommand, "/milestoner m1");
		assert.deepEqual(replanned.addedTaskIds, []);
		assert.deepEqual(replanned.removedTaskIds, ["m1-t2"]);
		assert.deepEqual(replanned.skippedTaskIds, []);

		const state = await fs.readFile(statePath, "utf8");
		assert.ok(state.includes("status: in_progress"));
		assert.ok(state.includes("phase: task_execution"));
		assert.ok(state.includes("blocked_on: null"));
		assert.ok(state.includes("unblocked_at: 2026-03-08T16:45:00.000Z"));
		assert.ok(state.includes("task_id: null"));
		assert.ok(state.includes("- id: m1-t1"));
		assert.ok(state.includes("commit: abc1234"));
		assert.ok(!state.includes("m1-t2"));
	});
});

test("clearMilestoneResult removes stale milestone summary artifacts", async () => {
	await withTempDir("planner-runtime-clear-result-", async (root) => {
		await fs.writeFile(path.join(root, "milestone-result.json"), "{}\n", "utf8");
		const cleared = await clearMilestoneResult(root);
		assert.equal(cleared.removed, true);
		await assert.rejects(fs.access(path.join(root, "milestone-result.json")));
	});
});

test("parseTaskIdsFromYaml only reads top-level task ids", () => {
	const ids = parseTaskIdsFromYaml(
		[
			"tasks:",
			"  - id: m1-t1",
			"    checks:",
			"      - id: nested-check",
			"  - title: second task",
			"    id: m1-t2",
			"metadata:",
			"  owner:",
			"    id: nested-owner",
		].join("\n"),
		"/tmp/plan/spec.yaml",
	);

	assert.deepEqual(Array.from(ids), ["m1-t1", "m1-t2"]);
});

test("resolveTaskGraph topologically sorts by dependencies with original-order tie break", () => {
	const resolved = resolveTaskGraph([
		{ id: "m1-t1", title: "first", dependsOn: [] },
		{ id: "m1-t2", title: "second", dependsOn: [] },
		{ id: "m1-t3", title: "third", dependsOn: ["m1-t1"] },
		{ id: "m1-t4", title: "fourth", dependsOn: ["m1-t2"] },
	]);

	assert.equal(resolved.hasCycle, false);
	assert.deepEqual(resolved.missingDependencies, []);
	assert.deepEqual(resolved.orderedTaskIds, ["m1-t1", "m1-t2", "m1-t3", "m1-t4"]);
});

test("resolveTaskGraph reports cycles and missing dependencies", () => {
	const cycle = resolveTaskGraph([
		{ id: "m1-t1", title: "first", dependsOn: ["m1-t2"] },
		{ id: "m1-t2", title: "second", dependsOn: ["m1-t1"] },
	]);
	assert.equal(cycle.hasCycle, true);
	assert.deepEqual(cycle.cycleTaskIds.sort(), ["m1-t1", "m1-t2"]);

	const missing = resolveTaskGraph([
		{ id: "m1-t1", title: "first", dependsOn: ["m1-t9"] },
	]);
	assert.equal(missing.hasCycle, false);
	assert.deepEqual(missing.missingDependencies, [{ taskId: "m1-t1", dependencyId: "m1-t9" }]);
});

test("blockMilestone archives prior blocker, updates state, and writes a machine-readable result artifact", async () => {
	await withTempDir("planner-runtime-blocker-", async (root) => {
		const milestoneDir = path.join(root, "m1-alpha");
		await fs.mkdir(path.join(milestoneDir, "blockers"), { recursive: true });
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
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "blocker.md"), "# Old blocker\n", "utf8");

		const blocked = await blockMilestone({
			milestoneDir,
			milestoneId: "m1",
			milestoneSlug: "alpha",
			stage: "task_ordering",
			blockerType: "plan_defect",
			reason: "Cycle detected",
			recommendedNextCommand: "/replanner m1",
			timestamp: "2026-03-08T15:30:00.000Z",
		});

		assert.equal(path.basename(blocked.blockerPath), "blocker.md");
		assert.ok(blocked.archivedBlockerPath);
		const archived = await fs.readFile(blocked.archivedBlockerPath!, "utf8");
		assert.ok(archived.includes("Old blocker"));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("status: blocked"));
		assert.ok(state.includes("type: plan_defect"));
		assert.ok(state.includes("recommended_next_command: /replanner m1"));

		const resultPath = await writeMilestoneResult(milestoneDir, {
			milestoneId: "m1",
			milestoneSlug: "alpha",
			status: "blocked",
			stage: "task_ordering",
			blockerType: "plan_defect",
			blockerPath: blocked.blockerPath,
			nextCommand: "/replanner m1",
			commitShas: [],
		});
		assert.equal(resultPath, milestoneResultPath(milestoneDir));
		const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
		assert.equal(result.status, "blocked");
		assert.equal(result.blockerType, "plan_defect");
	});
});

test("blockMilestone rotates blocker archives across repeated blocks and preserves the initial blocked_at", async () => {
	await withTempDir("planner-runtime-blocker-rotation-", async (root) => {
		const milestoneDir = path.join(root, "m1-alpha");
		await fs.mkdir(path.join(milestoneDir, "blockers"), { recursive: true });
		await fs.writeFile(
			path.join(milestoneDir, "state.yaml"),
			[
				"status: in_progress",
				"phase: task_execution",
				"blocked_at: null",
				"updated_at: null",
				"blocked_on: null",
				"tasks:",
				"  - id: m1-t1",
				"    status: in_progress",
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(milestoneDir, "blocker.md"), "# Legacy blocker\n", "utf8");

		const first = await blockMilestone({
			milestoneDir,
			milestoneId: "m1",
			milestoneSlug: "alpha",
			stage: "task_execution",
			blockerType: "test_failure",
			reason: "Initial task validation failed.",
			recommendedNextCommand: "/resume_milestone m1",
			timestamp: "2026-03-08T17:00:00.000Z",
		});
		assert.ok(first.archivedBlockerPath);
		assert.ok((await fs.readFile(first.archivedBlockerPath!, "utf8")).includes("Legacy blocker"));

		const second = await blockMilestone({
			milestoneDir,
			milestoneId: "m1",
			milestoneSlug: "alpha",
			stage: "review",
			blockerType: "unknown",
			reason: "Follow-up review validation failed.",
			recommendedNextCommand: "/resume_milestone m1",
			timestamp: "2026-03-08T17:05:00.000Z",
		});
		assert.ok(second.archivedBlockerPath);
		assert.ok((await fs.readFile(second.archivedBlockerPath!, "utf8")).includes("Initial task validation failed."));

		const archivedNames = (await fs.readdir(path.join(milestoneDir, "blockers"))).sort();
		assert.equal(archivedNames.length, 2);
		assert.ok(archivedNames.some((name) => name.includes("2026-03-08T17-00-00.000Z-task_execution")));
		assert.ok(archivedNames.some((name) => name.includes("2026-03-08T17-05-00.000Z-review")));

		const activeBlocker = await fs.readFile(path.join(milestoneDir, "blocker.md"), "utf8");
		assert.ok(activeBlocker.includes("Follow-up review validation failed."));
		assert.ok(activeBlocker.includes("Blocker type: unknown"));

		const state = await fs.readFile(path.join(milestoneDir, "state.yaml"), "utf8");
		assert.ok(state.includes("blocked_at: 2026-03-08T17:00:00.000Z"));
		assert.ok(state.includes("updated_at: 2026-03-08T17:05:00.000Z"));
		assert.ok(state.includes("stage: review"));
		assert.ok(state.includes("type: unknown"));
	});
});
