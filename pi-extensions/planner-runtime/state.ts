import type { TaskExecutionMode } from "./models.ts";
import { asArray, asRecord, asString, loadYamlFile, writeYamlFile } from "./yaml.ts";
import {
	assertMilestonePhaseTransition,
	assertMilestoneStatusTransition,
	parseCheckpointStep,
	parseMilestonePhase,
	parseMilestoneStatus,
	parseTaskExecutionMode,
	parseTaskStatus,
	type CheckpointStep,
} from "./transitions.ts";

export interface MilestoneStartStateOptions {
	branchName: string;
	timestamp: string;
}

export interface TaskExecutionStartOptions {
	milestoneId: string;
	taskId: string;
	executionMode?: TaskExecutionMode;
	executionModeReason?: string;
	timestamp: string;
}

export interface TaskExecutionStartResult {
	state: Record<string, unknown>;
	firstActivation: boolean;
}

export interface TaskCheckpointUpdateOptions {
	milestoneId: string;
	taskId: string;
	step: CheckpointStep;
	timestamp: string;
}

export interface TaskExecutionDoneOptions {
	milestoneId: string;
	taskId: string;
	commitSha: string;
	timestamp: string;
}

export interface MilestonePhaseStartOptions {
	milestoneId: string;
	timestamp: string;
}

export interface MilestoneFinishOptions {
	milestoneId: string;
	timestamp: string;
}

export interface MilestoneResumeOptions {
	milestoneId: string;
	taskId?: string;
	checkpointStep?: CheckpointStep;
	timestamp: string;
}

function parseTaskList(state: Record<string, unknown>): Record<string, unknown>[] {
	return asArray(state.tasks)
		.map((entry) => asRecord(entry))
		.filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function normalizeTaskExecutionMode(value: TaskExecutionMode | undefined): TaskExecutionMode {
	return value ?? "tdd";
}

function assignTaskExecutionMetadata(
	targetTask: Record<string, unknown>,
	executionMode: TaskExecutionMode | undefined,
	executionModeReason: string | undefined,
): void {
	if (executionMode && executionMode !== "tdd") {
		targetTask.execution_mode = executionMode;
	} else {
		delete targetTask.execution_mode;
	}

	const trimmedReason = executionModeReason?.trim();
	if (trimmedReason) {
		targetTask.execution_mode_reason = trimmedReason;
	} else {
		delete targetTask.execution_mode_reason;
	}
}

function checkpointWithExecutionMetadata(options: {
	taskId: string | null;
	step: CheckpointStep;
	executionMode?: TaskExecutionMode;
	executionModeReason?: string;
}): Record<string, unknown> {
	const checkpoint: Record<string, unknown> = {
		task_id: options.taskId,
		step: options.step,
	};
	if (options.executionMode && options.executionMode !== "tdd") {
		checkpoint.execution_mode = options.executionMode;
	}
	const trimmedReason = options.executionModeReason?.trim();
	if (trimmedReason) {
		checkpoint.execution_mode_reason = trimmedReason;
	}
	return checkpoint;
}

function resolveTaskExecutionMetadata(options: {
	targetTask: Record<string, unknown>;
	checkpoint?: Record<string, unknown> | undefined;
	fallbackMode?: TaskExecutionMode;
	fallbackReason?: string;
}): { executionMode: TaskExecutionMode; executionModeReason?: string } {
	const executionMode =
		parseTaskExecutionMode(options.targetTask.execution_mode) ??
		parseTaskExecutionMode(options.checkpoint?.execution_mode) ??
		normalizeTaskExecutionMode(options.fallbackMode);
	const executionModeReason =
		asString(options.targetTask.execution_mode_reason) ??
		asString(options.checkpoint?.execution_mode_reason) ??
		options.fallbackReason?.trim() ??
		undefined;
	return { executionMode, executionModeReason };
}

function requiredCompletionCheckpointStep(executionMode: TaskExecutionMode): CheckpointStep {
	return executionMode === "tdd" ? "tests_green_verified" : "implementation_started";
}

function requireInProgressMilestoneForTaskExecution(
	commandName: string,
	state: Record<string, unknown>,
	milestoneId: string,
): void {
	const currentStatus = parseMilestoneStatus(state.status);
	const currentPhase = parseMilestonePhase(state.phase);

	if (currentStatus === "planned" || currentPhase === "not_started") {
		throw new Error(
			`${commandName} requires milestone '${milestoneId}' to be started first. Run /milestone_start ${milestoneId}.`,
		);
	}
	if (currentStatus === "blocked") {
		throw new Error(
			`${commandName} cannot run while milestone '${milestoneId}' is blocked. Run /resume_milestone ${milestoneId}.`,
		);
	}
	if (currentStatus === "done" || currentStatus === "skipped") {
		throw new Error(
			`${commandName} cannot run because milestone '${milestoneId}' is already ${currentStatus}.`,
		);
	}
	if (currentStatus !== "in_progress") {
		throw new Error(`${commandName} encountered plan_defect: milestone status must be 'in_progress' before task execution.`);
	}
	if (currentPhase === "hardening" || currentPhase === "review" || currentPhase === "finished") {
		throw new Error(
			`${commandName} cannot run because milestone '${milestoneId}' is already in phase '${currentPhase}'.`,
		);
	}

	assertMilestonePhaseTransition(commandName, currentPhase, "task_execution");

	const branchName = asString(state.branch);
	if (!branchName) {
		throw new Error(
			`${commandName} requires milestone '${milestoneId}' to have an active branch. Run /milestone_start ${milestoneId}.`,
		);
	}
}

function requireTaskRecord(
	commandName: string,
	state: Record<string, unknown>,
	milestoneId: string,
	taskId: string,
): Record<string, unknown> {
	const tasks = parseTaskList(state);
	let targetTask: Record<string, unknown> | undefined;

	for (const task of tasks) {
		const currentTaskId = asString(task.id);
		if (!currentTaskId) continue;

		if (currentTaskId !== taskId && parseTaskStatus(task.status) === "in_progress") {
			throw new Error(
				`${commandName} cannot start '${taskId}' while task '${currentTaskId}' is still in_progress. Finish or resolve that task first.`,
			);
		}

		if (currentTaskId === taskId) {
			targetTask = task;
		}
	}

	if (!targetTask) {
		throw new Error(`Task '${taskId}' missing from milestone '${milestoneId}'.`);
	}

	return targetTask;
}

function requireAllTasksDoneOrSkipped(commandName: string, state: Record<string, unknown>, milestoneId: string): void {
	const incomplete = parseTaskList(state)
		.map((task) => {
			const taskId = asString(task.id);
			const status = parseTaskStatus(task.status) ?? "planned";
			return taskId && status !== "done" && status !== "skipped" ? { taskId, status } : undefined;
		})
		.filter((entry): entry is { taskId: string; status: string } => Boolean(entry));

	if (incomplete.length === 0) {
		return;
	}

	throw new Error(
		[
			`${commandName} requires all non-skipped tasks in milestone '${milestoneId}' to be done before continuing.`,
			...incomplete.map((entry) => `Task ${entry.taskId} is still '${entry.status}'.`),
		].join("\n"),
	);
}

export async function loadMilestoneStateRecord(filePath: string): Promise<Record<string, unknown>> {
	const loaded = await loadYamlFile(filePath);
	const state = asRecord(loaded);
	if (!state) {
		throw new Error(`Expected top-level mapping in ${filePath}.`);
	}
	return state;
}

export async function saveMilestoneStateRecord(
	filePath: string,
	state: Record<string, unknown>,
): Promise<void> {
	await writeYamlFile(filePath, state);
}

export function assertMilestoneCanStart(
	commandName: string,
	state: Record<string, unknown>,
): void {
	const currentStatus = parseMilestoneStatus(state.status);
	const currentPhase = parseMilestonePhase(state.phase);

	assertMilestoneStatusTransition(commandName, currentStatus, "in_progress");
	assertMilestonePhaseTransition(commandName, currentPhase, "started");
}

export async function setMilestoneStartState(
	filePath: string,
	options: MilestoneStartStateOptions,
): Promise<Record<string, unknown>> {
	const state = await loadMilestoneStateRecord(filePath);
	assertMilestoneCanStart("/milestone_start", state);

	state.status = "in_progress";
	state.phase = "started";
	state.branch = options.branchName;
	state.started_at = options.timestamp;
	state.updated_at = options.timestamp;
	state.checkpoint = {
		task_id: null,
		step: "not_started",
	};

	await saveMilestoneStateRecord(filePath, state);
	return state;
}

export async function setTaskExecutionStart(
	filePath: string,
	options: TaskExecutionStartOptions,
): Promise<TaskExecutionStartResult> {
	const state = await loadMilestoneStateRecord(filePath);
	const currentStatus = parseMilestoneStatus(state.status);
	const currentPhase = parseMilestonePhase(state.phase);

	if (currentStatus === "planned" || currentPhase === "not_started") {
		throw new Error(
			`/tasker requires milestone '${options.milestoneId}' to be started first. Run /milestone_start ${options.milestoneId}.`,
		);
	}
	if (currentStatus === "blocked") {
		throw new Error(
			`/tasker cannot run while milestone '${options.milestoneId}' is blocked. Run /resume_milestone ${options.milestoneId}.`,
		);
	}
	if (currentStatus === "done" || currentStatus === "skipped") {
		throw new Error(
			`/tasker cannot run because milestone '${options.milestoneId}' is already ${currentStatus}.`,
		);
	}
	if (currentStatus !== "in_progress") {
		throw new Error(`/tasker encountered plan_defect: milestone status must be 'in_progress' before task execution.`);
	}
	if (currentPhase === "hardening" || currentPhase === "review" || currentPhase === "finished") {
		throw new Error(
			`/tasker cannot run because milestone '${options.milestoneId}' is already in phase '${currentPhase}'.`,
		);
	}

	assertMilestonePhaseTransition("/tasker", currentPhase, "task_execution");

	const branchName = asString(state.branch);
	if (!branchName) {
		throw new Error(
			`/tasker requires milestone '${options.milestoneId}' to have an active branch. Run /milestone_start ${options.milestoneId}.`,
		);
	}

	const targetTask = requireTaskRecord("/tasker", state, options.milestoneId, options.taskId);
	const currentTaskStatus = parseTaskStatus(targetTask.status) ?? "planned";
	if (currentTaskStatus === "done" || currentTaskStatus === "skipped") {
		throw new Error(`/tasker cannot run because task '${options.taskId}' is already ${currentTaskStatus}.`);
	}
	if (currentTaskStatus === "blocked") {
		throw new Error(
			`/tasker cannot restart blocked task '${options.taskId}' directly. Run /resume_milestone ${options.milestoneId}.`,
		);
	}
	if (currentTaskStatus !== "planned" && currentTaskStatus !== "in_progress") {
		throw new Error(`/tasker encountered plan_defect: task '${options.taskId}' has invalid status '${String(targetTask.status)}'.`);
	}

	const currentCheckpoint = asRecord(state.checkpoint);
	const { executionMode, executionModeReason } = resolveTaskExecutionMetadata({
		targetTask,
		checkpoint: currentCheckpoint,
		fallbackMode: options.executionMode,
		fallbackReason: options.executionModeReason,
	});
	const firstActivation = currentTaskStatus === "planned";
	let checkpointStep: CheckpointStep = "not_started";
	if (!firstActivation) {
		const checkpointTaskId = asString(currentCheckpoint?.task_id);
		if (checkpointTaskId && checkpointTaskId !== options.taskId) {
			throw new Error(
				`/tasker encountered plan_defect: task '${options.taskId}' is already in_progress but checkpoint.task_id is '${checkpointTaskId}'.`,
			);
		}
		checkpointStep = parseCheckpointStep(currentCheckpoint?.step) ?? "not_started";
	}

	targetTask.status = "in_progress";
	assignTaskExecutionMetadata(targetTask, executionMode, executionModeReason);
	state.status = "in_progress";
	state.phase = "task_execution";
	state.updated_at = options.timestamp;
	state.checkpoint = checkpointWithExecutionMetadata({
		taskId: options.taskId,
		step: checkpointStep,
		executionMode,
		executionModeReason,
	});

	await saveMilestoneStateRecord(filePath, state);
	return {
		state,
		firstActivation,
	};
}

export async function setTaskCheckpointStep(
	filePath: string,
	options: TaskCheckpointUpdateOptions,
): Promise<Record<string, unknown>> {
	const state = await loadMilestoneStateRecord(filePath);
	requireInProgressMilestoneForTaskExecution("/tasker", state, options.milestoneId);

	const targetTask = requireTaskRecord("/tasker", state, options.milestoneId, options.taskId);
	const currentTaskStatus = parseTaskStatus(targetTask.status);
	if (currentTaskStatus !== "in_progress") {
		throw new Error(
			`/tasker cannot move checkpoint for task '${options.taskId}' because its status is '${currentTaskStatus ?? String(targetTask.status)}'.`,
		);
	}

	const currentCheckpoint = asRecord(state.checkpoint);
	const currentTaskId = asString(currentCheckpoint?.task_id);
	const currentStep = parseCheckpointStep(currentCheckpoint?.step) ?? "not_started";
	const { executionMode, executionModeReason } = resolveTaskExecutionMetadata({
		targetTask,
		checkpoint: currentCheckpoint,
	});
	const steps: CheckpointStep[] = [
		"not_started",
		"tests_written",
		"tests_red_verified",
		"implementation_started",
		"tests_green_verified",
		"done",
	];
	const currentIndex = currentTaskId === options.taskId ? steps.indexOf(currentStep) : -1;
	const nextIndex = steps.indexOf(options.step);
	if (nextIndex === -1) {
		throw new Error(`/tasker encountered plan_defect: unknown checkpoint step '${options.step}'.`);
	}
	if (currentIndex > nextIndex) {
		throw new Error(
			`/tasker cannot move checkpoint for task '${options.taskId}' backward from '${currentStep}' to '${options.step}'.`,
		);
	}

	state.status = "in_progress";
	state.phase = "task_execution";
	state.updated_at = options.timestamp;
	state.checkpoint = checkpointWithExecutionMetadata({
		taskId: options.taskId,
		step: options.step,
		executionMode,
		executionModeReason,
	});

	await saveMilestoneStateRecord(filePath, state);
	return state;
}

export async function setTaskExecutionDone(
	filePath: string,
	options: TaskExecutionDoneOptions,
): Promise<Record<string, unknown>> {
	const state = await loadMilestoneStateRecord(filePath);
	requireInProgressMilestoneForTaskExecution("/tasker", state, options.milestoneId);

	const commitSha = options.commitSha.trim();
	if (!commitSha) {
		throw new Error(`/tasker cannot complete task '${options.taskId}' without a commit SHA.`);
	}

	const targetTask = requireTaskRecord("/tasker", state, options.milestoneId, options.taskId);
	const currentTaskStatus = parseTaskStatus(targetTask.status);
	if (currentTaskStatus !== "in_progress") {
		throw new Error(
			`/tasker cannot complete task '${options.taskId}' because its status is '${currentTaskStatus ?? String(targetTask.status)}'.`,
		);
	}

	const checkpoint = asRecord(state.checkpoint);
	const checkpointTaskId = asString(checkpoint?.task_id);
	const checkpointStep = parseCheckpointStep(checkpoint?.step) ?? "not_started";
	const { executionMode, executionModeReason } = resolveTaskExecutionMetadata({
		targetTask,
		checkpoint,
	});
	if (checkpointTaskId !== options.taskId) {
		throw new Error(
			`/tasker cannot complete task '${options.taskId}' because checkpoint.task_id is '${checkpointTaskId ?? "null"}'.`,
		);
	}
	const requiredCheckpointStep = requiredCompletionCheckpointStep(executionMode);
	const steps: CheckpointStep[] = [
		"not_started",
		"tests_written",
		"tests_red_verified",
		"implementation_started",
		"tests_green_verified",
		"done",
	];
	if (steps.indexOf(checkpointStep) < steps.indexOf(requiredCheckpointStep)) {
		throw new Error(
			`/tasker cannot complete task '${options.taskId}' before checkpoint step '${requiredCheckpointStep}'. Current checkpoint step is '${checkpointStep}'.`,
		);
	}

	targetTask.status = "done";
	targetTask.commit = commitSha;
	assignTaskExecutionMetadata(targetTask, executionMode, executionModeReason);
	state.status = "in_progress";
	state.phase = "task_execution";
	state.updated_at = options.timestamp;
	state.last_completed_task = options.taskId;
	state.checkpoint = checkpointWithExecutionMetadata({
		taskId: options.taskId,
		step: "done",
		executionMode,
		executionModeReason,
	});

	await saveMilestoneStateRecord(filePath, state);
	return state;
}

export async function setMilestoneHardeningStart(
	filePath: string,
	options: MilestonePhaseStartOptions,
): Promise<Record<string, unknown>> {
	const state = await loadMilestoneStateRecord(filePath);
	const currentStatus = parseMilestoneStatus(state.status);
	const currentPhase = parseMilestonePhase(state.phase);

	if (currentStatus !== "in_progress") {
		throw new Error(`/milestone_harden cannot run because milestone '${options.milestoneId}' is not in_progress.`);
	}
	if (currentPhase === "hardening") {
		throw new Error(`/milestone_harden cannot rerun while milestone '${options.milestoneId}' is already in phase 'hardening'.`);
	}
	if (currentPhase === "review" || currentPhase === "finished") {
		throw new Error(
			`/milestone_harden cannot run because milestone '${options.milestoneId}' is already in phase '${currentPhase}'.`,
		);
	}
	if (currentPhase !== "started" && currentPhase !== "task_execution") {
		throw new Error(
			`/milestone_harden encountered plan_defect: invalid milestone phase '${String(state.phase)}'.`,
		);
	}

	requireAllTasksDoneOrSkipped("/milestone_harden", state, options.milestoneId);
	state.phase = "hardening";
	state.updated_at = options.timestamp;
	await saveMilestoneStateRecord(filePath, state);
	return state;
}

export async function setMilestoneReviewStart(
	filePath: string,
	options: MilestonePhaseStartOptions,
): Promise<Record<string, unknown>> {
	const state = await loadMilestoneStateRecord(filePath);
	const currentStatus = parseMilestoneStatus(state.status);
	const currentPhase = parseMilestonePhase(state.phase);

	if (currentStatus !== "in_progress") {
		throw new Error(`/milestone_review cannot run because milestone '${options.milestoneId}' is not in_progress.`);
	}
	if (currentPhase !== "hardening") {
		throw new Error(
			`/milestone_review requires milestone '${options.milestoneId}' to be in phase 'hardening', but found '${currentPhase ?? String(state.phase)}'.`,
		);
	}

	assertMilestonePhaseTransition("/milestone_review", currentPhase, "review");
	state.phase = "review";
	state.updated_at = options.timestamp;
	await saveMilestoneStateRecord(filePath, state);
	return state;
}

export async function setMilestoneFinished(
	filePath: string,
	options: MilestoneFinishOptions,
): Promise<Record<string, unknown>> {
	const state = await loadMilestoneStateRecord(filePath);
	const currentStatus = parseMilestoneStatus(state.status);
	const currentPhase = parseMilestonePhase(state.phase);

	if (currentStatus !== "in_progress") {
		throw new Error(`/milestone_finish cannot run because milestone '${options.milestoneId}' is not in_progress.`);
	}
	if (currentPhase !== "review") {
		throw new Error(
			`/milestone_finish requires milestone '${options.milestoneId}' to be in phase 'review', but found '${currentPhase ?? String(state.phase)}'.`,
		);
	}

	requireAllTasksDoneOrSkipped("/milestone_finish", state, options.milestoneId);
	assertMilestoneStatusTransition("/milestone_finish", currentStatus, "done");
	assertMilestonePhaseTransition("/milestone_finish", currentPhase, "finished");
	state.status = "done";
	state.phase = "finished";
	state.completed_at = options.timestamp;
	state.updated_at = options.timestamp;
	state.blocked_on = null;
	await saveMilestoneStateRecord(filePath, state);
	return state;
}

export async function setMilestoneResumed(
	filePath: string,
	options: MilestoneResumeOptions,
): Promise<Record<string, unknown>> {
	const state = await loadMilestoneStateRecord(filePath);
	const currentStatus = parseMilestoneStatus(state.status);
	if (currentStatus !== "blocked" && currentStatus !== "in_progress") {
		throw new Error(
			`/resume_milestone cannot run because milestone '${options.milestoneId}' has status '${currentStatus ?? String(state.status)}'.`,
		);
	}
	if (currentStatus === "blocked") {
		assertMilestoneStatusTransition("/resume_milestone", currentStatus, "in_progress");
	}

	state.status = "in_progress";
	state.updated_at = options.timestamp;
	if (currentStatus === "blocked") {
		state.unblocked_at = options.timestamp;
	}
	state.blocked_on = null;

	const checkpoint = asRecord(state.checkpoint);
	const checkpointTaskId = options.taskId ?? asString(checkpoint?.task_id);
	const checkpointStep = options.checkpointStep ?? parseCheckpointStep(checkpoint?.step) ?? "not_started";
	let checkpointExecutionMode: TaskExecutionMode | undefined;
	let checkpointExecutionModeReason: string | undefined;

	if (checkpointTaskId) {
		const task = requireTaskRecord("/resume_milestone", state, options.milestoneId, checkpointTaskId);
		const resolved = resolveTaskExecutionMetadata({
			targetTask: task,
			checkpoint,
		});
		checkpointExecutionMode = resolved.executionMode;
		checkpointExecutionModeReason = resolved.executionModeReason;
		assignTaskExecutionMetadata(task, checkpointExecutionMode, checkpointExecutionModeReason);
		const taskStatus = parseTaskStatus(task.status);
		if (checkpointStep !== "done" && taskStatus !== "done" && taskStatus !== "skipped") {
			task.status = "in_progress";
		}
	}

	state.checkpoint = checkpointWithExecutionMetadata({
		taskId: checkpointTaskId ?? null,
		step: checkpointStep,
		executionMode: checkpointExecutionMode,
		executionModeReason: checkpointExecutionModeReason,
	});

	await saveMilestoneStateRecord(filePath, state);
	return state;
}
