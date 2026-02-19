import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type GrnswInvocation = {
	command: string;
	baseArgs: string[];
};

type ParsedArgs = {
	specPath?: string;
	apply: boolean;
	withValidation: boolean;
	reviewer?: string;
	priority: number;
	help: boolean;
};

type ParsedResumeArgs = {
	checkpointPath?: string;
	reviewer?: string;
	help: boolean;
};

type ParsedCheckpointListArgs = {
	help: boolean;
};

type MilestonePlan = {
	title: string;
	acceptance?: string;
};

type PhasePlan = {
	title: string;
	milestones: MilestonePlan[];
};

type SpecPlan = {
	specPath: string;
	epicTitle: string;
	phases: PhasePlan[];
};

type AppliedMilestone = {
	title: string;
	id: string;
	validationId?: string;
};

type AppliedPhase = {
	title: string;
	id: string;
	dependsOn?: string;
	milestones: AppliedMilestone[];
};

type AppliedPlan = {
	epicTitle: string;
	epicId: string;
	phases: AppliedPhase[];
	specPath: string;
};

type RunGrnswOptions = {
	timeoutMs?: number;
	retries?: number;
	retryDelayMs?: number;
	retryOnError?: boolean;
};

type ApplyPlanOptions = {
	checkpointRootDir?: string;
	checkpointPath?: string;
	commandTimeoutMs?: number;
	commandRetries?: number;
	commandRetryDelayMs?: number;
};

type ApplyCheckpointStatus = "in-progress" | "failed" | "completed";

type ApplyCheckpoint = {
	version: 1;
	status: ApplyCheckpointStatus;
	createdAt: string;
	updatedAt: string;
	specPath: string;
	epicTitle: string;
	priority: number;
	withValidation: boolean;
	reviewer: string;
	applied: {
		epicId?: string;
		phases: AppliedPhase[];
	};
	error?: string;
};

type CheckpointListStatus = ApplyCheckpointStatus | "invalid";

type CheckpointListEntry = {
	path: string;
	fileName: string;
	status: CheckpointListStatus;
	mtimeMs: number;
	updatedAt?: string;
	specPath?: string;
	epicTitle?: string;
	reviewer?: string;
	priority?: number;
	withValidation?: boolean;
	error?: string;
};

const STATUS_KEY = "spec-to-grns";
const DEFAULT_GRNSW_TIMEOUT_MS = 30_000;
const DEFAULT_GRNSW_RETRIES = 0;
const DEFAULT_GRNSW_RETRY_DELAY_MS = 250;
const HEALTH_CHECK_RETRIES = 2;

export default function specToGrnsExtension(pi: ExtensionAPI) {
	pi.registerCommand("spec-to-grns", {
		description: "Convert a markdown spec into grns epic/phase/milestone tasks",
		getArgumentCompletions: (prefix) => {
			const options = ["--apply", "--with-validation", "--reviewer", "--priority", "--help"];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((option) => ({ value: option, label: option })) : null;
		},
		handler: async (rawArgs, ctx) => {
			let parsed: ParsedArgs;
			try {
				parsed = parseArgs(rawArgs);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
				ctx.ui.notify("Run /spec-to-grns --help for usage.", "warning");
				return;
			}

			if (parsed.help) {
				publishInfo(pi, usageText(), { usage: true });
				return;
			}

			let specPath: string;
			try {
				specPath = resolveSpecPath(parsed.specPath, ctx.cwd, ctx.hasUI);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
				return;
			}

			let plan: SpecPlan;
			try {
				plan = parseSpecFile(specPath);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
				return;
			}

			const summary = summarizePlan(plan, parsed);

			if (!parsed.apply) {
				publishInfo(
					pi,
					`${summary}\n\nDry-run only. Re-run with --apply to create tasks.`,
					{ plan, parsed, mode: "preview" },
				);
				return;
			}

			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm("Apply /spec-to-grns?", summary);
				if (!ok) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}
			}

			const invocation = resolveGrnswInvocation(ctx.cwd);
			ctx.ui.setStatus(STATUS_KEY, "Creating grns tasks from spec...");

			try {
				await ensureGrnswHealthy(pi, invocation);
				const applied = await applyPlan(pi, invocation, plan, parsed, {
					checkpointRootDir: ctx.cwd,
				});
				publishInfo(pi, formatAppliedSummary(applied, parsed), { applied, parsed, mode: "applied" });
				ctx.ui.notify(`Created epic ${applied.epicId} with ${applied.phases.length} phase(s).`, "info");
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});

	pi.registerCommand("spec-to-grns-resume", {
		description: "Resume a failed /spec-to-grns apply from a checkpoint",
		getArgumentCompletions: (prefix) => {
			const options = ["--reviewer", "--help"];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((option) => ({ value: option, label: option })) : null;
		},
		handler: async (rawArgs, ctx) => {
			let parsed: ParsedResumeArgs;
			try {
				parsed = parseResumeArgs(rawArgs);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
				ctx.ui.notify("Run /spec-to-grns-resume --help for usage.", "warning");
				return;
			}

			if (parsed.help) {
				publishInfo(pi, resumeUsageText(), { usage: true, mode: "resume" });
				return;
			}

			let checkpointPath: string;
			try {
				checkpointPath = resolveResumeCheckpointPath(parsed.checkpointPath, ctx.cwd, ctx.hasUI);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
				return;
			}

			let checkpoint: ApplyCheckpoint;
			try {
				checkpoint = loadApplyCheckpoint(checkpointPath);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
				return;
			}

			let plan: SpecPlan;
			try {
				plan = parseSpecFile(checkpoint.specPath);
				assertCheckpointMatchesPlan(checkpoint, plan);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
				return;
			}

			if (checkpoint.status === "completed") {
				const applied = toAppliedPlanFromCheckpoint(checkpoint, plan);
				publishInfo(pi, formatAppliedSummary(applied, parsedArgsFromCheckpoint(checkpoint)), {
					applied,
					mode: "resume-noop",
					checkpointPath,
				});
				ctx.ui.notify("Checkpoint is already completed. Nothing to resume.", "info");
				return;
			}

			const reviewer = parsed.reviewer ?? checkpoint.reviewer;
			if (reviewer !== checkpoint.reviewer) {
				checkpoint.reviewer = reviewer;
			}

			const summary = summarizeResumePlan(checkpointPath, checkpoint, plan);
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm("Resume /spec-to-grns?", summary);
				if (!ok) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}
			}

			const invocation = resolveGrnswInvocation(ctx.cwd);
			ctx.ui.setStatus(STATUS_KEY, "Resuming grns task creation from checkpoint...");

			try {
				await ensureGrnswHealthy(pi, invocation);
				const applied = await resumePlan(
					pi,
					invocation,
					plan,
					checkpoint,
					checkpointPath,
					{ checkpointRootDir: ctx.cwd },
				);
				publishInfo(pi, formatAppliedSummary(applied, parsedArgsFromCheckpoint(checkpoint)), {
					applied,
					mode: "resumed",
					checkpointPath,
				});
				ctx.ui.notify(`Resumed epic ${applied.epicId}; ${applied.phases.length} phase(s) in checkpoint.`, "info");
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});

	pi.registerCommand("spec-to-grns-checkpoints", {
		description: "List /spec-to-grns checkpoints and optionally resume one",
		getArgumentCompletions: (prefix) => {
			const options = ["--help"];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((option) => ({ value: option, label: option })) : null;
		},
		handler: async (rawArgs, ctx) => {
			let parsed: ParsedCheckpointListArgs;
			try {
				parsed = parseCheckpointListArgs(rawArgs);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
				ctx.ui.notify("Run /spec-to-grns-checkpoints --help for usage.", "warning");
				return;
			}

			if (parsed.help) {
				publishInfo(pi, checkpointListUsageText(), { usage: true, mode: "checkpoints" });
				return;
			}

			const entries = listApplyCheckpoints(ctx.cwd);
			if (entries.length === 0) {
				ctx.ui.notify("No checkpoints found under ./.pi/spec-to-grns/checkpoints", "info");
				return;
			}

			publishInfo(pi, formatCheckpointList(entries, ctx.cwd), {
				mode: "checkpoints",
				entries,
			});

			if (!ctx.hasUI) return;

			const resumable = entries.filter((entry) => entry.status === "failed" || entry.status === "in-progress");
			if (resumable.length === 0) {
				ctx.ui.notify("No resumable checkpoints found.", "info");
				return;
			}

			const optionToEntry = new Map<string, CheckpointListEntry>();
			const options = resumable.map((entry, index) => {
				const label = `${index + 1}. ${formatCheckpointSelectLabel(entry, ctx.cwd)}`;
				optionToEntry.set(label, entry);
				return label;
			});

			const selected = await ctx.ui.select("Select checkpoint to resume", options);
			if (!selected) return;
			const chosen = optionToEntry.get(selected);
			if (!chosen) {
				ctx.ui.notify("Selection not found.", "error");
				return;
			}

			const commandPath = toCommandPath(chosen.path, ctx.cwd);
			const command = `/spec-to-grns-resume ${quoteShellArg(commandPath)}`;
			const ok = await ctx.ui.confirm("Queue resume command?", command);
			if (!ok) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			if (ctx.isIdle()) {
				pi.sendUserMessage(command);
			} else {
				pi.sendUserMessage(command, { deliverAs: "followUp" });
			}
			ctx.ui.notify(`Queued ${command}`, "info");
		},
	});
}

function usageText(): string {
	return [
		"Usage:",
		"  /spec-to-grns [spec-path] [--apply] [--with-validation] [--reviewer <name>] [--priority <0-4>]",
		"",
		"Examples:",
		"  /spec-to-grns spec.md",
		"  /spec-to-grns docs/specs/auth-flow.md --apply",
		"  /spec-to-grns docs/specs/auth-flow.md --apply --with-validation --reviewer alice",
		"",
		"Defaults:",
		"  spec-path: argument, then $SPEC_PATH, then $SPEC_DIR/spec.md, then ./spec.md",
		"  priority: 1",
		"  reviewer: $SPEC_REVIEWER, then $USER, then reviewer",
		"  grnsw timeout: $GRNSW_TIMEOUT_MS (default 30000ms)",
		"  failure checkpoint: ./.pi/spec-to-grns/checkpoints/",
	].join("\n");
}

function resumeUsageText(): string {
	return [
		"Usage:",
		"  /spec-to-grns-resume [checkpoint-path] [--reviewer <name>]",
		"",
		"Examples:",
		"  /spec-to-grns-resume",
		"  /spec-to-grns-resume .pi/spec-to-grns/checkpoints/apply-2026-...-spec.json",
		"  /spec-to-grns-resume --reviewer alice",
		"",
		"Defaults:",
		"  checkpoint-path: latest failed or in-progress checkpoint under ./.pi/spec-to-grns/checkpoints",
	].join("\n");
}

function checkpointListUsageText(): string {
	return [
		"Usage:",
		"  /spec-to-grns-checkpoints",
		"",
		"Examples:",
		"  /spec-to-grns-checkpoints",
		"",
		"Behavior:",
		"  Lists checkpoints under ./.pi/spec-to-grns/checkpoints",
		"  In TUI mode, you can pick a resumable checkpoint and queue /spec-to-grns-resume",
	].join("\n");
}

function parseArgs(rawArgs: string): ParsedArgs {
	const tokens = splitShellArgs(rawArgs);
	const positional: string[] = [];
	const out: ParsedArgs = {
		specPath: undefined,
		apply: false,
		withValidation: false,
		reviewer: undefined,
		priority: 1,
		help: false,
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		switch (token) {
			case "--apply":
				out.apply = true;
				break;
			case "--with-validation":
				out.withValidation = true;
				break;
			case "--reviewer": {
				const value = tokens[++i];
				if (!value || value.startsWith("-")) throw new Error("--reviewer requires a value");
				out.reviewer = value;
				break;
			}
			case "--priority": {
				const value = tokens[++i];
				if (!value || value.startsWith("-")) throw new Error("--priority requires a value");
				if (!/^[0-4]$/.test(value)) {
					throw new Error("--priority must be an integer between 0 and 4");
				}
				out.priority = Number.parseInt(value, 10);
				break;
			}
			case "--help":
			case "-h":
				out.help = true;
				break;
			default:
				if (token.startsWith("--")) {
					throw new Error(`unknown option: ${token}`);
				}
				positional.push(token);
		}
	}

	if (positional.length > 1) throw new Error("only one spec path is supported");
	if (positional.length === 1) out.specPath = positional[0];

	return out;
}

function parseResumeArgs(rawArgs: string): ParsedResumeArgs {
	const tokens = splitShellArgs(rawArgs);
	const positional: string[] = [];
	const out: ParsedResumeArgs = {
		checkpointPath: undefined,
		reviewer: undefined,
		help: false,
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		switch (token) {
			case "--reviewer": {
				const value = tokens[++i];
				if (!value || value.startsWith("-")) throw new Error("--reviewer requires a value");
				out.reviewer = value;
				break;
			}
			case "--help":
			case "-h":
				out.help = true;
				break;
			default:
				if (token.startsWith("--")) {
					throw new Error(`unknown option: ${token}`);
				}
				positional.push(token);
		}
	}

	if (positional.length > 1) throw new Error("only one checkpoint path is supported");
	if (positional.length === 1) out.checkpointPath = positional[0];

	return out;
}

function parseCheckpointListArgs(rawArgs: string): ParsedCheckpointListArgs {
	const tokens = splitShellArgs(rawArgs);
	const out: ParsedCheckpointListArgs = { help: false };

	for (const token of tokens) {
		switch (token) {
			case "--help":
			case "-h":
				out.help = true;
				break;
			default:
				if (token.startsWith("--")) {
					throw new Error(`unknown option: ${token}`);
				}
				throw new Error(`unexpected argument: ${token}`);
		}
	}

	return out;
}

function splitShellArgs(input: string): string[] {
	const out: string[] = [];
	const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(input)) !== null) {
		const token = match[1] ?? match[2] ?? match[3] ?? "";
		if (token !== "") out.push(token.replace(/\\(["'\\ ])/g, "$1"));
	}
	return out;
}

function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (!value) continue;
		if (seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

function resolveSpecPath(inputPath: string | undefined, cwd: string, hasUI: boolean): string {
	const candidates: string[] = [];
	const specDir = process.env.SPEC_DIR?.trim();
	const requested = inputPath?.trim();

	if (requested) {
		candidates.push(requested);
		if (specDir && !path.isAbsolute(requested) && !requested.startsWith("~")) {
			candidates.push(path.join(specDir, requested));
		}
	}

	if (process.env.SPEC_PATH?.trim()) {
		candidates.push(process.env.SPEC_PATH.trim());
	}

	if (specDir) {
		candidates.push(path.join(specDir, "spec.md"));
		try {
			const mdFiles = fs
				.readdirSync(toAbsolutePath(specDir, cwd))
				.filter((entry) => entry.toLowerCase().endsWith(".md"))
				.sort();
			if (mdFiles.length === 1) {
				candidates.push(path.join(specDir, mdFiles[0]));
			}
		} catch {
			// Ignore SPEC_DIR read errors here; we'll fail with a clear message below.
		}
	}

	candidates.push("spec.md");

	for (const candidate of dedupe(candidates)) {
		const resolved = toAbsolutePath(candidate, cwd);
		if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
			return resolved;
		}
	}

	const message = hasUI
		? `No spec file found. Provide a path, e.g. /spec-to-grns docs/specs/feature.md`
		: "No spec file found (tried argument, $SPEC_PATH, $SPEC_DIR/spec.md, and ./spec.md).";
	throw new Error(message);
}

function resolveResumeCheckpointPath(inputPath: string | undefined, cwd: string, hasUI: boolean): string {
	if (inputPath?.trim()) {
		const resolved = toAbsolutePath(inputPath.trim(), cwd);
		if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
			throw new Error(`Checkpoint file not found: ${resolved}`);
		}
		return resolved;
	}

	const entries = listApplyCheckpoints(cwd);
	if (entries.length === 0) {
		const checkpointsDir = getCheckpointDir(cwd);
		const message = hasUI
			? "No checkpoints found. Run /spec-to-grns --apply first."
			: `No checkpoint directory found at ${checkpointsDir}`;
		throw new Error(message);
	}

	const resumable = entries.find((entry) => entry.status === "failed" || entry.status === "in-progress");
	if (!resumable) {
		throw new Error("No resumable checkpoint found (all checkpoints are completed or invalid).");
	}
	return resumable.path;
}

function getCheckpointDir(cwd: string): string {
	return path.join(cwd, ".pi", "spec-to-grns", "checkpoints");
}

function listApplyCheckpoints(cwd: string): CheckpointListEntry[] {
	const checkpointsDir = getCheckpointDir(cwd);
	if (!fs.existsSync(checkpointsDir) || !fs.statSync(checkpointsDir).isDirectory()) {
		return [];
	}

	const entries: CheckpointListEntry[] = [];
	for (const fileName of fs.readdirSync(checkpointsDir)) {
		if (!fileName.toLowerCase().endsWith(".json")) continue;
		const fullPath = path.join(checkpointsDir, fileName);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(fullPath);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;

		try {
			const checkpoint = loadApplyCheckpoint(fullPath);
			entries.push({
				path: fullPath,
				fileName,
				status: checkpoint.status,
				mtimeMs: stat.mtimeMs,
				updatedAt: checkpoint.updatedAt,
				specPath: checkpoint.specPath,
				epicTitle: checkpoint.epicTitle,
				reviewer: checkpoint.reviewer,
				priority: checkpoint.priority,
				withValidation: checkpoint.withValidation,
				error: checkpoint.error,
			});
		} catch (error) {
			entries.push({
				path: fullPath,
				fileName,
				status: "invalid",
				mtimeMs: stat.mtimeMs,
				error: formatError(error),
			});
		}
	}

	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return entries;
}

function formatCheckpointList(entries: CheckpointListEntry[], cwd: string): string {
	const lines: string[] = ["spec-to-grns checkpoints:"];

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const status = formatCheckpointStatus(entry.status);
		const updated = entry.updatedAt ? entry.updatedAt : new Date(entry.mtimeMs).toISOString();
		lines.push(`${i + 1}. [${status}] ${entry.fileName}`);
		lines.push(`   path: ${toDisplayPath(entry.path, cwd)}`);
		lines.push(`   updated: ${updated}`);
		if (entry.epicTitle) lines.push(`   epic: ${entry.epicTitle}`);
		if (entry.specPath) lines.push(`   spec: ${entry.specPath}`);
		if (entry.priority !== undefined) lines.push(`   priority: ${entry.priority}`);
		if (entry.withValidation !== undefined) {
			const validationText = entry.withValidation
				? `yes${entry.reviewer ? ` (reviewer: ${entry.reviewer})` : ""}`
				: "no";
			lines.push(`   validation: ${validationText}`);
		}
		if (entry.error) lines.push(`   error: ${entry.error}`);
	}

	const resumableCount = entries.filter((entry) => entry.status === "failed" || entry.status === "in-progress").length;
	lines.push("");
	lines.push(`Resumable checkpoints: ${resumableCount}`);
	lines.push("Use /spec-to-grns-resume [checkpoint-path] to continue one explicitly.");
	return lines.join("\n");
}

function formatCheckpointSelectLabel(entry: CheckpointListEntry, cwd: string): string {
	const status = formatCheckpointStatus(entry.status);
	const displayPath = toDisplayPath(entry.path, cwd);
	const updated = entry.updatedAt ? entry.updatedAt : new Date(entry.mtimeMs).toISOString();
	const epic = entry.epicTitle ? ` • ${entry.epicTitle}` : "";
	return `[${status}] ${displayPath}${epic} • ${updated}`;
}

function formatCheckpointStatus(status: CheckpointListStatus): string {
	switch (status) {
		case "in-progress":
			return "IN-PROGRESS";
		case "failed":
			return "FAILED";
		case "completed":
			return "COMPLETED";
		default:
			return "INVALID";
	}
}

function toDisplayPath(inputPath: string, cwd: string): string {
	const relative = path.relative(cwd, inputPath);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
		return relative;
	}
	return inputPath;
}

function toCommandPath(inputPath: string, cwd: string): string {
	return toDisplayPath(inputPath, cwd);
}

function quoteShellArg(value: string): string {
	if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value;
	return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function toAbsolutePath(inputPath: string, cwd: string): string {
	const withHome = inputPath.startsWith("~")
		? path.join(os.homedir(), inputPath.slice(1).replace(/^[/\\]/, ""))
		: inputPath;
	return path.isAbsolute(withHome) ? path.normalize(withHome) : path.resolve(cwd, withHome);
}

function loadApplyCheckpoint(checkpointPath: string): ApplyCheckpoint {
	const raw = fs.readFileSync(checkpointPath, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid checkpoint JSON at ${checkpointPath}: ${formatError(error)}`);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error(`Invalid checkpoint payload at ${checkpointPath}: expected object`);
	}

	const data = parsed as Record<string, unknown>;
	if (data.version !== 1) {
		throw new Error(`Unsupported checkpoint version in ${checkpointPath}`);
	}

	const status = data.status;
	if (status !== "in-progress" && status !== "failed" && status !== "completed") {
		throw new Error(`Invalid checkpoint status in ${checkpointPath}`);
	}

	const specPath = readRequiredString(data.specPath, "specPath", checkpointPath);
	const epicTitle = readRequiredString(data.epicTitle, "epicTitle", checkpointPath);
	const reviewer = readRequiredString(data.reviewer, "reviewer", checkpointPath);
	const priority = readRequiredPriority(data.priority, checkpointPath);
	const withValidation = readRequiredBoolean(data.withValidation, "withValidation", checkpointPath);
	const createdAt = readRequiredString(data.createdAt, "createdAt", checkpointPath);
	const updatedAt = readRequiredString(data.updatedAt, "updatedAt", checkpointPath);
	const applied = data.applied;
	if (!applied || typeof applied !== "object") {
		throw new Error(`Invalid checkpoint applied payload in ${checkpointPath}`);
	}

	const appliedRecord = applied as Record<string, unknown>;
	const epicIdRaw = appliedRecord.epicId;
	const epicId = typeof epicIdRaw === "string" && epicIdRaw.trim() ? epicIdRaw.trim() : undefined;
	const phasesRaw = appliedRecord.phases;
	if (!Array.isArray(phasesRaw)) {
		throw new Error(`Invalid checkpoint phases array in ${checkpointPath}`);
	}

	const phases: AppliedPhase[] = phasesRaw.map((phase, phaseIndex) => {
		if (!phase || typeof phase !== "object") {
			throw new Error(`Invalid checkpoint phase at index ${phaseIndex} in ${checkpointPath}`);
		}
		const phaseRecord = phase as Record<string, unknown>;
		const title = readRequiredString(phaseRecord.title, `phases[${phaseIndex}].title`, checkpointPath);
		const id = readRequiredString(phaseRecord.id, `phases[${phaseIndex}].id`, checkpointPath);
		const dependsOnRaw = phaseRecord.dependsOn;
		const dependsOn =
			typeof dependsOnRaw === "string" && dependsOnRaw.trim() ? dependsOnRaw.trim() : undefined;
		const milestonesRaw = phaseRecord.milestones;
		if (!Array.isArray(milestonesRaw)) {
			throw new Error(`Invalid checkpoint milestones for phase ${phaseIndex} in ${checkpointPath}`);
		}
		const milestones: AppliedMilestone[] = milestonesRaw.map((milestone, milestoneIndex) => {
			if (!milestone || typeof milestone !== "object") {
				throw new Error(
					`Invalid checkpoint milestone at phase ${phaseIndex}, index ${milestoneIndex} in ${checkpointPath}`,
				);
			}
			const milestoneRecord = milestone as Record<string, unknown>;
			const milestoneTitle = readRequiredString(
				milestoneRecord.title,
				`phases[${phaseIndex}].milestones[${milestoneIndex}].title`,
				checkpointPath,
			);
			const milestoneId = readRequiredString(
				milestoneRecord.id,
				`phases[${phaseIndex}].milestones[${milestoneIndex}].id`,
				checkpointPath,
			);
			const validationIdRaw = milestoneRecord.validationId;
			const validationId =
				typeof validationIdRaw === "string" && validationIdRaw.trim() ? validationIdRaw.trim() : undefined;
			return {
				title: milestoneTitle,
				id: milestoneId,
				validationId,
			};
		});

		return {
			title,
			id,
			dependsOn,
			milestones,
		};
	});

	if (!epicId && phases.length > 0) {
		throw new Error(`Checkpoint is inconsistent (${checkpointPath}): phases exist but epic id is missing`);
	}

	const checkpoint: ApplyCheckpoint = {
		version: 1,
		status,
		createdAt,
		updatedAt,
		specPath,
		epicTitle,
		priority,
		withValidation,
		reviewer,
		applied: {
			epicId,
			phases,
		},
		error: typeof data.error === "string" && data.error.trim() ? data.error.trim() : undefined,
	};

	return checkpoint;
}

function readRequiredString(value: unknown, field: string, checkpointPath: string): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw new Error(`Invalid checkpoint field '${field}' in ${checkpointPath}`);
}

function readRequiredBoolean(value: unknown, field: string, checkpointPath: string): boolean {
	if (typeof value === "boolean") return value;
	throw new Error(`Invalid checkpoint field '${field}' in ${checkpointPath}`);
}

function readRequiredPriority(value: unknown, checkpointPath: string): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4) return value;
	throw new Error(`Invalid checkpoint field 'priority' in ${checkpointPath}`);
}

const STRUCTURAL_SPEC_HEADINGS = new Set([
	"abstract",
	"rationale",
	"specification",
	"further information",
	"implementation plan",
	"testing plan",
	"documentation plan",
]);

function parseSpecFile(specPath: string): SpecPlan {
	const raw = fs.readFileSync(specPath, "utf8");
	const lines = raw.split(/\r?\n/);

	const fallbackEpicTitle = deriveFallbackEpicTitle(specPath);
	let epicTitle = fallbackEpicTitle;
	let epicTitleSetFromHeading = false;
	const phases: PhasePlan[] = [];
	let currentPhase: PhasePlan | undefined;
	let currentMilestone: { plan: MilestonePlan; body: string[] } | undefined;

	for (const line of lines) {
		const heading = parseHeading(line);
		if (heading) {
			if (heading.level === 1 && !epicTitleSetFromHeading && !isStructuralSpecHeading(heading.title)) {
				epicTitle = heading.title;
				epicTitleSetFromHeading = true;
			}

			if (heading.level <= 2) currentMilestone = undefined;

			if (isPhaseHeading(heading.title)) {
				currentPhase = { title: heading.title, milestones: [] };
				phases.push(currentPhase);
				continue;
			}

			if (isMilestoneHeading(heading.title)) {
				if (!currentPhase) {
					currentPhase = { title: "Phase: Unsorted", milestones: [] };
					phases.push(currentPhase);
				}
				const milestonePlan: MilestonePlan = { title: heading.title };
				currentPhase.milestones.push(milestonePlan);
				currentMilestone = { plan: milestonePlan, body: [] };
				continue;
			}
		}

		const milestoneFromBullet = parseMilestoneBullet(line);
		if (milestoneFromBullet) {
			if (!currentPhase) {
				currentPhase = { title: "Phase: Unsorted", milestones: [] };
				phases.push(currentPhase);
			}
			const milestonePlan: MilestonePlan = { title: milestoneFromBullet };
			currentPhase.milestones.push(milestonePlan);
			currentMilestone = { plan: milestonePlan, body: [] };
			continue;
		}

		if (currentMilestone) {
			currentMilestone.body.push(line);
			const extracted = extractAcceptanceCriteria(currentMilestone.body);
			if (extracted) currentMilestone.plan.acceptance = extracted;
		}
	}

	return {
		specPath,
		epicTitle,
		phases,
	};
}

function parseHeading(line: string): { level: number; title: string } | undefined {
	const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim());
	if (!match) return undefined;
	const title = match[2].trim();
	if (!title) return undefined;
	return { level: match[1].length, title };
}

function deriveFallbackEpicTitle(specPath: string): string {
	const stem = path.basename(specPath, path.extname(specPath));
	const title = stem
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
	return title || "Spec Epic";
}

function normalizeSpecHeading(title: string): string {
	return title.toLowerCase().replace(/[`*_]/g, "").replace(/[:：]/g, "").replace(/\s+/g, " ").trim();
}

function isStructuralSpecHeading(title: string): boolean {
	return STRUCTURAL_SPEC_HEADINGS.has(normalizeSpecHeading(title));
}

function isPhaseHeading(title: string): boolean {
	const normalized = normalizeSpecHeading(title);
	const withoutPrefix = normalized.replace(/^(?:\d+|[ivxlcdm]+)\s*[.)]\s*/, "");
	if (!withoutPrefix.startsWith("phase")) return false;
	if (withoutPrefix.startsWith("phase and milestone")) return false;
	if (/^phase\s+\d+\s+acceptance criteria\b/i.test(withoutPrefix)) return false;
	return true;
}

function isMilestoneHeading(title: string): boolean {
	return /^(?:(?:\d+|[ivxlcdm]+)\s*[.)]\s*)?milestone\b/i.test(title.trim());
}

function parseMilestoneBullet(line: string): string | undefined {
	const trimmed = line.trim();
	if (!/^[-*]\s+/.test(trimmed)) return undefined;

	let body = trimmed.replace(/^[-*]\s+/, "");
	body = body.replace(/^\[[ xX]\]\s*/, "");
	body = body.replace(/^(?:\*\*|__)\s*/, "").replace(/\s*(?:\*\*|__)\s*$/, "");
	body = body.replace(/[`*_]/g, "").trim();
	if (!body) return undefined;

	if (/^m\d+\b/i.test(body)) return body;
	if (/^milestone(?!s\b)\b/i.test(body)) return body;
	return undefined;
}

function extractAcceptanceCriteria(body: string[]): string | undefined {
	const normalized = body.map((line) => line.trim());
	const markerIndex = normalized.findIndex((line) => /success criteria/i.test(line));
	if (markerIndex < 0) return undefined;

	const criteria: string[] = [];
	for (let i = markerIndex + 1; i < normalized.length; i++) {
		const line = normalized[i];
		if (line === "") {
			if (criteria.length > 0) break;
			continue;
		}
		if (/^\*\*.+\*\*$/.test(line) && criteria.length > 0) break;
		if (/^[-*]\s+/.test(line)) {
			criteria.push(line.replace(/^[-*]\s+\[[ xX]\]\s*/, "- ").replace(/^[-*]\s+/, "- "));
		} else if (criteria.length > 0) {
			break;
		}
	}

	return criteria.length > 0 ? criteria.join("\n") : undefined;
}

function summarizePlan(plan: SpecPlan, args: ParsedArgs): string {
	const lines: string[] = [];
	lines.push(`Spec: ${plan.specPath}`);
	lines.push(`Epic: ${plan.epicTitle}`);
	lines.push(`Priority: ${args.priority}`);
	lines.push(`Phases: ${plan.phases.length}`);
	for (const phase of plan.phases) {
		lines.push(`  - ${phase.title} (${phase.milestones.length} milestone${phase.milestones.length === 1 ? "" : "s"})`);
		for (const milestone of phase.milestones) {
			lines.push(`      - ${milestone.title}`);
		}
	}
	if (args.withValidation) {
		const reviewer = args.reviewer ?? process.env.SPEC_REVIEWER ?? process.env.USER ?? "reviewer";
		lines.push(`Validation tasks: yes (reviewer: ${reviewer})`);
	} else {
		lines.push("Validation tasks: no");
	}
	if (plan.phases.length === 0) {
		lines.push("Note: no Phase headings found; only epic will be created.");
	}
	return lines.join("\n");
}

function summarizeResumePlan(checkpointPath: string, checkpoint: ApplyCheckpoint, plan: SpecPlan): string {
	const total = countPlanEntities(plan, checkpoint.withValidation);
	const applied = countAppliedEntities(checkpoint.applied.phases);
	const epicId = checkpoint.applied.epicId ?? "<not created>";
	const lines = [
		`Checkpoint: ${checkpointPath}`,
		`Status: ${checkpoint.status}`,
		`Spec: ${checkpoint.specPath}`,
		`Epic: ${checkpoint.epicTitle}`,
		`Epic id: ${epicId}`,
		`Priority: ${checkpoint.priority}`,
		`Validation tasks: ${checkpoint.withValidation ? `yes (reviewer: ${checkpoint.reviewer})` : "no"}`,
		`Progress: phases ${applied.phaseCount}/${total.phaseCount}, milestones ${applied.milestoneCount}/${total.milestoneCount}, validations ${applied.validationCount}/${total.validationCount}`,
	];
	if (checkpoint.error) {
		lines.push(`Last error: ${checkpoint.error}`);
	}
	return lines.join("\n");
}

function countPlanEntities(
	plan: SpecPlan,
	withValidation: boolean,
): { phaseCount: number; milestoneCount: number; validationCount: number } {
	let milestoneCount = 0;
	for (const phase of plan.phases) {
		milestoneCount += phase.milestones.length;
	}
	return {
		phaseCount: plan.phases.length,
		milestoneCount,
		validationCount: withValidation ? milestoneCount : 0,
	};
}

function parsedArgsFromCheckpoint(checkpoint: ApplyCheckpoint): ParsedArgs {
	return {
		specPath: checkpoint.specPath,
		apply: true,
		withValidation: checkpoint.withValidation,
		reviewer: checkpoint.reviewer,
		priority: checkpoint.priority,
		help: false,
	};
}

function toAppliedPlanFromCheckpoint(checkpoint: ApplyCheckpoint, plan: SpecPlan): AppliedPlan {
	const epicId = checkpoint.applied.epicId;
	if (!epicId) {
		throw new Error("Checkpoint does not contain an epic id yet.");
	}
	return {
		epicTitle: plan.epicTitle,
		epicId,
		phases: checkpoint.applied.phases,
		specPath: checkpoint.specPath,
	};
}

function assertCheckpointMatchesPlan(checkpoint: ApplyCheckpoint, plan: SpecPlan): void {
	if (checkpoint.specPath !== plan.specPath) {
		throw new Error(`Checkpoint spec path mismatch. Checkpoint: ${checkpoint.specPath}, plan: ${plan.specPath}`);
	}
	if (checkpoint.epicTitle !== plan.epicTitle) {
		throw new Error(
			`Checkpoint epic title mismatch. Checkpoint: '${checkpoint.epicTitle}', plan: '${plan.epicTitle}'. The spec changed since apply started.`,
		);
	}
	if (checkpoint.applied.phases.length > plan.phases.length) {
		throw new Error("Checkpoint has more phases than current spec plan.");
	}
	for (let phaseIndex = 0; phaseIndex < checkpoint.applied.phases.length; phaseIndex++) {
		const appliedPhase = checkpoint.applied.phases[phaseIndex];
		const planPhase = plan.phases[phaseIndex];
		if (!planPhase) {
			throw new Error(`Checkpoint phase ${phaseIndex + 1} has no matching phase in current spec.`);
		}
		if (appliedPhase.title !== planPhase.title) {
			throw new Error(
				`Checkpoint phase mismatch at index ${phaseIndex + 1}: '${appliedPhase.title}' vs '${planPhase.title}'.`,
			);
		}
		if (appliedPhase.milestones.length > planPhase.milestones.length) {
			throw new Error(`Checkpoint phase '${appliedPhase.title}' has more milestones than current spec.`);
		}
		for (let milestoneIndex = 0; milestoneIndex < appliedPhase.milestones.length; milestoneIndex++) {
			const appliedMilestone = appliedPhase.milestones[milestoneIndex];
			const planMilestone = planPhase.milestones[milestoneIndex];
			if (!planMilestone) {
				throw new Error(
					`Checkpoint milestone '${appliedMilestone.title}' has no matching milestone in current spec phase '${appliedPhase.title}'.`,
				);
			}
			if (appliedMilestone.title !== planMilestone.title) {
				throw new Error(
					`Checkpoint milestone mismatch in phase '${appliedPhase.title}' at index ${milestoneIndex + 1}: '${appliedMilestone.title}' vs '${planMilestone.title}'.`,
				);
			}
		}
	}
	if (checkpoint.applied.phases.length > 0 && !checkpoint.applied.epicId) {
		throw new Error("Checkpoint is inconsistent: phases exist but epic id is missing.");
	}
}

function resolveGrnswInvocation(cwd: string): GrnswInvocation {
	const configured = process.env.GRNSW_PATH?.trim();
	if (configured) {
		const expanded = toAbsolutePath(configured, cwd);
		if (expanded.endsWith(".py")) {
			return { command: process.env.PYTHON_BIN?.trim() || "python3", baseArgs: [expanded] };
		}
		return { command: expanded, baseArgs: [] };
	}

	const localScript = path.resolve(cwd, "scripts", "grnsw.py");
	if (fs.existsSync(localScript)) {
		return { command: process.env.PYTHON_BIN?.trim() || "python3", baseArgs: [localScript] };
	}

	return { command: "grnsw", baseArgs: [] };
}

async function ensureGrnswHealthy(pi: ExtensionAPI, invocation: GrnswInvocation): Promise<void> {
	const data = await runGrnswJson(pi, invocation, ["doctor"], {
		retries: HEALTH_CHECK_RETRIES,
		retryOnError: true,
	});
	if (!data || data.ok !== true) {
		throw new Error("grnsw doctor failed. Check GRNSW_PATH / grns installation.");
	}
}

async function applyPlan(
	pi: ExtensionAPI,
	invocation: GrnswInvocation,
	plan: SpecPlan,
	args: ParsedArgs,
	options: ApplyPlanOptions = {},
): Promise<AppliedPlan> {
	const reviewer = args.reviewer ?? process.env.SPEC_REVIEWER ?? process.env.USER ?? "reviewer";
	const checkpointRootDir = options.checkpointRootDir ?? process.cwd();
	const checkpointPath = resolveApplyCheckpointPath(plan, checkpointRootDir, options.checkpointPath);
	const runOptions: RunGrnswOptions = {
		timeoutMs: options.commandTimeoutMs,
		retries: options.commandRetries,
		retryDelayMs: options.commandRetryDelayMs,
	};

	const appliedPhases: AppliedPhase[] = [];
	const checkpoint: ApplyCheckpoint = {
		version: 1,
		status: "in-progress",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		specPath: plan.specPath,
		epicTitle: plan.epicTitle,
		priority: args.priority,
		withValidation: args.withValidation,
		reviewer,
		applied: {
			epicId: undefined,
			phases: appliedPhases,
		},
	};

	saveApplyCheckpointOrThrow(checkpointPath, checkpoint);

	try {
		const epicPayload = await runGrnswJson(
			pi,
			invocation,
			[
				"epic",
				"new",
				plan.epicTitle,
				"--priority",
				String(args.priority),
				"--spec-id",
				plan.specPath,
				"--design",
				plan.specPath,
			],
			runOptions,
		);

		const epicId = readStringField(epicPayload, "created_id", "missing epic id from grnsw output");
		checkpoint.applied.epicId = epicId;
		saveApplyCheckpointOrThrow(checkpointPath, checkpoint);

		let previousPhaseId: string | undefined;
		for (const phase of plan.phases) {
			const phaseArgs = [
				"phase",
				"add",
				phase.title,
				"--epic",
				epicId,
				"--priority",
				String(args.priority),
			];
			if (previousPhaseId) {
				phaseArgs.push("--depends-on", previousPhaseId);
			}

			const phasePayload = await runGrnswJson(pi, invocation, phaseArgs, runOptions);
			const phaseId = readStringField(phasePayload, "created_id", `missing phase id for ${phase.title}`);

			const appliedPhase: AppliedPhase = {
				title: phase.title,
				id: phaseId,
				dependsOn: previousPhaseId,
				milestones: [],
			};
			appliedPhases.push(appliedPhase);
			saveApplyCheckpointOrThrow(checkpointPath, checkpoint);

			for (const milestone of phase.milestones) {
				const milestonePayload = await runGrnswJson(
					pi,
					invocation,
					[
						"milestone",
						"add",
						milestone.title,
						"--phase",
						phaseId,
						"--priority",
						String(args.priority),
					],
					runOptions,
				);
				const milestoneId = readStringField(
					milestonePayload,
					"created_id",
					`missing milestone id for ${milestone.title}`,
				);

				let validationId: string | undefined;
				if (args.withValidation) {
					const validationArgs = [
						"validation",
						"add",
						`Validate: ${milestone.title}`,
						"--milestone",
						milestoneId,
						"--reviewer",
						reviewer,
						"--priority",
						String(args.priority),
					];
					if (milestone.acceptance) {
						validationArgs.push("--acceptance", milestone.acceptance);
					}

					const validationPayload = await runGrnswJson(pi, invocation, validationArgs, runOptions);
					validationId = readStringField(
						validationPayload,
						"created_id",
						`missing validation id for ${milestone.title}`,
					);
				}

				appliedPhase.milestones.push({
					title: milestone.title,
					id: milestoneId,
					validationId,
				});
				saveApplyCheckpointOrThrow(checkpointPath, checkpoint);
			}

			previousPhaseId = phaseId;
		}

		checkpoint.status = "completed";
		checkpoint.error = undefined;
		trySaveApplyCheckpoint(checkpointPath, checkpoint);

		return {
			epicTitle: plan.epicTitle,
			epicId,
			phases: appliedPhases,
			specPath: plan.specPath,
		};
	} catch (error) {
		const message = formatError(error);
		checkpoint.status = "failed";
		checkpoint.error = message;
		const checkpointSaveError = trySaveApplyCheckpoint(checkpointPath, checkpoint);
		throw new Error(`${message}\n${formatPartialApplyRecovery(checkpointPath, checkpoint, checkpointSaveError)}`);
	}
}

async function resumePlan(
	pi: ExtensionAPI,
	invocation: GrnswInvocation,
	plan: SpecPlan,
	checkpoint: ApplyCheckpoint,
	checkpointPath: string,
	options: ApplyPlanOptions = {},
): Promise<AppliedPlan> {
	assertCheckpointMatchesPlan(checkpoint, plan);

	const runOptions: RunGrnswOptions = {
		timeoutMs: options.commandTimeoutMs,
		retries: options.commandRetries,
		retryDelayMs: options.commandRetryDelayMs,
	};

	checkpoint.status = "in-progress";
	checkpoint.error = undefined;
	saveApplyCheckpointOrThrow(checkpointPath, checkpoint);

	try {
		let epicId = checkpoint.applied.epicId;
		if (!epicId) {
			const epicPayload = await runGrnswJson(
				pi,
				invocation,
				[
					"epic",
					"new",
					plan.epicTitle,
					"--priority",
					String(checkpoint.priority),
					"--spec-id",
					plan.specPath,
					"--design",
					plan.specPath,
				],
				runOptions,
			);
			epicId = readStringField(epicPayload, "created_id", "missing epic id from grnsw output");
			checkpoint.applied.epicId = epicId;
			saveApplyCheckpointOrThrow(checkpointPath, checkpoint);
		}
		if (!epicId) {
			throw new Error("missing epic id while resuming checkpoint");
		}

		let previousPhaseId: string | undefined;
		for (let phaseIndex = 0; phaseIndex < plan.phases.length; phaseIndex++) {
			const planPhase = plan.phases[phaseIndex];
			let appliedPhase = checkpoint.applied.phases[phaseIndex];

			if (appliedPhase && appliedPhase.title !== planPhase.title) {
				throw new Error(
					`checkpoint mismatch at phase ${phaseIndex + 1}: '${appliedPhase.title}' vs '${planPhase.title}'`,
				);
			}

			if (!appliedPhase) {
				const phaseArgs = [
					"phase",
					"add",
					planPhase.title,
					"--epic",
					epicId,
					"--priority",
					String(checkpoint.priority),
				];
				if (previousPhaseId) {
					phaseArgs.push("--depends-on", previousPhaseId);
				}

				const phasePayload = await runGrnswJson(pi, invocation, phaseArgs, runOptions);
				const phaseId = readStringField(phasePayload, "created_id", `missing phase id for ${planPhase.title}`);
				appliedPhase = {
					title: planPhase.title,
					id: phaseId,
					dependsOn: previousPhaseId,
					milestones: [],
				};
				checkpoint.applied.phases.push(appliedPhase);
				saveApplyCheckpointOrThrow(checkpointPath, checkpoint);
			}

			for (let milestoneIndex = 0; milestoneIndex < planPhase.milestones.length; milestoneIndex++) {
				const planMilestone = planPhase.milestones[milestoneIndex];
				let appliedMilestone = appliedPhase.milestones[milestoneIndex];

				if (appliedMilestone && appliedMilestone.title !== planMilestone.title) {
					throw new Error(
						`checkpoint mismatch in phase '${planPhase.title}' milestone ${milestoneIndex + 1}: '${appliedMilestone.title}' vs '${planMilestone.title}'`,
					);
				}

				if (!appliedMilestone) {
					const milestonePayload = await runGrnswJson(
						pi,
						invocation,
						[
							"milestone",
							"add",
							planMilestone.title,
							"--phase",
							appliedPhase.id,
							"--priority",
							String(checkpoint.priority),
						],
						runOptions,
					);
					const milestoneId = readStringField(
						milestonePayload,
						"created_id",
						`missing milestone id for ${planMilestone.title}`,
					);
					appliedMilestone = {
						title: planMilestone.title,
						id: milestoneId,
					};
					appliedPhase.milestones.push(appliedMilestone);
					saveApplyCheckpointOrThrow(checkpointPath, checkpoint);
				}

				if (checkpoint.withValidation && !appliedMilestone.validationId) {
					const validationArgs = [
						"validation",
						"add",
						`Validate: ${planMilestone.title}`,
						"--milestone",
						appliedMilestone.id,
						"--reviewer",
						checkpoint.reviewer,
						"--priority",
						String(checkpoint.priority),
					];
					if (planMilestone.acceptance) {
						validationArgs.push("--acceptance", planMilestone.acceptance);
					}

					const validationPayload = await runGrnswJson(pi, invocation, validationArgs, runOptions);
					appliedMilestone.validationId = readStringField(
						validationPayload,
						"created_id",
						`missing validation id for ${planMilestone.title}`,
					);
					saveApplyCheckpointOrThrow(checkpointPath, checkpoint);
				}
			}

			if (appliedPhase.milestones.length > planPhase.milestones.length) {
				throw new Error(`checkpoint phase '${appliedPhase.title}' has extra milestones not in current spec`);
			}

			previousPhaseId = appliedPhase.id;
		}

		if (checkpoint.applied.phases.length > plan.phases.length) {
			throw new Error("checkpoint has extra phases not in current spec");
		}

		checkpoint.status = "completed";
		checkpoint.error = undefined;
		trySaveApplyCheckpoint(checkpointPath, checkpoint);

		return toAppliedPlanFromCheckpoint(checkpoint, plan);
	} catch (error) {
		const message = formatError(error);
		checkpoint.status = "failed";
		checkpoint.error = message;
		const checkpointSaveError = trySaveApplyCheckpoint(checkpointPath, checkpoint);
		throw new Error(`${message}\n${formatPartialApplyRecovery(checkpointPath, checkpoint, checkpointSaveError)}`);
	}
}

function resolveApplyCheckpointPath(plan: SpecPlan, checkpointRootDir: string, explicitPath?: string): string {
	if (explicitPath?.trim()) {
		return toAbsolutePath(explicitPath.trim(), checkpointRootDir);
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const specStem = sanitizeFileComponent(path.basename(plan.specPath, path.extname(plan.specPath)) || "spec");
	return path.join(checkpointRootDir, ".pi", "spec-to-grns", "checkpoints", `apply-${stamp}-${specStem}.json`);
}

function sanitizeFileComponent(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function saveApplyCheckpointOrThrow(checkpointPath: string, checkpoint: ApplyCheckpoint): void {
	const error = trySaveApplyCheckpoint(checkpointPath, checkpoint);
	if (error) {
		throw new Error(`failed to write apply checkpoint at ${checkpointPath}: ${error}`);
	}
}

function trySaveApplyCheckpoint(checkpointPath: string, checkpoint: ApplyCheckpoint): string | undefined {
	try {
		checkpoint.updatedAt = new Date().toISOString();
		fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
		fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
		return undefined;
	} catch (error) {
		return formatError(error);
	}
}

function countAppliedEntities(phases: AppliedPhase[]): {
	phaseCount: number;
	milestoneCount: number;
	validationCount: number;
} {
	let milestoneCount = 0;
	let validationCount = 0;
	for (const phase of phases) {
		milestoneCount += phase.milestones.length;
		for (const milestone of phase.milestones) {
			if (milestone.validationId) validationCount += 1;
		}
	}
	return {
		phaseCount: phases.length,
		milestoneCount,
		validationCount,
	};
}

function formatPartialApplyRecovery(
	checkpointPath: string,
	checkpoint: ApplyCheckpoint,
	checkpointSaveError?: string,
): string {
	const counts = countAppliedEntities(checkpoint.applied.phases);
	const epicId = checkpoint.applied.epicId ?? "none";
	const lines = [
		"Partial apply detected; some grns entities were created before the failure.",
		`Checkpoint file: ${checkpointPath}`,
		`Created so far: epic=${epicId}, phases=${counts.phaseCount}, milestones=${counts.milestoneCount}, validations=${counts.validationCount}`,
		"Review this checkpoint and existing tasks before retrying to avoid duplicates.",
	];
	if (checkpointSaveError) {
		lines.splice(1, 0, `Checkpoint write failed: ${checkpointSaveError}`);
	}
	return lines.join("\n");
}

async function runGrnswJson(
	pi: ExtensionAPI,
	invocation: GrnswInvocation,
	args: string[],
	options: RunGrnswOptions = {},
): Promise<Record<string, any>> {
	const commandArgs = [...invocation.baseArgs, "--json", ...args];
	const timeoutMs = resolveGrnswTimeoutMs(options.timeoutMs);
	const retries = resolveGrnswRetries(options.retries);
	const retryDelayMs = resolveGrnswRetryDelayMs(options.retryDelayMs);
	const totalAttempts = retries + 1;

	for (let attempt = 1; attempt <= totalAttempts; attempt++) {
		let result: { code: number; stdout?: string; stderr?: string; killed?: boolean };
		try {
			result =
				timeoutMs > 0
					? await pi.exec(invocation.command, commandArgs, { timeout: timeoutMs })
					: await pi.exec(invocation.command, commandArgs);
		} catch (error) {
			if (attempt < totalAttempts) {
				await delay(retryDelayMs);
				continue;
			}
			throw new Error(withAttemptContext(`grnsw invocation failed: ${formatError(error)}`, attempt, totalAttempts));
		}

		if (result.code !== 0) {
			const stderr = result.stderr?.trim() || "";
			const stdout = result.stdout?.trim() || "";
			const timeoutError = isLikelyTimeoutResult(result);
			const baseError = timeoutError
				? `grnsw timed out after ${timeoutMs}ms`
				: `grnsw failed: ${stderr || stdout || `exit code ${result.code}`}`;
			const shouldRetry = attempt < totalAttempts && (timeoutError || options.retryOnError === true);
			if (shouldRetry) {
				await delay(retryDelayMs);
				continue;
			}
			throw new Error(withAttemptContext(baseError, attempt, totalAttempts));
		}

		const stdout = (result.stdout || "").trim();
		if (!stdout) return {};

		try {
			const parsed = JSON.parse(stdout);
			if (parsed && typeof parsed === "object") return parsed as Record<string, any>;
			throw new Error("grnsw output was not a JSON object");
		} catch (error) {
			throw new Error(`invalid grnsw JSON output: ${formatError(error)}`);
		}
	}

	throw new Error("grnsw failed after retries");
}

function resolveGrnswTimeoutMs(explicit?: number): number {
	const normalized = normalizeNonNegativeInteger(explicit);
	if (normalized !== undefined) return normalized;
	const fromEnv = parseNonNegativeInteger(process.env.GRNSW_TIMEOUT_MS);
	return fromEnv ?? DEFAULT_GRNSW_TIMEOUT_MS;
}

function resolveGrnswRetries(explicit?: number): number {
	const normalized = normalizeNonNegativeInteger(explicit);
	if (normalized !== undefined) return normalized;
	const fromEnv = parseNonNegativeInteger(process.env.GRNSW_RETRIES);
	return fromEnv ?? DEFAULT_GRNSW_RETRIES;
}

function resolveGrnswRetryDelayMs(explicit?: number): number {
	const normalized = normalizeNonNegativeInteger(explicit);
	if (normalized !== undefined) return normalized;
	const fromEnv = parseNonNegativeInteger(process.env.GRNSW_RETRY_DELAY_MS);
	return fromEnv ?? DEFAULT_GRNSW_RETRY_DELAY_MS;
}

function normalizeNonNegativeInteger(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) return undefined;
	return Math.floor(value);
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
	const normalized = value?.trim();
	if (!normalized) return undefined;
	if (!/^\d+$/.test(normalized)) return undefined;
	return Number.parseInt(normalized, 10);
}

function withAttemptContext(message: string, attempt: number, totalAttempts: number): string {
	if (totalAttempts <= 1) return message;
	return `${message} (attempt ${attempt}/${totalAttempts})`;
}

function isLikelyTimeoutResult(result: { code: number; stdout?: string; stderr?: string; killed?: boolean }): boolean {
	if (result.killed === true) return true;
	if (result.code === 124) return true;
	const stderr = (result.stderr || "").toLowerCase();
	if (stderr.includes("timed out") || stderr.includes("timeout")) return true;
	const stdout = (result.stdout || "").toLowerCase();
	return stdout.includes("timed out") || stdout.includes("timeout");
}

async function delay(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function readStringField(payload: Record<string, any>, field: string, fallbackError: string): string {
	const value = payload[field];
	if (typeof value === "string" && value.trim()) return value.trim();
	throw new Error(fallbackError);
}

function formatAppliedSummary(applied: AppliedPlan, args: ParsedArgs): string {
	const lines: string[] = [];
	lines.push(`Created epic ${applied.epicId}: ${applied.epicTitle}`);
	lines.push(`Spec: ${applied.specPath}`);
	lines.push(`Priority: ${args.priority}`);
	for (const phase of applied.phases) {
		const dep = phase.dependsOn ? ` (depends on ${phase.dependsOn})` : "";
		lines.push(`- ${phase.id} ${phase.title}${dep}`);
		for (const milestone of phase.milestones) {
			lines.push(`  - ${milestone.id} ${milestone.title}`);
			if (milestone.validationId) {
				lines.push(`    - ${milestone.validationId} Validate: ${milestone.title}`);
			}
		}
	}
	if (applied.phases.length === 0) {
		lines.push("No phases parsed; only epic created.");
	}
	return lines.join("\n");
}

function publishInfo(pi: ExtensionAPI, content: string, details: Record<string, any>): void {
	pi.sendMessage({
		customType: "spec-to-grns",
		content,
		details,
		display: true,
	});
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export const __test = {
	parseArgs,
	parseResumeArgs,
	parseCheckpointListArgs,
	splitShellArgs,
	resolveSpecPath,
	resolveResumeCheckpointPath,
	loadApplyCheckpoint,
	listApplyCheckpoints,
	formatCheckpointList,
	quoteShellArg,
	parseSpecFile,
	extractAcceptanceCriteria,
	applyPlan,
	resumePlan,
	runGrnswJson,
	deriveFallbackEpicTitle,
	isPhaseHeading,
	isMilestoneHeading,
};
