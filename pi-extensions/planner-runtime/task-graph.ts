import type { MilestoneTaskSpec } from "./models.ts";

export interface TaskDependencyProblem {
	taskId: string;
	dependencyId: string;
}

export interface TaskGraphResolution {
	orderedTaskIds: string[];
	orderedTasks: MilestoneTaskSpec[];
	hasCycle: boolean;
	cycleTaskIds: string[];
	missingDependencies: TaskDependencyProblem[];
}

export function resolveTaskGraph(tasks: MilestoneTaskSpec[]): TaskGraphResolution {
	const indexByTaskId = new Map<string, number>();
	const taskById = new Map<string, MilestoneTaskSpec>();
	const dependents = new Map<string, string[]>();
	const inDegree = new Map<string, number>();
	const missingDependencies: TaskDependencyProblem[] = [];

	for (const [index, task] of tasks.entries()) {
		indexByTaskId.set(task.id, index);
		taskById.set(task.id, task);
		dependents.set(task.id, []);
		inDegree.set(task.id, 0);
	}

	for (const task of tasks) {
		for (const dependencyId of task.dependsOn) {
			if (!taskById.has(dependencyId)) {
				missingDependencies.push({ taskId: task.id, dependencyId });
				continue;
			}

			dependents.get(dependencyId)?.push(task.id);
			inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
		}
	}

	const available = tasks
		.filter((task) => (inDegree.get(task.id) ?? 0) === 0)
		.map((task) => task.id)
		.sort((left, right) => (indexByTaskId.get(left) ?? 0) - (indexByTaskId.get(right) ?? 0));
	const orderedTaskIds: string[] = [];

	while (available.length > 0) {
		const nextTaskId = available.shift();
		if (!nextTaskId) {
			break;
		}

		orderedTaskIds.push(nextTaskId);
		for (const dependentId of dependents.get(nextTaskId) ?? []) {
			const nextDegree = (inDegree.get(dependentId) ?? 0) - 1;
			inDegree.set(dependentId, nextDegree);
			if (nextDegree === 0) {
				available.push(dependentId);
				available.sort((left, right) => (indexByTaskId.get(left) ?? 0) - (indexByTaskId.get(right) ?? 0));
			}
		}
	}

	const cycleTaskIds = tasks
		.filter((task) => !orderedTaskIds.includes(task.id) && (inDegree.get(task.id) ?? 0) > 0)
		.map((task) => task.id);

	return {
		orderedTaskIds,
		orderedTasks: orderedTaskIds.map((taskId) => taskById.get(taskId)).filter((task): task is MilestoneTaskSpec => Boolean(task)),
		hasCycle: cycleTaskIds.length > 0,
		cycleTaskIds,
		missingDependencies,
	};
}
