export type ValidationOrigin = "canonical" | "exploratory";
export type ValidationKind = "test" | "build" | "lint" | "typecheck" | "custom";
export type TaskExecutionMode = "tdd" | "docs_only" | "pure_refactor" | "build_config" | "generated_update";

export interface ValidationCommandSpec {
	command: string;
	label?: string;
	kind?: ValidationKind;
	origin?: ValidationOrigin;
}

export interface MilestoneValidationProfile {
	commands: ValidationCommandSpec[];
}

export interface PlanRepoInfo {
	root?: string;
	originUrl?: string;
	defaultBranch?: string;
}

export interface PlanMilestone {
	id: string;
	name?: string;
	slug?: string;
	path?: string;
}

export interface PlanData {
	planPath: string;
	planDir: string;
	repo: PlanRepoInfo;
	milestones: PlanMilestone[];
}

export interface MilestoneTaskSpec {
	id: string;
	title?: string;
	dependsOn: string[];
	executionMode?: TaskExecutionMode;
	executionModeReason?: string;
	invalidExecutionMode?: string;
}

export interface MilestoneSpecData {
	tasks: MilestoneTaskSpec[];
	validation?: MilestoneValidationProfile;
}

export interface MilestoneTaskState {
	id: string;
	title?: string;
	status?: string;
	commit?: string | null;
	executionMode?: TaskExecutionMode;
	executionModeReason?: string;
}

export interface MilestoneStateData {
	status?: string;
	phase?: string;
	tasks: MilestoneTaskState[];
}

export interface MilestoneResultSummary {
	milestoneId: string;
	milestoneSlug?: string;
	status: "completed" | "blocked";
	stage: string;
	blockerType?: string;
	blockerPath?: string;
	nextCommand?: string;
	commitShas: string[];
}
