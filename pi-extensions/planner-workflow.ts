import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

type PlannerCommandName =
	| "planner"
	| "milestoner"
	| "milestone_start"
	| "tasker"
	| "milestone_harden"
	| "milestone_review"
	| "milestone_finish"
	| "resume_milestone"
	| "replanner";

type ArgMode = "single-required" | "rest-required";

interface CommandSpec {
	description: string;
	usage: string;
	templateName: PlannerCommandName;
	argMode: ArgMode;
	requiresActivePlan: boolean;
	resolveMilestone: boolean;
	resolveTask: boolean;
	requiresStartPreflight: boolean;
	requiredActiveTools?: string[];
}

interface PlanRepoInfo {
	root?: string;
	originUrl?: string;
	defaultBranch?: string;
}

interface PlanMilestone {
	id: string;
	name?: string;
	slug?: string;
	path?: string;
}

interface PlanData {
	planPath: string;
	planDir: string;
	repo: PlanRepoInfo;
	milestones: PlanMilestone[];
}

interface ActivePlanContext {
	repoRoot: string;
	pointerPath: string;
	activePlanDir: string;
	plan: PlanData;
	defaultBranch: string;
}

interface TaskResolution {
	taskId: string;
	milestone: PlanMilestone;
}

interface CompletionPlanContext {
	repoRoot: string;
	pointerPath: string;
	activePlanDir: string;
	plan: PlanData;
}

interface CompletionItem {
	value: string;
	label: string;
}

const STATUS_KEY = "planner-workflow";

const COMMAND_SPECS: Record<PlannerCommandName, CommandSpec> = {
	planner: {
		description: "Create or refresh a deterministic implementation plan and activate it",
		usage: "/planner <workdesc>",
		templateName: "planner",
		argMode: "rest-required",
		requiresActivePlan: false,
		resolveMilestone: false,
		resolveTask: false,
		requiresStartPreflight: false,
	},
	milestoner: {
		description: "Run an end-to-end milestone workflow with deterministic ordering",
		usage: "/milestoner <milestone>",
		templateName: "milestoner",
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: true,
		resolveTask: false,
		requiresStartPreflight: false,
		requiredActiveTools: ["prepare_review"],
	},
	milestone_start: {
		description: "Start a milestone branch with strict preflight checks",
		usage: "/milestone_start <milestone>",
		templateName: "milestone_start",
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: true,
		resolveTask: false,
		requiresStartPreflight: true,
	},
	tasker: {
		description: "Execute one task with checkpointing and per-task commit evidence",
		usage: "/tasker <task-id>",
		templateName: "tasker",
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: false,
		resolveTask: true,
		requiresStartPreflight: false,
	},
	milestone_harden: {
		description: "Run milestone hardening validations and record evidence",
		usage: "/milestone_harden <milestone>",
		templateName: "milestone_harden",
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: true,
		resolveTask: false,
		requiresStartPreflight: false,
	},
	milestone_review: {
		description: "Run milestone review, fix findings, and record review output",
		usage: "/milestone_review <milestone>",
		templateName: "milestone_review",
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: true,
		resolveTask: false,
		requiresStartPreflight: false,
		requiredActiveTools: ["prepare_review"],
	},
	milestone_finish: {
		description: "Finalize milestone completion state",
		usage: "/milestone_finish <milestone>",
		templateName: "milestone_finish",
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: true,
		resolveTask: false,
		requiresStartPreflight: false,
	},
	resume_milestone: {
		description: "Resume a blocked/in-progress milestone from a safe checkpoint",
		usage: "/resume_milestone <milestone>",
		templateName: "resume_milestone",
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: true,
		resolveTask: false,
		requiresStartPreflight: false,
	},
	replanner: {
		description: "Replan a blocked or unrealistic milestone from execution evidence",
		usage: "/replanner <milestone>",
		templateName: "replanner",
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: true,
		resolveTask: false,
		requiresStartPreflight: false,
	},
};

export default function plannerWorkflowExtension(pi: ExtensionAPI) {
	for (const [commandName, spec] of Object.entries(COMMAND_SPECS) as [
		PlannerCommandName,
		CommandSpec,
	][]) {
		pi.registerCommand(commandName, {
			description: `${spec.description} (validated wrapper)`,
			getArgumentCompletions: (prefix) =>
				getArgumentCompletionsForCommand(commandName, spec, prefix, process.cwd()),
			handler: async (rawArgs, ctx) => {
				ctx.ui.setStatus(STATUS_KEY, `Validating /${commandName}...`);
				try {
					await runValidatedCommand(pi, ctx, commandName, spec, rawArgs);
				} catch (error) {
					ctx.ui.notify(formatError(error), "error");
				} finally {
					ctx.ui.setStatus(STATUS_KEY, undefined);
				}
			},
		});
	}
}

async function runValidatedCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	commandName: PlannerCommandName,
	spec: CommandSpec,
	rawArgs: string,
): Promise<void> {
	const parsed = parseArgs(rawArgs);
	const argument = validateArguments(spec, parsed, commandName);

	const repoRoot = await ensureGitRepo(pi, ctx.cwd, commandName);

	let activePlan: ActivePlanContext | undefined;
	let canonicalArg = argument;

	if (spec.requiresActivePlan) {
		activePlan = await validateActivePlanContext(pi, ctx, repoRoot);

		if (spec.resolveMilestone && argument) {
			const milestone = resolveMilestoneSelector(argument, activePlan.plan.milestones);
			const milestoneDir = resolveMilestoneDirectory(activePlan.plan, milestone);
			await ensureMilestoneFiles(milestoneDir);
			canonicalArg = milestone.id;
		}

		if (spec.resolveTask && argument) {
			const taskResolution = await resolveTaskInPlan(activePlan.plan, argument);
			canonicalArg = taskResolution.taskId;
		}

		if (spec.requiresStartPreflight) {
			await enforceMilestoneStartPreconditions(pi, repoRoot, activePlan.defaultBranch);
		}
	}

	if (spec.requiredActiveTools?.length) {
		enforceRequiredActiveTools(pi, spec.requiredActiveTools, commandName);
	}

	const dispatchRawArgs = canonicalArg ?? "";
	const dispatchTokens =
		spec.argMode === "rest-required"
			? parseArgs(dispatchRawArgs).tokens
			: canonicalArg
				? [canonicalArg]
				: [];
	await dispatchPromptWorkflow(
		pi,
		ctx,
		spec.templateName,
		repoRoot,
		dispatchRawArgs,
		dispatchTokens,
	);
}

function getArgumentCompletionsForCommand(
	_commandName: PlannerCommandName,
	spec: CommandSpec,
	prefix: string,
	cwd: string,
): CompletionItem[] | null {
	if (spec.argMode !== "single-required") return null;

	const parsed = parseArgs(prefix);
	if (parsed.tokens.length > 1) return null;
	const needle = (parsed.tokens[0] ?? "").trim();

	if (!spec.requiresActivePlan) return null;
	const completionPlan = loadCompletionPlanContext(cwd);
	if (!completionPlan) return null;

	if (spec.resolveMilestone) {
		const items = collectMilestoneCompletionItems(completionPlan.plan);
		return filterCompletionItems(items, needle);
	}

	if (spec.resolveTask) {
		const items = collectTaskCompletionItems(completionPlan.plan);
		return filterCompletionItems(items, needle);
	}

	return null;
}

function loadCompletionPlanContext(cwd: string): CompletionPlanContext | null {
	const repoRoot = findGitRepoRootSync(cwd);
	if (!repoRoot) return null;

	const pointerPath = path.join(repoRoot, ".pi", "active_plan");
	let pointerRaw: string;
	try {
		pointerRaw = fsSync.readFileSync(pointerPath, "utf8");
	} catch {
		return null;
	}

	const activePlanDir = pointerRaw.split(/\r?\n/)[0]?.trim() ?? "";
	if (!activePlanDir || !path.isAbsolute(activePlanDir)) return null;

	try {
		const stat = fsSync.statSync(activePlanDir);
		if (!stat.isDirectory()) return null;
	} catch {
		return null;
	}

	const planPath = path.join(activePlanDir, "plan.yaml");
	let planRaw: string;
	try {
		planRaw = fsSync.readFileSync(planPath, "utf8");
	} catch {
		return null;
	}

	let plan: PlanData;
	try {
		plan = parsePlanYaml(planRaw, planPath);
	} catch {
		return null;
	}

	return {
		repoRoot,
		pointerPath,
		activePlanDir,
		plan,
	};
}

function findGitRepoRootSync(start: string): string | null {
	let current = path.resolve(start);

	while (true) {
		const gitDir = path.join(current, ".git");
		if (fsSync.existsSync(gitDir)) {
			return current;
		}

		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

function collectMilestoneCompletionItems(plan: PlanData): CompletionItem[] {
	const items: CompletionItem[] = [];
	const seen = new Set<string>();

	for (const milestone of plan.milestones) {
		pushCompletion(items, seen, {
			value: milestone.id,
			label: milestoneLabel(milestone, "id"),
		});

		if (milestone.slug && milestone.slug !== milestone.id) {
			pushCompletion(items, seen, {
				value: milestone.slug,
				label: milestoneLabel(milestone, "slug"),
			});
		}

		const dirName = milestoneDirectoryName(milestone.path);
		if (dirName && dirName !== milestone.id && dirName !== milestone.slug) {
			pushCompletion(items, seen, {
				value: dirName,
				label: milestoneLabel(milestone, "directory"),
			});
		}
	}

	return items;
}

function collectTaskCompletionItems(plan: PlanData): CompletionItem[] {
	const byTaskId = new Map<string, Set<string>>();

	for (const milestone of plan.milestones) {
		let milestoneDir: string;
		try {
			milestoneDir = resolveMilestoneDirectory(plan, milestone);
		} catch {
			continue;
		}

		const specPath = path.join(milestoneDir, "spec.yaml");
		const statePath = path.join(milestoneDir, "state.yaml");
		const ids = new Set<string>();

		for (const candidatePath of [specPath, statePath]) {
			try {
				for (const id of readTaskIdsFromYamlSync(candidatePath)) {
					ids.add(id);
				}
			} catch {
				// ignore best-effort completion reads
			}
		}

		for (const id of ids) {
			const owners = byTaskId.get(id) ?? new Set<string>();
			owners.add(milestone.id);
			byTaskId.set(id, owners);
		}
	}

	const items = Array.from(byTaskId.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([taskId, owners]) => ({
			value: taskId,
			label:
				owners.size > 1
					? `${taskId} (ambiguous: ${Array.from(owners).sort().join(", ")})`
					: `${taskId} (${Array.from(owners)[0]})`,
		}));

	return items;
}

function pushCompletion(items: CompletionItem[], seen: Set<string>, item: CompletionItem): void {
	if (!item.value.trim()) return;
	if (seen.has(item.value)) return;
	seen.add(item.value);
	items.push(item);
}

function milestoneLabel(milestone: PlanMilestone, source: "id" | "slug" | "directory"): string {
	const meta = [milestone.id, milestone.slug].filter(Boolean).join(" / ");
	return `${source}: ${meta}`;
}

function filterCompletionItems(items: CompletionItem[], needle: string): CompletionItem[] | null {
	const normalizedNeedle = needle.trim().toLowerCase();
	const filtered = normalizedNeedle
		? items.filter(
				(item) =>
					item.value.toLowerCase().startsWith(normalizedNeedle) ||
					item.label.toLowerCase().includes(normalizedNeedle),
			)
		: items;

	if (filtered.length === 0) return null;
	return filtered.slice(0, 80);
}

function validateArguments(
	spec: CommandSpec,
	parsed: { raw: string; tokens: string[] },
	commandName: PlannerCommandName,
): string {
	if (spec.argMode === "rest-required") {
		if (!parsed.raw) {
			throw new Error(`Usage: ${spec.usage}`);
		}
		return parsed.raw;
	}

	if (parsed.tokens.length !== 1) {
		throw new Error(`Usage: ${spec.usage}`);
	}

	const value = parsed.tokens[0]?.trim();
	if (!value) {
		throw new Error(`Usage: ${spec.usage}`);
	}

	if (value.startsWith("-") && commandName !== "planner") {
		throw new Error(`Usage: ${spec.usage}`);
	}

	return value;
}

async function ensureGitRepo(pi: ExtensionAPI, cwd: string, commandName: PlannerCommandName): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code !== 0) {
		const prefix = commandName === "planner" ? "/planner requires" : `/${commandName} requires`;
		throw new Error(`${prefix} running inside a git repository.`);
	}
	const repoRoot = result.stdout.trim();
	if (!repoRoot) {
		throw new Error("Failed to resolve repository root.");
	}
	return repoRoot;
}

async function validateActivePlanContext(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoRoot: string,
): Promise<ActivePlanContext> {
	const pointerPath = path.join(repoRoot, ".pi", "active_plan");
	const activePlanDir = await loadActivePlanPointer(pointerPath);
	const planPath = path.join(activePlanDir, "plan.yaml");
	const plan = await loadPlanData(planPath);

	await validateRepoIdentity(pi, ctx, repoRoot, plan, pointerPath);

	const defaultBranch = plan.repo.defaultBranch?.trim();
	if (!defaultBranch) {
		throw new Error(`Missing repo.default_branch in ${planPath}.`);
	}

	return {
		repoRoot,
		pointerPath,
		activePlanDir,
		plan,
		defaultBranch,
	};
}

async function loadActivePlanPointer(pointerPath: string): Promise<string> {
	let raw: string;
	try {
		raw = await fs.readFile(pointerPath, "utf8");
	} catch {
		throw new Error(
			`Active plan pointer missing/unreadable: ${pointerPath}. Run /planner <workdesc> first (or restore this pointer).`,
		);
	}

	const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? "";
	if (!firstLine) {
		throw new Error(
			`Active plan pointer is empty: ${pointerPath}. Run /planner <workdesc> to recreate it.`,
		);
	}
	if (!path.isAbsolute(firstLine)) {
		throw new Error(
			`Active plan pointer must contain an absolute plan path: ${pointerPath}. Found: ${firstLine}`,
		);
	}

	try {
		const stat = await fs.stat(firstLine);
		if (!stat.isDirectory()) {
			throw new Error();
		}
	} catch {
		throw new Error(
			`Active plan directory does not exist: ${firstLine}. Run /planner <workdesc> or fix ${pointerPath}.`,
		);
	}

	return firstLine;
}

async function loadPlanData(planPath: string): Promise<PlanData> {
	let raw: string;
	try {
		raw = await fs.readFile(planPath, "utf8");
	} catch {
		throw new Error(`Missing/unreadable plan index: ${planPath}`);
	}
	return parsePlanYaml(raw, planPath);
}

function parsePlanYaml(raw: string, planPath: string): PlanData {
	const repo: PlanRepoInfo = {};
	const milestones: PlanMilestone[] = [];
	const lines = raw.split(/\r?\n/);

	let section: "repo" | "milestones" | undefined;
	let currentMilestone: Partial<PlanMilestone> | undefined;

	const flushMilestone = () => {
		if (!currentMilestone) return;
		if (!currentMilestone.id) {
			currentMilestone = undefined;
			return;
		}
		milestones.push({
			id: currentMilestone.id,
			name: currentMilestone.name,
			slug: currentMilestone.slug,
			path: currentMilestone.path,
		});
		currentMilestone = undefined;
	};

	for (const line of lines) {
		const trimmed = stripInlineComment(line).trim();
		if (!trimmed) continue;

		if (!line.startsWith(" ")) {
			if (section === "milestones") flushMilestone();
			section = undefined;

			if (trimmed === "repo:") {
				section = "repo";
				continue;
			}
			if (trimmed === "milestones:") {
				section = "milestones";
				continue;
			}
			continue;
		}

		if (section === "repo") {
			const field = parseIndentedField(line, 2);
			if (!field) continue;
			const value = parseYamlScalar(field.value);
			switch (field.key) {
				case "root":
					repo.root = value;
					break;
				case "origin_url":
					repo.originUrl = value;
					break;
				case "default_branch":
					repo.defaultBranch = value;
					break;
				default:
					break;
			}
			continue;
		}

		if (section === "milestones") {
			const entryStart = line.match(/^\s{2}-\s*(.*)$/);
			if (entryStart) {
				flushMilestone();
				currentMilestone = {};
				const inline = parseInlineField(entryStart[1]);
				if (inline) {
					assignMilestoneField(currentMilestone, inline.key, parseYamlScalar(inline.value));
				}
				continue;
			}

			if (!currentMilestone) continue;
			const field = parseIndentedField(line, 4);
			if (!field) continue;
			assignMilestoneField(currentMilestone, field.key, parseYamlScalar(field.value));
		}
	}

	if (section === "milestones") flushMilestone();

	const planDir = path.dirname(planPath);
	return {
		planPath,
		planDir,
		repo,
		milestones,
	};
}

function parseIndentedField(line: string, indent: number): { key: string; value: string } | null {
	const re = new RegExp(`^\\s{${indent}}([A-Za-z0-9_]+):\\s*(.*)$`);
	const match = line.match(re);
	if (!match) return null;
	return { key: match[1], value: match[2] ?? "" };
}

function parseInlineField(text: string): { key: string; value: string } | null {
	const match = text.trim().match(/^([A-Za-z0-9_]+):\s*(.*)$/);
	if (!match) return null;
	return { key: match[1], value: match[2] ?? "" };
}

function assignMilestoneField(milestone: Partial<PlanMilestone>, key: string, value: string | undefined): void {
	if (!value) return;
	switch (key) {
		case "id":
			milestone.id = value;
			break;
		case "name":
			milestone.name = value;
			break;
		case "slug":
			milestone.slug = value;
			break;
		case "path":
			milestone.path = value;
			break;
		default:
			break;
	}
}

function parseYamlScalar(rawValue: string): string | undefined {
	let value = stripInlineComment(rawValue).trim();
	if (!value || value === "null" || value === "~") return undefined;

	if (
		(value.startsWith("\"") && value.endsWith("\"")) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}
	return value.trim() || undefined;
}

async function validateRepoIdentity(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoRoot: string,
	plan: PlanData,
	pointerPath: string,
): Promise<void> {
	if (plan.repo.root) {
		const [resolvedCurrent, resolvedPlanned] = await Promise.all([
			normalizePathForComparison(repoRoot),
			normalizePathForComparison(plan.repo.root),
		]);

		if (resolvedCurrent !== resolvedPlanned) {
			throw new Error(
				[
					"Active plan repo root does not match current repository.",
					`Current repo root: ${resolvedCurrent}`,
					`Plan repo root:    ${resolvedPlanned}`,
					`Pointer file: ${pointerPath}`,
				].join("\n"),
			);
		}
	}

	if (!plan.repo.originUrl) {
		ctx.ui.notify("Plan repo.origin_url is missing; skipping origin match check.", "warning");
		return;
	}

	const origin = await pi.exec("git", ["-C", repoRoot, "remote", "get-url", "origin"]);
	if (origin.code !== 0) {
		ctx.ui.notify("Could not resolve current git origin (best-effort check skipped).", "warning");
		return;
	}

	const currentOrigin = origin.stdout.trim();
	if (!currentOrigin) {
		ctx.ui.notify("Current git origin URL is empty (best-effort check skipped).", "warning");
		return;
	}

	if (normalizeOriginUrl(currentOrigin) !== normalizeOriginUrl(plan.repo.originUrl)) {
		throw new Error(
			[
				"Active plan origin_url does not match current repository origin.",
				`Current origin: ${currentOrigin}`,
				`Plan origin:    ${plan.repo.originUrl}`,
				"Run /planner to create a plan for this repository (or restore the correct .pi/active_plan pointer).",
			].join("\n"),
		);
	}
}

async function normalizePathForComparison(value: string): Promise<string> {
	try {
		return await fs.realpath(value);
	} catch {
		return path.resolve(value);
	}
}

function normalizeOriginUrl(raw: string): string {
	const input = raw.trim();
	if (!input) return "";

	if (input.startsWith("git@")) {
		const withoutUser = input.slice(4);
		const split = withoutUser.split(":");
		if (split.length === 2) {
			return `${split[0]}/${split[1]}`.replace(/\.git$/i, "").replace(/\/+$/, "");
		}
	}

	if (input.startsWith("ssh://") || input.startsWith("http://") || input.startsWith("https://")) {
		try {
			const url = new URL(input);
			return `${url.hostname}${url.pathname}`.replace(/\.git$/i, "").replace(/\/+$/, "");
		} catch {
			return input.replace(/\.git$/i, "").replace(/\/+$/, "");
		}
	}

	return input.replace(/\.git$/i, "").replace(/\/+$/, "");
}

function resolveMilestoneSelector(selector: string, milestones: PlanMilestone[]): PlanMilestone {
	if (milestones.length === 0) {
		throw new Error("No milestones found in active plan. Run /planner (or repair plan.yaml).");
	}

	const target = selector.trim();
	const matches = milestones.filter((milestone) => {
		if (milestone.id === target) return true;
		if (milestone.slug === target) return true;
		const dirName = milestoneDirectoryName(milestone.path);
		return dirName === target;
	});

	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		throw new Error(
			`Milestone selector '${target}' is ambiguous. Use milestone id explicitly (${matches
				.map((m) => m.id)
				.join(", ")}).`,
		);
	}

	const available = milestones
		.map((m) => `${m.id}${m.slug ? ` (${m.slug})` : ""}`)
		.join(", ");
	throw new Error(`Milestone '${target}' not found in active plan. Available: ${available}`);
}

function milestoneDirectoryName(milestonePath: string | undefined): string | undefined {
	if (!milestonePath) return undefined;
	const clean = milestonePath.replace(/[\\/]+$/, "");
	if (!clean) return undefined;
	return path.basename(clean);
}

function resolveMilestoneDirectory(plan: PlanData, milestone: PlanMilestone): string {
	if (!milestone.path) {
		throw new Error(`Milestone ${milestone.id} is missing path in ${plan.planPath}.`);
	}
	return path.resolve(plan.planDir, milestone.path);
}

async function ensureMilestoneFiles(milestoneDir: string): Promise<void> {
	const required = [
		path.join(milestoneDir, "spec.yaml"),
		path.join(milestoneDir, "state.yaml"),
		path.join(milestoneDir, "execution.md"),
	];

	for (const filePath of required) {
		try {
			const stat = await fs.stat(filePath);
			if (!stat.isFile()) throw new Error();
		} catch {
			throw new Error(`Milestone file missing/unreadable: ${filePath}`);
		}
	}
}

async function resolveTaskInPlan(plan: PlanData, taskId: string): Promise<TaskResolution> {
	const cleanTaskId = taskId.trim();
	if (!cleanTaskId) {
		throw new Error("Task id is empty.");
	}

	const matches: TaskResolution[] = [];

	for (const milestone of plan.milestones) {
		const milestoneDir = resolveMilestoneDirectory(plan, milestone);
		const specPath = path.join(milestoneDir, "spec.yaml");
		const statePath = path.join(milestoneDir, "state.yaml");
		const [specIds, stateIds] = await Promise.all([
			readTaskIdsFromYaml(specPath),
			readTaskIdsFromYaml(statePath),
		]);

		if (specIds.has(cleanTaskId) || stateIds.has(cleanTaskId)) {
			matches.push({
				taskId: cleanTaskId,
				milestone,
			});
		}
	}

	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		throw new Error(
			`Task id '${cleanTaskId}' is ambiguous across milestones (${matches
				.map((m) => m.milestone.id)
				.join(", ")}). Use unique task ids in specs/states.`,
		);
	}

	throw new Error(`Task '${cleanTaskId}' not found in active plan milestones.`);
}

async function readTaskIdsFromYaml(filePath: string): Promise<Set<string>> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, "utf8");
	} catch {
		throw new Error(`Missing/unreadable milestone file: ${filePath}`);
	}

	return parseTaskIdsFromYaml(raw);
}

function readTaskIdsFromYamlSync(filePath: string): Set<string> {
	let raw: string;
	try {
		raw = fsSync.readFileSync(filePath, "utf8");
	} catch {
		throw new Error(`Missing/unreadable milestone file: ${filePath}`);
	}

	return parseTaskIdsFromYaml(raw);
}

function parseTaskIdsFromYaml(raw: string): Set<string> {
	const lines = raw.split(/\r?\n/);
	const ids = new Set<string>();
	let inTasks = false;
	let tasksIndent = 0;
	let taskEntryIndent: number | undefined;
	let currentTaskFieldIndent: number | undefined;

	for (const line of lines) {
		const trimmed = stripInlineComment(line).trim();
		if (!inTasks) {
			if (trimmed === "tasks:") {
				inTasks = true;
				tasksIndent = countLeadingSpaces(line);
				taskEntryIndent = undefined;
				currentTaskFieldIndent = undefined;
			}
			continue;
		}

		if (!trimmed) continue;

		const indent = countLeadingSpaces(line);
		if (indent <= tasksIndent) {
			inTasks = false;
			taskEntryIndent = undefined;
			currentTaskFieldIndent = undefined;
			continue;
		}

		const isListEntry = trimmed.startsWith("-");
		if (taskEntryIndent === undefined) {
			if (!isListEntry) continue;
			taskEntryIndent = indent;
			currentTaskFieldIndent = undefined;
			const entryId = parseTaskIdLine(trimmed);
			if (entryId) ids.add(entryId);
			continue;
		}

		if (isListEntry && indent === taskEntryIndent) {
			currentTaskFieldIndent = undefined;
			const entryId = parseTaskIdLine(trimmed);
			if (entryId) ids.add(entryId);
			continue;
		}

		if (indent <= taskEntryIndent) {
			currentTaskFieldIndent = undefined;
			continue;
		}

		if (currentTaskFieldIndent === undefined) {
			currentTaskFieldIndent = indent;
		}

		if (indent === currentTaskFieldIndent) {
			const entryId = parseTaskIdLine(trimmed);
			if (entryId) ids.add(entryId);
		}
	}

	return ids;
}

function parseTaskIdLine(trimmedLine: string): string | undefined {
	const listMatch = trimmedLine.match(/^[-]\s*id:\s*(.+)$/);
	if (listMatch) return parseYamlScalar(stripInlineComment(listMatch[1]));

	const nestedMatch = trimmedLine.match(/^id:\s*(.+)$/);
	if (nestedMatch) return parseYamlScalar(stripInlineComment(nestedMatch[1]));

	return undefined;
}

function stripInlineComment(value: string): string {
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (ch === "#" && !inSingle && !inDouble) {
			return value.slice(0, i).trimEnd();
		}
	}
	return value;
}

function countLeadingSpaces(line: string): number {
	let count = 0;
	while (count < line.length && line[count] === " ") count += 1;
	return count;
}

async function enforceMilestoneStartPreconditions(
	pi: ExtensionAPI,
	repoRoot: string,
	defaultBranch: string,
): Promise<void> {
	const branch = await pi.exec("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch.code !== 0) {
		throw new Error("Failed to determine current git branch.");
	}
	const currentBranch = branch.stdout.trim();
	if (!currentBranch) {
		throw new Error("Current branch is empty/unresolved.");
	}

	if (currentBranch !== defaultBranch) {
		throw new Error(
			`/milestone_start requires current branch '${defaultBranch}', but found '${currentBranch}'.`,
		);
	}

	const status = await pi.exec("git", [
		"-C",
		repoRoot,
		"status",
		"--porcelain",
		"--untracked-files=no",
	]);
	if (status.code !== 0) {
		throw new Error("Failed to check git working tree status.");
	}
	if (status.stdout.trim()) {
		throw new Error(
			"/milestone_start requires no staged or unstaged tracked changes (untracked files are ignored).",
		);
	}
}

function enforceRequiredActiveTools(
	pi: ExtensionAPI,
	requiredToolNames: string[],
	commandName: PlannerCommandName,
): void {
	const allTools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
	const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
	const allToolNames = new Set(allTools.map((tool) => tool.name));
	const activeToolNames = new Set(activeTools);

	const missing = requiredToolNames.filter((name) => !allToolNames.has(name));
	if (missing.length > 0) {
		throw new Error(
			[
				`/${commandName} requires active review tooling before it can run.`,
				`Missing tool(s): ${missing.join(", ")}`,
				"Install or reload the agenttools pi package, then retry.",
				"If the package is already installed, run /reload.",
			].join("\n"),
		);
	}

	const inactive = requiredToolNames.filter((name) => !activeToolNames.has(name));
	if (inactive.length > 0) {
		throw new Error(
			[
				`/${commandName} requires active review tooling before it can run.`,
				`Inactive tool(s): ${inactive.join(", ")}`,
				"Enable the tool in the current pi runtime and retry.",
				"If you just installed or updated the package, run /reload.",
			].join("\n"),
		);
	}
}

async function dispatchPromptWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	commandName: PlannerCommandName,
	repoRoot: string,
	rawArgs: string,
	tokens: string[],
): Promise<void> {
	const templatePath = resolveTemplatePath(pi, commandName, repoRoot);
	if (!templatePath) {
		throw new Error(`Prompt template for /${commandName} not found.`);
	}

	const template = await fs.readFile(templatePath, "utf8");
	const body = stripFrontmatter(template).trim();
	if (!body) {
		throw new Error(`Prompt template body is empty: ${templatePath}`);
	}

	const expandedPrompt = expandTemplate(body, rawArgs, tokens).trim();
	if (!expandedPrompt) {
		throw new Error(`Expanded prompt is empty for /${commandName}.`);
	}

	if (ctx.isIdle()) {
		pi.sendUserMessage(expandedPrompt);
	} else {
		pi.sendUserMessage(expandedPrompt, { deliverAs: "followUp" });
		ctx.ui.notify(`Queued validated /${commandName} workflow as follow-up.`, "info");
	}
}

function resolveTemplatePath(
	pi: ExtensionAPI,
	commandName: PlannerCommandName,
	repoRoot: string,
): string | undefined {
	const promptEntry = pi
		.getCommands()
		.find((entry) => entry.source === "prompt" && entry.name === commandName && Boolean(entry.path));
	if (promptEntry?.path) return promptEntry.path;

	const fallback = path.join(repoRoot, "pi-prompts", `${commandName}.md`);
	return fallback;
}

function stripFrontmatter(text: string): string {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return text;
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end === -1) return text;
	return lines.slice(end + 1).join("\n");
}

function expandTemplate(template: string, rawArgs: string, tokens: string[]): string {
	let out = template;

	out = out.replace(/\$\{@:([0-9]+)(?::([0-9]+))?\}/g, (_full, startRaw: string, lenRaw?: string) => {
		const start = Number(startRaw);
		if (!Number.isFinite(start) || start < 1) return "";
		const startIndex = start - 1;
		const length = lenRaw !== undefined ? Number(lenRaw) : undefined;
		const chunk = Number.isFinite(length as number)
			? tokens.slice(startIndex, startIndex + Number(length))
			: tokens.slice(startIndex);
		return chunk.join(" ");
	});

	out = out.replace(/\$ARGUMENTS|\$@/g, rawArgs);
	out = out.replace(/\$([1-9][0-9]*)/g, (_full, indexRaw: string) => {
		const index = Number(indexRaw);
		if (!Number.isFinite(index) || index < 1) return "";
		return tokens[index - 1] ?? "";
	});

	return out;
}

function parseArgs(rawArgs: string): { raw: string; tokens: string[] } {
	const raw = rawArgs.trim();
	return {
		raw,
		tokens: splitShellArgs(raw),
	};
}

function splitShellArgs(input: string): string[] {
	const out: string[] = [];
	const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(input)) !== null) {
		const token = match[1] ?? match[2] ?? match[3] ?? "";
		if (token) {
			out.push(token.replace(/\\(["'\\ ])/g, "$1"));
		}
	}
	return out;
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export const __test = {
	parseArgs,
	splitShellArgs,
	parsePlanYaml,
	parseYamlScalar,
	normalizeOriginUrl,
	stripFrontmatter,
	expandTemplate,
	parseTaskIdLine,
	resolveMilestoneSelector,
	parseTaskIdsFromYaml,
	getArgumentCompletionsForCommand,
	collectMilestoneCompletionItems,
	collectTaskCompletionItems,
	loadCompletionPlanContext,
	commandSpecs: COMMAND_SPECS,
};
