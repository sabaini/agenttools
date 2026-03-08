import fs from "node:fs/promises";
import path from "node:path";

import { asRecord, loadYamlFile, writeYamlFile } from "./yaml.ts";

export interface BlockMilestoneOptions {
	milestoneDir: string;
	milestoneId: string;
	milestoneSlug?: string;
	stage: string;
	blockerType: string;
	reason: string;
	recommendedNextCommand: string;
	taskId?: string;
	timestamp?: string;
	markTaskBlocked?: boolean;
}

export interface BlockMilestoneResult {
	statePath: string;
	blockerPath: string;
	archivedBlockerPath?: string;
	timestamp: string;
}

export interface ClearMilestoneBlockerOptions {
	milestoneDir: string;
	timestamp?: string;
	archiveSuffix?: string;
}

export interface ClearMilestoneBlockerResult {
	blockerPath: string;
	archivedBlockerPath?: string;
	timestamp: string;
}

function sanitizeFileSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "blocker";
}

function buildBlockerMarkdown(options: BlockMilestoneOptions, timestamp: string): string {
	const title = options.taskId
		? `# Blocker — ${options.milestoneId} / ${options.taskId}`
		: `# Blocker — ${options.milestoneId}`;

	const lines = [
		title,
		"",
		`- Timestamp: ${timestamp}`,
		`- Milestone: ${options.milestoneId}${options.milestoneSlug ? ` (${options.milestoneSlug})` : ""}`,
		`- Stage: ${options.stage}`,
		`- Blocker type: ${options.blockerType}`,
		`- Recommended next command: ${options.recommendedNextCommand}`,
	];

	if (options.taskId) {
		lines.push(`- Task: ${options.taskId}`);
	}

	lines.push("", "## Reason", "", options.reason.trim(), "");
	return lines.join("\n");
}

export async function blockMilestone(options: BlockMilestoneOptions): Promise<BlockMilestoneResult> {
	const timestamp = options.timestamp ?? new Date().toISOString();
	const blockerPath = path.join(options.milestoneDir, "blocker.md");
	const blockersDir = path.join(options.milestoneDir, "blockers");
	const statePath = path.join(options.milestoneDir, "state.yaml");
	let archivedBlockerPath: string | undefined;

	await fs.mkdir(blockersDir, { recursive: true });

	try {
		await fs.access(blockerPath);
		const archiveName = `${sanitizeFileSegment(timestamp)}-${sanitizeFileSegment(
			options.taskId ?? options.stage,
		)}.md`;
		archivedBlockerPath = path.join(blockersDir, archiveName);
		await fs.rename(blockerPath, archivedBlockerPath);
	} catch {
		// no active blocker to archive
	}

	await fs.writeFile(blockerPath, buildBlockerMarkdown(options, timestamp), "utf8");

	const loadedState = await loadYamlFile(statePath);
	const state = asRecord(loadedState);
	if (!state) {
		throw new Error(`Expected top-level mapping in ${statePath}.`);
	}

	state.status = "blocked";
	state.updated_at = timestamp;
	if (state.blocked_at === null || state.blocked_at === undefined || state.blocked_at === "") {
		state.blocked_at = timestamp;
	}
	state.blocked_on = {
		type: options.blockerType,
		stage: options.stage,
		reason: options.reason,
		task_id: options.taskId ?? null,
		recommended_next_command: options.recommendedNextCommand,
	};

	if (options.markTaskBlocked && options.taskId && Array.isArray(state.tasks)) {
		for (const taskEntry of state.tasks) {
			const task = asRecord(taskEntry);
			if (!task) continue;
			if (task.id === options.taskId) {
				task.status = "blocked";
			}
		}
	}

	await writeYamlFile(statePath, state);

	return {
		statePath,
		blockerPath,
		archivedBlockerPath,
		timestamp,
	};
}

export async function clearMilestoneBlocker(
	options: ClearMilestoneBlockerOptions,
): Promise<ClearMilestoneBlockerResult> {
	const timestamp = options.timestamp ?? new Date().toISOString();
	const blockerPath = path.join(options.milestoneDir, "blocker.md");
	const blockersDir = path.join(options.milestoneDir, "blockers");
	let archivedBlockerPath: string | undefined;

	await fs.mkdir(blockersDir, { recursive: true });

	try {
		const stat = await fs.stat(blockerPath);
		if (stat.isFile()) {
			const archiveName = `${sanitizeFileSegment(timestamp)}-${sanitizeFileSegment(
				options.archiveSuffix ?? "cleared",
			)}.md`;
			archivedBlockerPath = path.join(blockersDir, archiveName);
			await fs.rename(blockerPath, archivedBlockerPath);
		}
	} catch {
		// no active blocker to archive
	}

	return {
		blockerPath,
		archivedBlockerPath,
		timestamp,
	};
}
