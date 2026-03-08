import type { MilestoneSpecData, MilestoneStateData } from "./models.ts";

export interface TaskAlignmentResult {
	isAligned: boolean;
	specTaskIds: string[];
	stateTaskIds: string[];
	missingInState: string[];
	extraInState: string[];
}

export function compareTaskAlignment(
	spec: MilestoneSpecData,
	state: MilestoneStateData,
): TaskAlignmentResult {
	const specTaskIds = spec.tasks.map((task) => task.id);
	const stateTaskIds = state.tasks.map((task) => task.id);
	const specIdSet = new Set(specTaskIds);
	const stateIdSet = new Set(stateTaskIds);

	const missingInState = specTaskIds.filter((taskId) => !stateIdSet.has(taskId));
	const extraInState = stateTaskIds.filter((taskId) => !specIdSet.has(taskId));

	return {
		isAligned: missingInState.length === 0 && extraInState.length === 0,
		specTaskIds,
		stateTaskIds,
		missingInState,
		extraInState,
	};
}
