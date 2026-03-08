import type { TaskExecutionMode } from "./models.ts";
import { asString } from "./yaml.ts";

export type MilestoneStatus = "planned" | "in_progress" | "blocked" | "done" | "skipped";
export type MilestonePhase =
	| "not_started"
	| "started"
	| "task_execution"
	| "hardening"
	| "review"
	| "finished";
export type TaskStatus = "planned" | "in_progress" | "blocked" | "done" | "skipped";
export type CheckpointStep =
	| "not_started"
	| "tests_written"
	| "tests_red_verified"
	| "implementation_started"
	| "tests_green_verified"
	| "done";

const STATUS_TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
	planned: ["in_progress", "skipped"],
	in_progress: ["blocked", "done", "skipped"],
	blocked: ["in_progress", "skipped"],
	done: [],
	skipped: [],
};

const PHASE_TRANSITIONS: Record<MilestonePhase, MilestonePhase[]> = {
	not_started: ["started"],
	started: ["task_execution"],
	task_execution: ["task_execution", "hardening"],
	hardening: ["review"],
	review: ["finished"],
	finished: [],
};

const TASK_STATUSES: TaskStatus[] = ["planned", "in_progress", "blocked", "done", "skipped"];
const TASK_EXECUTION_MODES: TaskExecutionMode[] = ["tdd", "docs_only", "pure_refactor", "build_config", "generated_update"];
const CHECKPOINT_STEPS: CheckpointStep[] = [
	"not_started",
	"tests_written",
	"tests_red_verified",
	"implementation_started",
	"tests_green_verified",
	"done",
];

export function parseMilestoneStatus(value: unknown): MilestoneStatus | undefined {
	const status = asString(value);
	if (!status) return undefined;
	if (["planned", "in_progress", "blocked", "done", "skipped"].includes(status)) {
		return status as MilestoneStatus;
	}
	return undefined;
}

export function parseMilestonePhase(value: unknown): MilestonePhase | undefined {
	const phase = asString(value);
	if (!phase) return undefined;
	if (["not_started", "started", "task_execution", "hardening", "review", "finished"].includes(phase)) {
		return phase as MilestonePhase;
	}
	return undefined;
}

export function parseTaskStatus(value: unknown): TaskStatus | undefined {
	const status = asString(value);
	if (!status) return undefined;
	return TASK_STATUSES.includes(status as TaskStatus) ? (status as TaskStatus) : undefined;
}

export function parseCheckpointStep(value: unknown): CheckpointStep | undefined {
	const step = asString(value);
	if (!step) return undefined;
	return CHECKPOINT_STEPS.includes(step as CheckpointStep) ? (step as CheckpointStep) : undefined;
}

export function parseTaskExecutionMode(value: unknown): TaskExecutionMode | undefined {
	const mode = asString(value);
	if (!mode) return undefined;
	return TASK_EXECUTION_MODES.includes(mode as TaskExecutionMode) ? (mode as TaskExecutionMode) : undefined;
}

export function assertMilestoneStatusTransition(
	commandName: string,
	from: MilestoneStatus | undefined,
	to: MilestoneStatus,
): void {
	if (!from) {
		throw new Error(`${commandName} cannot transition milestone status to '${to}' because current status is missing.`);
	}
	if (!STATUS_TRANSITIONS[from].includes(to)) {
		throw new Error(
			`${commandName} encountered plan_defect: invalid milestone status transition '${from}' -> '${to}'.`,
		);
	}
}

export function assertMilestonePhaseTransition(
	commandName: string,
	from: MilestonePhase | undefined,
	to: MilestonePhase,
): void {
	if (!from) {
		throw new Error(`${commandName} cannot transition milestone phase to '${to}' because current phase is missing.`);
	}
	if (!PHASE_TRANSITIONS[from].includes(to)) {
		throw new Error(
			`${commandName} encountered plan_defect: invalid milestone phase transition '${from}' -> '${to}'.`,
		);
	}
}
