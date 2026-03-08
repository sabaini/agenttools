import type { MilestoneTaskSpec } from "./models.ts";
import { loadMilestoneStateRecord, saveMilestoneStateRecord } from "./state.ts";
import { resolveTaskGraph } from "./task-graph.ts";
import { parseMilestoneStatus, parseTaskStatus, type CheckpointStep, type TaskStatus } from "./transitions.ts";
import { asArray, asRecord, asString } from "./yaml.ts";

export type ReplannedMilestoneStatus = "planned" | "in_progress";

export interface ApplyMilestoneReplanOptions {
	milestoneId: string;
	specTasks: MilestoneTaskSpec[];
	milestoneStatus?: ReplannedMilestoneStatus;
	checkpointTaskId?: string;
	checkpointStep?: CheckpointStep;
	skippedTaskIds?: string[];
	timestamp: string;
}

export interface ApplyMilestoneReplanResult {
	state: Record<string, unknown>;
	milestoneStatus: ReplannedMilestoneStatus;
	checkpoint: {
		taskId?: string;
		step: CheckpointStep;
	};
	nextCommand: string;
	addedTaskIds: string[];
	removedTaskIds: string[];
	skippedTaskIds: string[];
}

function parseTaskList(state: Record<string, unknown>): Record<string, unknown>[] {
	return asArray(state.tasks)
		.map((entry) => asRecord(entry))
		.filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function uniqueTaskIds(taskIds: string[] | undefined): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];

	for (const taskId of taskIds ?? []) {
		const clean = taskId.trim();
		if (!clean || seen.has(clean)) {
			continue;
		}
		seen.add(clean);
		normalized.push(clean);
	}

	return normalized;
}

function duplicateSpecTaskIds(specTasks: MilestoneTaskSpec[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();

	for (const task of specTasks) {
		if (seen.has(task.id)) {
			duplicates.add(task.id);
			continue;
		}
		seen.add(task.id);
	}

	return Array.from(duplicates).sort((left, right) => left.localeCompare(right));
}

function inferReplannedMilestoneStatus(
	state: Record<string, unknown>,
	override: ReplannedMilestoneStatus | undefined,
): ReplannedMilestoneStatus {
	if (override) {
		return override;
	}

	const currentStatus = parseMilestoneStatus(state.status);
	const branchName = asString(state.branch);
	const hasExecutionState =
		Boolean(branchName) ||
		currentStatus === "blocked" ||
		currentStatus === "in_progress" ||
		parseTaskList(state).some((task) => {
			const status = parseTaskStatus(task.status);
			return status === "done" || status === "skipped" || status === "blocked" || status === "in_progress";
		});

	return hasExecutionState ? "in_progress" : "planned";
}

function recommendReplanNextCommand(
	milestoneId: string,
	milestoneStatus: ReplannedMilestoneStatus,
	checkpointTaskId: string | undefined,
): string {
	if (milestoneStatus === "planned") {
		return `/milestoner ${milestoneId}`;
	}
	return checkpointTaskId ? `/resume_milestone ${milestoneId}` : `/milestoner ${milestoneId}`;
}

function computeLastCompletedTask(tasks: Record<string, unknown>[]): string | undefined {
	let lastCompletedTaskId: string | undefined;
	for (const task of tasks) {
		if (parseTaskStatus(task.status) === "done") {
			lastCompletedTaskId = asString(task.id) ?? lastCompletedTaskId;
		}
	}
	return lastCompletedTaskId;
}

export async function applyMilestoneReplan(
	filePath: string,
	options: ApplyMilestoneReplanOptions,
): Promise<ApplyMilestoneReplanResult> {
	const state = await loadMilestoneStateRecord(filePath);
	const branchName = asString(state.branch);
	const currentStatus = parseMilestoneStatus(state.status);
	const requestedCheckpointTaskId = options.checkpointTaskId?.trim() || undefined;
	const requestedCheckpointStep = options.checkpointStep ?? "not_started";
	const skippedTaskIds = uniqueTaskIds(options.skippedTaskIds);
	const duplicateTaskIds = duplicateSpecTaskIds(options.specTasks);
	if (duplicateTaskIds.length > 0) {
		throw new Error(
			`/replanner cannot apply replan because spec.yaml contains duplicate task ids: ${duplicateTaskIds.join(", ")}.`,
		);
	}

	const taskIds = options.specTasks.map((task) => task.id);
	const taskIdSet = new Set(taskIds);
	const unknownSkippedTaskIds = skippedTaskIds.filter((taskId) => !taskIdSet.has(taskId));
	if (unknownSkippedTaskIds.length > 0) {
		throw new Error(
			`/replanner cannot mark unknown task ids skipped: ${unknownSkippedTaskIds.join(", ")}.`,
		);
	}
	if (requestedCheckpointTaskId && !taskIdSet.has(requestedCheckpointTaskId)) {
		throw new Error(
			`/replanner cannot use checkpoint task '${requestedCheckpointTaskId}' because it is missing from spec.yaml.`,
		);
	}
	if (requestedCheckpointTaskId && skippedTaskIds.includes(requestedCheckpointTaskId)) {
		throw new Error(
			`/replanner cannot resume task '${requestedCheckpointTaskId}' because it is also marked skipped.`,
		);
	}
	if (requestedCheckpointTaskId && requestedCheckpointStep === "done") {
		throw new Error(
			`/replanner cannot set checkpoint task '${requestedCheckpointTaskId}' to step 'done'. Omit checkpointTaskId to continue with the next task or phase instead.`,
		);
	}

	const graph = resolveTaskGraph(options.specTasks);
	if (graph.missingDependencies.length > 0) {
		throw new Error(
			[
				"/replanner cannot apply replan because spec.yaml still contains missing task dependencies.",
				...graph.missingDependencies.map(
					(entry) => `Task ${entry.taskId} depends on missing task ${entry.dependencyId}`,
				),
			].join("\n"),
		);
	}
	if (graph.hasCycle) {
		throw new Error(
			[
				"/replanner cannot apply replan because spec.yaml task dependencies still contain a cycle.",
				`Cycle-involved tasks: ${graph.cycleTaskIds.join(", ")}`,
			].join("\n"),
		);
	}

	const milestoneStatus = inferReplannedMilestoneStatus(state, options.milestoneStatus);
	if (milestoneStatus === "planned") {
		if (branchName) {
			throw new Error(
				`/replanner cannot reset milestone '${options.milestoneId}' to planned while branch '${branchName}' is still recorded in state.yaml.`,
			);
		}
		if (requestedCheckpointTaskId) {
			throw new Error(
				`/replanner cannot set a checkpoint task while milestone '${options.milestoneId}' is being reset to planned.`,
			);
		}
	} else if (!branchName) {
		throw new Error(
			`/replanner cannot set milestone '${options.milestoneId}' to in_progress without an active branch recorded in state.yaml.`,
		);
	}

	const existingTasks = parseTaskList(state);
	const existingTasksById = new Map<string, Record<string, unknown>>();
	for (const task of existingTasks) {
		const taskId = asString(task.id);
		if (!taskId) continue;
		existingTasksById.set(taskId, task);
	}

	const removedTaskIds = existingTasks
		.map((task) => asString(task.id))
		.filter((taskId): taskId is string => Boolean(taskId && !taskIdSet.has(taskId)));
	const addedTaskIds: string[] = [];

	const nextTasks = options.specTasks.map((specTask) => {
		const existingTask = existingTasksById.get(specTask.id);
		if (!existingTask) {
			addedTaskIds.push(specTask.id);
		}

		const existingStatus = parseTaskStatus(existingTask?.status) ?? "planned";
		if (existingStatus === "done" && skippedTaskIds.includes(specTask.id)) {
			throw new Error(
				`/replanner cannot mark task '${specTask.id}' skipped because it is already done.`,
			);
		}

		let nextStatus: TaskStatus = "planned";
		if (existingStatus === "done") {
			nextStatus = "done";
		} else if (existingStatus === "skipped" || skippedTaskIds.includes(specTask.id)) {
			nextStatus = "skipped";
		}

		const nextTask: Record<string, unknown> = existingTask ? { ...existingTask } : {};
		nextTask.id = specTask.id;
		if (specTask.title) {
			nextTask.title = specTask.title;
		} else {
			delete nextTask.title;
		}
		if (specTask.executionMode && specTask.executionMode !== "tdd") {
			nextTask.execution_mode = specTask.executionMode;
		} else {
			delete nextTask.execution_mode;
		}
		if (specTask.executionModeReason) {
			nextTask.execution_mode_reason = specTask.executionModeReason;
		} else {
			delete nextTask.execution_mode_reason;
		}
		nextTask.status = nextStatus;
		nextTask.commit = nextStatus === "done" ? existingTask?.commit ?? null : null;
		return nextTask;
	});

	let checkpointTaskId = requestedCheckpointTaskId;
	let checkpointStep: CheckpointStep = requestedCheckpointStep;
	if (milestoneStatus === "in_progress") {
		if (!checkpointTaskId) {
			checkpointTaskId = graph.orderedTaskIds.find((taskId) => {
				const task = nextTasks.find((entry) => asString(entry.id) === taskId);
				const status = parseTaskStatus(task?.status);
				return status !== "done" && status !== "skipped";
			});
			checkpointStep = "not_started";
		}

		if (checkpointTaskId) {
			const checkpointTask = nextTasks.find((task) => asString(task.id) === checkpointTaskId);
			if (!checkpointTask) {
				throw new Error(
					`/replanner cannot resume task '${checkpointTaskId}' because it is missing from the repaired task list.`,
				);
			}
			const checkpointTaskStatus = parseTaskStatus(checkpointTask.status);
			if (checkpointTaskStatus === "done" || checkpointTaskStatus === "skipped") {
				throw new Error(
					`/replanner cannot resume task '${checkpointTaskId}' because it is already ${checkpointTaskStatus}.`,
				);
			}

			for (const task of nextTasks) {
				const taskId = asString(task.id);
				if (!taskId) continue;
				const status = parseTaskStatus(task.status);
				if (status === "done" || status === "skipped") continue;
				task.status = taskId === checkpointTaskId ? "in_progress" : "planned";
			}
		}
	}

	state.status = milestoneStatus;
	state.phase = milestoneStatus === "planned" ? "not_started" : "task_execution";
	state.updated_at = options.timestamp;
	state.blocked_on = null;
	state.completed_at = null;
	if (currentStatus === "blocked") {
		state.unblocked_at = options.timestamp;
	}
	if (milestoneStatus === "planned") {
		state.started_at = null;
		state.checkpoint = {
			task_id: null,
			step: "not_started",
		};
	} else {
		state.checkpoint = checkpointTaskId
			? {
					task_id: checkpointTaskId,
					step: checkpointStep,
				}
			: {
					task_id: null,
					step: "not_started",
				};
	}
	state.tasks = nextTasks;
	state.last_completed_task = computeLastCompletedTask(nextTasks) ?? null;

	await saveMilestoneStateRecord(filePath, state);

	const effectiveCheckpointStep = checkpointTaskId ? checkpointStep : "not_started";
	return {
		state,
		milestoneStatus,
		checkpoint: {
			taskId: checkpointTaskId,
			step: effectiveCheckpointStep,
		},
		nextCommand: recommendReplanNextCommand(options.milestoneId, milestoneStatus, checkpointTaskId),
		addedTaskIds,
		removedTaskIds,
		skippedTaskIds: nextTasks
			.map((task) => ({
				taskId: asString(task.id),
				status: parseTaskStatus(task.status),
			}))
			.filter((task): task is { taskId: string; status: TaskStatus } => Boolean(task.taskId && task.status))
			.filter((task) => task.status === "skipped")
			.map((task) => task.taskId),
	};
}
