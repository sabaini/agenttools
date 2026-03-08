import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import type {
	MilestoneSpecData,
	MilestoneStateData,
	MilestoneTaskSpec,
	MilestoneTaskState,
	MilestoneValidationProfile,
	PlanData,
	PlanMilestone,
	PlanRepoInfo,
	ValidationCommandSpec,
} from "./models.ts";
import { parseTaskExecutionMode } from "./transitions.ts";
import { asArray, asRecord, asString, asStringArray, loadYamlFile, loadYamlFileSync, parseYamlContent } from "./yaml.ts";

function parseValidationCommands(value: unknown): ValidationCommandSpec[] {
	return asArray(value)
		.map((entry) => {
			if (typeof entry === "string") {
				const command = asString(entry);
				return command ? { command } : undefined;
			}

			const record = asRecord(entry);
			if (!record) {
				return undefined;
			}

			const command = asString(record.command);
			if (!command) {
				return undefined;
			}

			return {
				command,
				label: asString(record.label),
				kind: asString(record.kind) as ValidationCommandSpec["kind"],
				origin: asString(record.origin) as ValidationCommandSpec["origin"],
			};
		})
		.filter((entry): entry is ValidationCommandSpec => Boolean(entry));
}

function parseValidationProfile(value: unknown): MilestoneValidationProfile | undefined {
	const record = asRecord(value);
	if (!record) {
		return undefined;
	}

	const commands = parseValidationCommands(record.commands);
	return { commands };
}

function parsePlanRepoInfo(value: unknown): PlanRepoInfo {
	const repo = asRecord(value);
	if (!repo) {
		return {};
	}

	return {
		root: asString(repo.root),
		originUrl: asString(repo.origin_url),
		defaultBranch: asString(repo.default_branch),
	};
}

function parsePlanMilestones(value: unknown): PlanMilestone[] {
	return asArray(value)
		.map((entry) => {
			const milestone = asRecord(entry);
			if (!milestone) {
				return undefined;
			}

			const id = asString(milestone.id);
			if (!id) {
				return undefined;
			}

			return {
				id,
				name: asString(milestone.name),
				slug: asString(milestone.slug),
				path: asString(milestone.path),
			};
		})
		.filter((entry): entry is PlanMilestone => Boolean(entry));
}

function parseMilestoneTaskSpecs(value: unknown): MilestoneTaskSpec[] {
	return asArray(value)
		.map((entry) => {
			const task = asRecord(entry);
			if (!task) {
				return undefined;
			}

			const id = asString(task.id);
			if (!id) {
				return undefined;
			}

			const rawExecutionMode = asString(task.execution_mode);
			const executionMode = parseTaskExecutionMode(rawExecutionMode);
			const executionModeReason = asString(task.execution_mode_reason);

			return {
				id,
				title: asString(task.title),
				dependsOn: asStringArray(task.depends_on),
				...(executionMode ? { executionMode } : {}),
				...(executionModeReason ? { executionModeReason } : {}),
				...(rawExecutionMode && !executionMode ? { invalidExecutionMode: rawExecutionMode } : {}),
			};
		})
		.filter((entry): entry is MilestoneTaskSpec => Boolean(entry));
}

function parseMilestoneTaskStates(value: unknown): MilestoneTaskState[] {
	return asArray(value)
		.map((entry) => {
			const task = asRecord(entry);
			if (!task) {
				return undefined;
			}

			const id = asString(task.id);
			if (!id) {
				return undefined;
			}

			const commitValue = task.commit;
			const commit = typeof commitValue === "string" ? commitValue : commitValue === null ? null : undefined;
			const executionMode = parseTaskExecutionMode(task.execution_mode);
			const executionModeReason = asString(task.execution_mode_reason);

			return {
				id,
				title: asString(task.title),
				status: asString(task.status),
				commit,
				...(executionMode ? { executionMode } : {}),
				...(executionModeReason ? { executionModeReason } : {}),
			};
		})
		.filter((entry): entry is MilestoneTaskState => Boolean(entry));
}

function asPlannerRoot(value: unknown, filePath: string): Record<string, unknown> {
	const root = asRecord(value);
	if (!root) {
		throw new Error(`Expected top-level mapping in ${filePath}.`);
	}
	return root;
}

export function parsePlanData(raw: string, planPath: string): PlanData {
	const root = asPlannerRoot(parseYamlContent(raw, planPath), planPath);
	return {
		planPath,
		planDir: path.dirname(planPath),
		repo: parsePlanRepoInfo(root.repo),
		milestones: parsePlanMilestones(root.milestones),
	};
}

export async function loadPlanData(planPath: string): Promise<PlanData> {
	let raw: string;
	try {
		raw = await fs.readFile(planPath, "utf8");
	} catch {
		throw new Error(`Missing/unreadable plan index: ${planPath}`);
	}
	return parsePlanData(raw, planPath);
}

export function loadPlanDataSync(planPath: string): PlanData {
	let raw: string;
	try {
		raw = fsSync.readFileSync(planPath, "utf8");
	} catch {
		throw new Error(`Missing/unreadable plan index: ${planPath}`);
	}
	return parsePlanData(raw, planPath);
}

export function parseMilestoneSpecData(raw: string, filePath: string): MilestoneSpecData {
	const root = asPlannerRoot(parseYamlContent(raw, filePath), filePath);
	return {
		tasks: parseMilestoneTaskSpecs(root.tasks),
		validation: parseValidationProfile(root.validation),
	};
}

export async function loadMilestoneSpecData(filePath: string): Promise<MilestoneSpecData> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, "utf8");
	} catch {
		throw new Error(`Missing/unreadable milestone file: ${filePath}`);
	}
	return parseMilestoneSpecData(raw, filePath);
}

export function parseMilestoneStateData(raw: string, filePath: string): MilestoneStateData {
	const root = asPlannerRoot(parseYamlContent(raw, filePath), filePath);
	return {
		status: asString(root.status),
		phase: asString(root.phase),
		tasks: parseMilestoneTaskStates(root.tasks),
	};
}

export async function loadMilestoneStateData(filePath: string): Promise<MilestoneStateData> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, "utf8");
	} catch {
		throw new Error(`Missing/unreadable milestone file: ${filePath}`);
	}
	return parseMilestoneStateData(raw, filePath);
}

export function parseTaskIdsFromYaml(raw: string, filePath = "<inline>"): Set<string> {
	const root = asPlannerRoot(parseYamlContent(raw, filePath), filePath);
	return new Set(parseMilestoneTaskSpecs(root.tasks).map((task) => task.id));
}

export async function readTaskIdsFromYaml(filePath: string): Promise<Set<string>> {
	const root = asPlannerRoot(await loadYamlFile(filePath), filePath);
	return new Set(parseMilestoneTaskSpecs(root.tasks).map((task) => task.id));
}

export function readTaskIdsFromYamlSync(filePath: string): Set<string> {
	const root = asPlannerRoot(loadYamlFileSync(filePath), filePath);
	return new Set(parseMilestoneTaskSpecs(root.tasks).map((task) => task.id));
}
