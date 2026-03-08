import fs from "node:fs/promises";
import path from "node:path";

import { compareTaskAlignment } from "./contracts.ts";
import { loadMilestoneSpecData, loadMilestoneStateData, loadPlanData } from "./plan-files.ts";
import { inspectRepoValidationProfile } from "./repo-inspection.ts";
import { applyMilestoneValidationProfile, composeMilestoneValidationProfile } from "./validation-profile.ts";
import { asRecord, asString, loadYamlFile, writeYamlFile } from "./yaml.ts";

export type PlannerIgnoreStrategy = "git-info-exclude" | "gitignore";

export interface FinalizeGeneratedPlanOptions {
	repoRoot: string;
	planDir: string;
	originUrl?: string;
	defaultBranch?: string;
	forceValidationProfileRefresh?: boolean;
}

export interface FinalizeGeneratedPlanResult {
	planPath: string;
	readmePath: string;
	pointerPath: string;
	ignoreStrategy: PlannerIgnoreStrategy;
	milestoneCount: number;
	repairedValidationMilestoneIds: string[];
	patchedPlanRepoFields: string[];
}

async function ensureFile(filePath: string): Promise<void> {
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) {
			throw new Error();
		}
	} catch {
		throw new Error(`Required planner file missing/unreadable: ${filePath}`);
	}
}

async function appendUniqueLine(filePath: string, line: string): Promise<void> {
	let existing = "";
	try {
		existing = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			throw error;
		}
	}

	const lines = existing.split(/\r?\n/).map((entry) => entry.trim());
	if (lines.includes(line)) {
		return;
	}

	const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
	await fs.appendFile(filePath, `${prefix}${line}\n`, "utf8");
}

async function ensureActivePlanPointerIgnored(repoRoot: string): Promise<PlannerIgnoreStrategy> {
	const ignoreEntry = ".pi/active_plan";
	const excludePath = path.join(repoRoot, ".git", "info", "exclude");
	try {
		await fs.mkdir(path.dirname(excludePath), { recursive: true });
		await appendUniqueLine(excludePath, ignoreEntry);
		return "git-info-exclude";
	} catch {
		const gitignorePath = path.join(repoRoot, ".gitignore");
		await appendUniqueLine(gitignorePath, ignoreEntry);
		return "gitignore";
	}
}

async function appendGitignoreFallbackNote(readmePath: string): Promise<void> {
	const note =
		"Planner note: repo-local active plan pointer is ignored via `.gitignore` fallback because `.git/info/exclude` was not writable during `/planner` finalization.";
	let existing = "";
	try {
		existing = await fs.readFile(readmePath, "utf8");
	} catch {
		throw new Error(`Required planner file missing/unreadable: ${readmePath}`);
	}
	if (existing.includes(note)) {
		return;
	}

	const suffix = existing.endsWith("\n") ? "" : "\n";
	await fs.writeFile(readmePath, `${existing}${suffix}\n## Planner runtime note\n\n${note}\n`, "utf8");
}

async function patchPlanRepoMetadata(options: {
	planPath: string;
	repoRoot: string;
	originUrl?: string;
	defaultBranch?: string;
}): Promise<string[]> {
	const loaded = await loadYamlFile(options.planPath);
	const root = asRecord(loaded);
	if (!root) {
		throw new Error(`Expected top-level mapping in ${options.planPath}.`);
	}
	const repo = asRecord(root.repo) ?? {};
	const patchedFields: string[] = [];

	if (!asString(repo.root)) {
		repo.root = options.repoRoot;
		patchedFields.push("repo.root");
	}
	if (options.originUrl && !asString(repo.origin_url)) {
		repo.origin_url = options.originUrl;
		patchedFields.push("repo.origin_url");
	}
	if (options.defaultBranch && !asString(repo.default_branch)) {
		repo.default_branch = options.defaultBranch;
		patchedFields.push("repo.default_branch");
	}

	if (patchedFields.length > 0) {
		root.repo = repo;
		await writeYamlFile(options.planPath, root);
	}

	return patchedFields;
}

function resolveMilestoneDirectory(planDir: string, milestonePath: string | undefined, milestoneId: string): string {
	if (!milestonePath) {
		throw new Error(`Milestone ${milestoneId} is missing path in plan.yaml.`);
	}
	return path.resolve(planDir, milestonePath);
}

export async function finalizeGeneratedPlan(
	options: FinalizeGeneratedPlanOptions,
): Promise<FinalizeGeneratedPlanResult> {
	const planDir = path.resolve(options.planDir);
	const readmePath = path.join(planDir, "README.md");
	const planPath = path.join(planDir, "plan.yaml");
	await ensureFile(readmePath);
	await ensureFile(planPath);

	const patchedPlanRepoFields = await patchPlanRepoMetadata({
		planPath,
		repoRoot: options.repoRoot,
		originUrl: options.originUrl,
		defaultBranch: options.defaultBranch,
	});
	const plan = await loadPlanData(planPath);
	if (plan.milestones.length === 0) {
		throw new Error(`Generated plan has no milestones: ${planPath}`);
	}

	const inspection = await inspectRepoValidationProfile(options.repoRoot);
	const repairedValidationMilestoneIds: string[] = [];

	for (const milestone of plan.milestones) {
		const milestoneDir = resolveMilestoneDirectory(plan.planDir, milestone.path, milestone.id);
		const specPath = path.join(milestoneDir, "spec.yaml");
		const statePath = path.join(milestoneDir, "state.yaml");
		const milestoneGuidePath = path.join(milestoneDir, "milestone.md");
		const executionPath = path.join(milestoneDir, "execution.md");
		await ensureFile(specPath);
		await ensureFile(statePath);
		await ensureFile(milestoneGuidePath);
		await ensureFile(executionPath);

		const spec = await loadMilestoneSpecData(specPath);
		if (options.forceValidationProfileRefresh || !spec.validation) {
			const profile = composeMilestoneValidationProfile(inspection.validationProfile);
			await applyMilestoneValidationProfile(specPath, profile);
			repairedValidationMilestoneIds.push(milestone.id);
		}

		const verifiedSpec = await loadMilestoneSpecData(specPath);
		if (!verifiedSpec.validation) {
			throw new Error(`Milestone '${milestone.id}' is missing explicit spec.yaml.validation.commands: ${specPath}`);
		}

		const state = await loadMilestoneStateData(statePath);
		const alignment = compareTaskAlignment(verifiedSpec, state);
		if (!alignment.isAligned) {
			throw new Error(
				[
					`Generated milestone '${milestone.id}' has spec/state task drift.`,
					alignment.missingInState.length > 0
						? `Missing in state.yaml: ${alignment.missingInState.join(", ")}`
						: undefined,
					alignment.extraInState.length > 0
						? `Extra in state.yaml: ${alignment.extraInState.join(", ")}`
						: undefined,
				].filter(Boolean).join("\n"),
			);
		}
	}

	const pointerPath = path.join(options.repoRoot, ".pi", "active_plan");
	await fs.mkdir(path.dirname(pointerPath), { recursive: true });
	await fs.writeFile(pointerPath, `${planDir}\n`, "utf8");
	const ignoreStrategy = await ensureActivePlanPointerIgnored(options.repoRoot);
	if (ignoreStrategy === "gitignore") {
		await appendGitignoreFallbackNote(readmePath);
	}

	return {
		planPath,
		readmePath,
		pointerPath,
		ignoreStrategy,
		milestoneCount: plan.milestones.length,
		repairedValidationMilestoneIds,
		patchedPlanRepoFields,
	};
}
