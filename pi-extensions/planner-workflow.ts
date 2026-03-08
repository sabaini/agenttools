import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	loadMilestoneSpecData,
	loadMilestoneStateData,
	loadPlanData as loadStructuredPlanData,
	loadPlanDataSync as loadStructuredPlanDataSync,
	readTaskIdsFromYaml as readStructuredTaskIdsFromYaml,
	readTaskIdsFromYamlSync as readStructuredTaskIdsFromYamlSync,
} from "./planner-runtime/plan-files.ts";
import { blockMilestone, clearMilestoneBlocker } from "./planner-runtime/blockers.ts";
import { compareTaskAlignment } from "./planner-runtime/contracts.ts";
import { appendExecutionSection } from "./planner-runtime/evidence.ts";
import type { MilestoneResultSummary, PlanData, PlanMilestone, TaskExecutionMode } from "./planner-runtime/models.ts";
import { finalizeGeneratedPlan } from "./planner-runtime/plan-finalization.ts";
import { inspectRepoValidationProfile, renderValidationProfileYaml } from "./planner-runtime/repo-inspection.ts";
import { applyMilestoneReplan } from "./planner-runtime/replanner.ts";
import { clearMilestoneResult, writeMilestoneResult } from "./planner-runtime/results.ts";
import { runValidationProfile } from "./planner-runtime/validation-execution.ts";
import { applyMilestoneValidationProfile, composeMilestoneValidationProfile } from "./planner-runtime/validation-profile.ts";
import {
	assertMilestoneCanStart,
	loadMilestoneStateRecord,
	setMilestoneFinished,
	setMilestoneHardeningStart,
	setMilestoneResumed,
	setMilestoneReviewStart,
	setMilestoneStartState,
	setTaskCheckpointStep,
	setTaskExecutionDone,
	setTaskExecutionStart,
} from "./planner-runtime/state.ts";
import { resolveTaskGraph } from "./planner-runtime/task-graph.ts";
import { asRecord, asString } from "./planner-runtime/yaml.ts";
import { prepareReviewRequest } from "./review/core.ts";

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
	argMode: ArgMode;
	requiresActivePlan: boolean;
	resolveMilestone: boolean;
	resolveTask: boolean;
	requiresStartPreflight: boolean;
	requiredActiveTools?: string[];
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
	milestoneDir: string;
}

interface CompletionPlanContext {
	plan: PlanData;
}

interface CompletionItem {
	value: string;
	label: string;
}

const STATUS_KEY = "planner-workflow";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKPOINT_STEPS = [
	"not_started",
	"tests_written",
	"tests_red_verified",
	"implementation_started",
	"tests_green_verified",
	"done",
] as const;
const TASK_OUTCOMES = ["done", "blocked"] as const;
const VALIDATION_KINDS = ["test", "build", "lint", "typecheck", "custom"] as const;
const VALIDATION_ORIGINS = ["canonical", "exploratory"] as const;
const VALIDATION_STAGES = ["hardening", "review"] as const;
const REPLAN_MILESTONE_STATUSES = ["planned", "in_progress"] as const;
const BLOCKER_TYPES = [
	"clarification",
	"test_failure",
	"environment",
	"plan_defect",
	"scope_explosion",
	"external_dependency",
	"unknown",
] as const;

const COMMAND_SPECS: Record<PlannerCommandName, CommandSpec> = {
	planner: {
		description: "Create or refresh a deterministic implementation plan and activate it",
		usage: "/planner <workdesc>",
		argMode: "rest-required",
		requiresActivePlan: false,
		resolveMilestone: false,
		resolveTask: false,
		requiresStartPreflight: false,
	},
	milestoner: {
		description: "Run an end-to-end milestone workflow with deterministic ordering",
		usage: "/milestoner <milestone>",
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
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: true,
		resolveTask: false,
		requiresStartPreflight: true,
	},
	tasker: {
		description: "Execute one task with checkpointing and per-task commit evidence",
		usage: "/tasker <task-id>",
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: false,
		resolveTask: true,
		requiresStartPreflight: false,
	},
	milestone_harden: {
		description: "Run milestone hardening validations and record evidence",
		usage: "/milestone_harden <milestone>",
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: true,
		resolveTask: false,
		requiresStartPreflight: false,
	},
	milestone_review: {
		description: "Run milestone review, fix findings, and record review output",
		usage: "/milestone_review <milestone>",
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
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: true,
		resolveTask: false,
		requiresStartPreflight: false,
	},
	resume_milestone: {
		description: "Resume a blocked/in-progress milestone from a safe checkpoint",
		usage: "/resume_milestone <milestone>",
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: true,
		resolveTask: false,
		requiresStartPreflight: false,
	},
	replanner: {
		description: "Replan a blocked or unrealistic milestone from execution evidence",
		usage: "/replanner <milestone>",
		argMode: "single-required",
		requiresActivePlan: true,
		resolveMilestone: true,
		resolveTask: false,
		requiresStartPreflight: false,
	},
};

export default function plannerWorkflowExtension(pi: ExtensionAPI) {
	if (typeof pi.registerTool === "function") {
		registerPlannerWorkflowTools(pi);
	}

	for (const [commandName, spec] of Object.entries(COMMAND_SPECS) as [
		PlannerCommandName,
		CommandSpec,
	][]) {
		pi.registerCommand(commandName, {
			description: `${spec.description} (validated/native workflow)`,
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

function registerPlannerWorkflowTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "planner_append_execution_section",
		label: "Planner Execution Evidence",
		description: "Append a standardized execution section to milestone execution.md.",
		promptSnippet: "Append milestone execution evidence instead of editing execution.md by hand.",
		promptGuidelines: [
			"Use this tool to record milestone/task execution evidence instead of manually editing execution.md when running planner workflow commands.",
		],
		parameters: Type.Object({
			milestone: Type.String({ description: "Milestone id/slug/directory from the active plan." }),
			title: Type.String({ description: "Section title to append." }),
			body: Type.String({ description: "Markdown body for the section." }),
			timestamp: Type.Optional(Type.String({ description: "ISO timestamp. Defaults to now." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const milestoneContext = await resolveMilestoneToolContext(pi, ctx.cwd, ctx.ui, params.milestone);
			const timestamp = params.timestamp?.trim() || timestampNow();
			const executionPath = path.join(milestoneContext.milestoneDir, "execution.md");
			await appendExecutionSection(executionPath, {
				timestamp,
				title: params.title,
				body: params.body,
			});
			return {
				content: [{ type: "text", text: `Appended execution evidence to ${executionPath}.` }],
				details: {
					milestoneId: milestoneContext.milestone.id,
					executionPath,
					timestamp,
				},
			};
		},
	});

	pi.registerTool({
		name: "planner_task_checkpoint",
		label: "Planner Task Checkpoint",
		description: "Advance a task checkpoint in milestone state.yaml.",
		promptSnippet: "Advance planner task checkpoints natively instead of editing state.yaml by hand.",
		promptGuidelines: [
			"Use this tool whenever a /tasker checkpoint advances.",
		],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id from the active plan." }),
			step: StringEnum(CHECKPOINT_STEPS),
			timestamp: Type.Optional(Type.String({ description: "ISO timestamp. Defaults to now." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const taskContext = await resolveTaskToolContext(pi, ctx.cwd, ctx.ui, params.taskId);
			await runPlanDefectPreflight("tasker", taskContext.milestone, taskContext.milestoneDir);
			const timestamp = params.timestamp?.trim() || timestampNow();
			const statePath = path.join(taskContext.milestoneDir, "state.yaml");
			await ensureTaskToolBranchContext(pi, taskContext);
			await setTaskCheckpointStep(statePath, {
				milestoneId: taskContext.milestone.id,
				taskId: taskContext.taskId,
				step: params.step,
				timestamp,
			});
			return {
				content: [{ type: "text", text: `Recorded checkpoint ${params.step} for task ${taskContext.taskId}.` }],
				details: {
					milestoneId: taskContext.milestone.id,
					taskId: taskContext.taskId,
					step: params.step,
					statePath,
					timestamp,
				},
			};
		},
	});

	pi.registerTool({
		name: "planner_complete_task",
		label: "Planner Complete Task",
		description: "Mark a planner task done and record its commit SHA.",
		promptSnippet: "Complete planner tasks natively instead of editing state.yaml by hand.",
		promptGuidelines: [
			"Use this tool after the mandatory task commit is created so the commit SHA is recorded natively.",
		],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id from the active plan." }),
			commitSha: Type.String({ description: "Commit SHA for the successful task commit." }),
			timestamp: Type.Optional(Type.String({ description: "ISO timestamp. Defaults to now." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const taskContext = await resolveTaskToolContext(pi, ctx.cwd, ctx.ui, params.taskId);
			await runPlanDefectPreflight("tasker", taskContext.milestone, taskContext.milestoneDir);
			const timestamp = params.timestamp?.trim() || timestampNow();
			const statePath = path.join(taskContext.milestoneDir, "state.yaml");
			await ensureTaskToolBranchContext(pi, taskContext);
			ctx.ui.notify(
				"planner_complete_task is a low-level recovery tool; prefer planner_finalize_task_outcome for normal /tasker completion.",
				"warning",
			);
			const commitSha = await verifyCommitShaOnCurrentBranch(pi, taskContext.activePlan.repoRoot, params.commitSha);
			await setTaskExecutionDone(statePath, {
				milestoneId: taskContext.milestone.id,
				taskId: taskContext.taskId,
				commitSha,
				timestamp,
			});
			return {
				content: [{ type: "text", text: `Marked task ${taskContext.taskId} done with commit ${commitSha}.` }],
				details: {
					milestoneId: taskContext.milestone.id,
					taskId: taskContext.taskId,
					commitSha,
					statePath,
					timestamp,
				},
			};
		},
	});

	pi.registerTool({
		name: "planner_finalize_task_outcome",
		label: "Planner Finalize Task Outcome",
		description: "Atomically record final task evidence and mark the task done or blocked.",
		promptSnippet: "Finalize /tasker outcomes natively instead of stitching together multiple workflow-file mutations by hand.",
		promptGuidelines: [
			"Prefer this tool at the end of /tasker so final execution evidence, task state, blocker artifacts, and milestone-result.json stay consistent.",
		],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id from the active plan." }),
			outcome: StringEnum(TASK_OUTCOMES),
			summary: Type.String({ description: "Markdown summary of the final task outcome and evidence." }),
			commitSha: Type.Optional(Type.String({ description: "Commit SHA for a successful task completion. Required when outcome is 'done'." })),
			blockerType: Type.Optional(StringEnum(BLOCKER_TYPES)),
			blockerReason: Type.Optional(Type.String({ description: "Optional blocker reason. Defaults to the provided summary." })),
			recommendedNextCommand: Type.Optional(Type.String({ description: "Optional recommended next slash command for blocked outcomes." })),
			timestamp: Type.Optional(Type.String({ description: "ISO timestamp. Defaults to now." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const taskContext = await resolveTaskToolContext(pi, ctx.cwd, ctx.ui, params.taskId);
			await runPlanDefectPreflight("tasker", taskContext.milestone, taskContext.milestoneDir);
			const timestamp = params.timestamp?.trim() || timestampNow();
			const summary = params.summary.trim();
			if (!summary) {
				throw new Error("planner_finalize_task_outcome requires a non-empty summary.");
			}

			const statePath = path.join(taskContext.milestoneDir, "state.yaml");
			const executionPath = path.join(taskContext.milestoneDir, "execution.md");
			await ensureTaskToolBranchContext(pi, taskContext);
			const spec = await loadMilestoneSpecData(path.join(taskContext.milestoneDir, "spec.yaml"));
			const taskSpec = findTaskSpecById(spec, taskContext.taskId);

			if (params.outcome === "done") {
				const requestedCommitSha = params.commitSha?.trim();
				if (!requestedCommitSha) {
					throw new Error("planner_finalize_task_outcome requires commitSha when outcome is 'done'.");
				}
				const commitSha = await verifyCommitShaOnCurrentBranch(pi, taskContext.activePlan.repoRoot, requestedCommitSha);
				await setTaskExecutionDone(statePath, {
					milestoneId: taskContext.milestone.id,
					taskId: taskContext.taskId,
					commitSha,
					timestamp,
				});
				await appendExecutionSection(executionPath, {
					timestamp,
					title: `task \`${taskContext.taskId}\` completed`,
					body: buildTaskOutcomeExecutionSectionBody({
						milestone: taskContext.milestone,
						taskId: taskContext.taskId,
						taskTitle: taskSpec?.title,
						executionMode: taskSpec?.executionMode,
						executionModeReason: taskSpec?.executionModeReason,
						outcome: "done",
						summary,
						commitSha,
					}),
				});
				return {
					content: [{ type: "text", text: `Finalized task ${taskContext.taskId} as done.` }],
					details: {
						milestoneId: taskContext.milestone.id,
						taskId: taskContext.taskId,
						outcome: params.outcome,
						commitSha,
						statePath,
						executionPath,
						timestamp,
					},
				};
			}

			const blockerType = params.blockerType?.trim();
			if (!blockerType) {
				throw new Error("planner_finalize_task_outcome requires blockerType when outcome is 'blocked'.");
			}
			const blockerReason = params.blockerReason?.trim() || summary;
			const state = await loadMilestoneStateData(statePath);
			const recommendedNextCommand =
				params.recommendedNextCommand?.trim() ||
				defaultRecommendedNextCommandForBlockerType(taskContext.milestone.id, blockerType);
			const blocked = await blockMilestone({
				milestoneDir: taskContext.milestoneDir,
				milestoneId: taskContext.milestone.id,
				milestoneSlug: taskContext.milestone.slug,
				stage: "task_execution",
				blockerType,
				reason: blockerReason,
				recommendedNextCommand,
				taskId: taskContext.taskId,
				timestamp,
				markTaskBlocked: true,
			});
			await writeMilestoneResult(taskContext.milestoneDir, {
				milestoneId: taskContext.milestone.id,
				milestoneSlug: taskContext.milestone.slug,
				status: "blocked",
				stage: "task_execution",
				blockerType,
				blockerPath: blocked.blockerPath,
				nextCommand: recommendedNextCommand,
				commitShas: collectCommitShasFromState(state.tasks),
			});
			await appendExecutionSection(executionPath, {
				timestamp,
				title: `task \`${taskContext.taskId}\` blocked`,
				body: buildTaskOutcomeExecutionSectionBody({
					milestone: taskContext.milestone,
					taskId: taskContext.taskId,
					taskTitle: taskSpec?.title,
					executionMode: taskSpec?.executionMode,
					executionModeReason: taskSpec?.executionModeReason,
					outcome: "blocked",
					summary,
					blockerType,
					recommendedNextCommand,
				}),
			});
			return {
				content: [{ type: "text", text: `Finalized task ${taskContext.taskId} as blocked.` }],
				details: {
					milestoneId: taskContext.milestone.id,
					taskId: taskContext.taskId,
					outcome: params.outcome,
					blockerType,
					blockerPath: blocked.blockerPath,
					recommendedNextCommand,
					statePath,
					executionPath,
					timestamp,
				},
			};
		},
	});

	pi.registerTool({
		name: "planner_block_milestone",
		label: "Planner Block Milestone",
		description: "Create or refresh milestone blocker artifacts and blocked state.",
		promptSnippet: "Block planner milestones natively instead of editing blocker.md/state.yaml by hand.",
		promptGuidelines: [
			"Use this tool when planner workflow execution is blocked so blocker.md, blocker history, state.yaml, and milestone-result.json stay consistent.",
		],
		parameters: Type.Object({
			milestone: Type.String({ description: "Milestone id/slug/directory from the active plan." }),
			stage: Type.String({ description: "Workflow stage where execution blocked." }),
			blockerType: StringEnum(BLOCKER_TYPES),
			reason: Type.String({ description: "Human-readable blocker reason." }),
			taskId: Type.Optional(Type.String({ description: "Blocking task id, when applicable." })),
			recommendedNextCommand: Type.Optional(Type.String({ description: "Recommended next slash command." })),
			timestamp: Type.Optional(Type.String({ description: "ISO timestamp. Defaults to now." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const milestoneContext = await resolveMilestoneToolContext(pi, ctx.cwd, ctx.ui, params.milestone);
			const timestamp = params.timestamp?.trim() || timestampNow();
			if (params.taskId?.trim() || params.stage.trim() === "task_execution") {
				ctx.ui.notify(
					"planner_block_milestone is a low-level recovery tool for task execution; prefer planner_finalize_task_outcome for normal /tasker blocking.",
					"warning",
				);
			}
			const state = await loadMilestoneStateData(path.join(milestoneContext.milestoneDir, "state.yaml"));
			const recommendedNextCommand =
				params.recommendedNextCommand?.trim() ||
				defaultRecommendedNextCommandForBlockerType(milestoneContext.milestone.id, params.blockerType);
			const blocked = await blockMilestone({
				milestoneDir: milestoneContext.milestoneDir,
				milestoneId: milestoneContext.milestone.id,
				milestoneSlug: milestoneContext.milestone.slug,
				stage: params.stage,
				blockerType: params.blockerType,
				reason: params.reason,
				recommendedNextCommand,
				taskId: params.taskId?.trim() || undefined,
				timestamp,
				markTaskBlocked: Boolean(params.taskId?.trim()),
			});
			await writeMilestoneResult(milestoneContext.milestoneDir, {
				milestoneId: milestoneContext.milestone.id,
				milestoneSlug: milestoneContext.milestone.slug,
				status: "blocked",
				stage: params.stage,
				blockerType: params.blockerType,
				blockerPath: blocked.blockerPath,
				nextCommand: recommendedNextCommand,
				commitShas: collectCommitShasFromState(state.tasks),
			});
			return {
				content: [{ type: "text", text: `Blocked milestone ${milestoneContext.milestone.id} at stage ${params.stage}.` }],
				details: {
					milestoneId: milestoneContext.milestone.id,
					blockerPath: blocked.blockerPath,
					archivedBlockerPath: blocked.archivedBlockerPath,
					recommendedNextCommand,
					timestamp,
				},
			};
		},
	});

	pi.registerTool({
		name: "planner_apply_validation_profile",
		label: "Planner Apply Validation Profile",
		description: "Stamp or repair a milestone spec.yaml validation block from native repo inspection.",
		promptSnippet: "Apply milestone validation profiles natively instead of hand-editing spec.yaml validation blocks.",
		promptGuidelines: [
			"Use this tool during /planner after creating each milestone spec so spec.yaml.validation.commands stays explicit, normalized, and aligned with repo-derived canonical vs exploratory validation intent.",
		],
		parameters: Type.Object({
			milestone: Type.Optional(Type.String({ description: "Milestone id/slug/directory from the active plan. Use after the plan pointer exists." })),
			specPath: Type.Optional(Type.String({ description: "Path to the milestone spec.yaml file. Use this during initial /planner creation before the active plan is fully established." })),
			includeKinds: Type.Optional(
				Type.Array(StringEnum(VALIDATION_KINDS), {
					description: "If set, only include baseline validation commands with these kinds.",
				}),
			),
			excludeKinds: Type.Optional(
				Type.Array(StringEnum(VALIDATION_KINDS), {
					description: "Baseline validation kinds to omit for this milestone.",
				}),
			),
			additionalCommands: Type.Optional(
				Type.Array(
					Type.Object({
						command: Type.String({ description: "Extra milestone-specific validation command." }),
						label: Type.Optional(Type.String({ description: "Optional human label for the command." })),
						kind: Type.Optional(StringEnum(VALIDATION_KINDS)),
						origin: Type.Optional(StringEnum(VALIDATION_ORIGINS)),
					}),
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const repoRoot = await ensureGitRepo(pi, ctx.cwd, "planner");
			const inspection = await inspectRepoValidationProfile(repoRoot);
			const target = await resolvePlannerValidationTarget(pi, ctx.cwd, ctx.ui, {
				milestone: params.milestone,
				specPath: params.specPath,
			});
			const profile = composeMilestoneValidationProfile(inspection.validationProfile, {
				includeKinds: params.includeKinds,
				excludeKinds: params.excludeKinds,
				additionalCommands: params.additionalCommands,
			});
			await applyMilestoneValidationProfile(target.specPath, profile);
			return {
				content: [{ type: "text", text: `Applied validation profile to ${target.specPath}.` }],
				details: {
					specPath: target.specPath,
					milestoneId: target.milestone?.id,
					commandCount: profile.commands.length,
					validationCommands: profile.commands,
					configSignals: inspection.configSignals,
				},
			};
		},
	});

	pi.registerTool({
		name: "planner_finalize_plan",
		label: "Planner Finalize Plan",
		description: "Verify generated plan structure, repair missing validation profiles, and activate the repo-local plan pointer.",
		promptSnippet: "Finalize /planner outputs natively instead of hand-editing the active pointer or ignore files.",
		promptGuidelines: [
			"Use this tool once after creating README.md, plan.yaml, and milestone files during /planner so the generated plan is verified, missing validation blocks are repaired, the active pointer is written, and ignore handling is applied deterministically.",
		],
		parameters: Type.Object({
			planDir: Type.String({ description: "Absolute or repo-relative path to the generated plan directory." }),
			forceValidationProfileRefresh: Type.Optional(
				Type.Boolean({ description: "If true, refresh every milestone validation block from the native repo baseline instead of repairing only missing ones." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const repoRoot = await ensureGitRepo(pi, ctx.cwd, "planner");
			const planDir = path.isAbsolute(params.planDir)
				? params.planDir
				: path.resolve(ctx.cwd, params.planDir);
			const [originUrl, defaultBranch] = await Promise.all([
				tryGitStdout(pi, repoRoot, ["remote", "get-url", "origin"]),
				detectPlannerDefaultBranchHint(pi, repoRoot),
			]);
			const finalized = await finalizeGeneratedPlan({
				repoRoot,
				planDir,
				originUrl,
				defaultBranch,
				forceValidationProfileRefresh: params.forceValidationProfileRefresh,
			});
			return {
				content: [{ type: "text", text: `Finalized generated plan at ${planDir}. Active pointer: ${finalized.pointerPath}.` }],
				details: {
					planDir,
					planPath: finalized.planPath,
					readmePath: finalized.readmePath,
					pointerPath: finalized.pointerPath,
					ignoreStrategy: finalized.ignoreStrategy,
					milestoneCount: finalized.milestoneCount,
					repairedValidationMilestoneIds: finalized.repairedValidationMilestoneIds,
					patchedPlanRepoFields: finalized.patchedPlanRepoFields,
				},
			};
		},
	});

	pi.registerTool({
		name: "planner_run_validation_profile",
		label: "Planner Run Validation Profile",
		description: "Run milestone validation commands with canonical vs exploratory blocking policy.",
		promptSnippet: "Run milestone validation commands natively instead of manually deciding blocking policy command-by-command.",
		promptGuidelines: [
			"Use this tool during /milestone_harden and /milestone_review so spec.yaml.validation.commands are executed consistently, canonical failures block by default, and exploratory failures are logged unless explicitly escalated.",
		],
		parameters: Type.Object({
			milestone: Type.String({ description: "Milestone id/slug/directory from the active plan." }),
			stage: StringEnum(VALIDATION_STAGES),
			blockingExploratoryKinds: Type.Optional(
				Type.Array(StringEnum(VALIDATION_KINDS), {
					description: "Exploratory validation kinds that should be escalated to blocking for this run.",
				}),
			),
			blockingExploratoryCommands: Type.Optional(
				Type.Array(Type.String({ description: "Exact exploratory validation commands that should be treated as blocking for this run." })),
			),
			note: Type.Optional(Type.String({ description: "Optional rationale/evidence note to include in execution.md for this validation run." })),
			timestamp: Type.Optional(Type.String({ description: "ISO timestamp. Defaults to now." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const milestoneContext = await resolveMilestoneToolContext(pi, ctx.cwd, ctx.ui, params.milestone);
			const commandName = params.stage === "review" ? "milestone_review" : "milestone_harden";
			await runPlanDefectPreflight(commandName, milestoneContext.milestone, milestoneContext.milestoneDir);

			const statePath = path.join(milestoneContext.milestoneDir, "state.yaml");
			const specPath = path.join(milestoneContext.milestoneDir, "spec.yaml");
			const executionPath = path.join(milestoneContext.milestoneDir, "execution.md");
			const [stateRecord, state, spec] = await Promise.all([
				loadMilestoneStateRecord(statePath),
				loadMilestoneStateData(statePath),
				loadMilestoneSpecData(specPath),
			]);
			const expectedBranch = asString(stateRecord.branch);
			if (expectedBranch) {
				await ensureCurrentBranch(pi, milestoneContext.activePlan.repoRoot, expectedBranch, commandName);
			}

			const timestamp = params.timestamp?.trim() || timestampNow();
			const validation = await runValidationProfile({
				commands: spec.validation?.commands ?? [],
				blockingExploratoryKinds: params.blockingExploratoryKinds,
				blockingExploratoryCommands: params.blockingExploratoryCommands,
				executeCommand: async (command) => {
					const result = await pi.exec("bash", ["-lc", command], { cwd: milestoneContext.activePlan.repoRoot });
					return {
						code: result.code,
						stdout: result.stdout,
						stderr: result.stderr,
					};
				},
			});

			await appendExecutionSection(executionPath, {
				timestamp,
				title: `${params.stage} validation`,
				body: buildValidationExecutionSectionBody({
					milestone: milestoneContext.milestone,
					stage: params.stage,
					results: validation.results,
					blockingExploratoryKinds: params.blockingExploratoryKinds,
					blockingExploratoryCommands: params.blockingExploratoryCommands,
					note: params.note,
				}),
			});

			if (validation.blockingFailures.length > 0) {
				const blockerType = chooseValidationBlockerType(validation.blockingFailures[0]);
				const blockerStage = `${params.stage}_validation`;
				const recommendedNextCommand = `/resume_milestone ${milestoneContext.milestone.id}`;
				const blocked = await blockMilestone({
					milestoneDir: milestoneContext.milestoneDir,
					milestoneId: milestoneContext.milestone.id,
					milestoneSlug: milestoneContext.milestone.slug,
					stage: blockerStage,
					blockerType,
					reason: buildValidationBlockerReason(params.stage, validation, params.note),
					recommendedNextCommand,
					timestamp,
				});
				await writeMilestoneResult(milestoneContext.milestoneDir, {
					milestoneId: milestoneContext.milestone.id,
					milestoneSlug: milestoneContext.milestone.slug,
					status: "blocked",
					stage: blockerStage,
					blockerType,
					blockerPath: blocked.blockerPath,
					nextCommand: recommendedNextCommand,
					commitShas: collectCommitShasFromState(state.tasks),
				});
				return {
					content: [{ type: "text", text: `Validation blocked milestone ${milestoneContext.milestone.id} during ${params.stage}.` }],
					details: {
						milestoneId: milestoneContext.milestone.id,
						stage: params.stage,
						blocked: true,
						blockerType,
						blockerPath: blocked.blockerPath,
						nextCommand: recommendedNextCommand,
						blockingFailures: validation.blockingFailures,
						advisoryFailures: validation.advisoryFailures,
						passed: validation.passed,
						executionPath,
						timestamp,
					},
				};
			}

			return {
				content: [{ type: "text", text: `Completed ${params.stage} validation for milestone ${milestoneContext.milestone.id}.` }],
				details: {
					milestoneId: milestoneContext.milestone.id,
					stage: params.stage,
					blocked: false,
					blockingFailures: validation.blockingFailures,
					advisoryFailures: validation.advisoryFailures,
					passed: validation.passed,
					executionPath,
					timestamp,
				},
			};
		},
	});

	pi.registerTool({
		name: "planner_apply_replan",
		label: "Planner Apply Replan",
		description: "Repair milestone state after replanning spec/plan files.",
		promptSnippet: "Finalize replanning natively instead of hand-editing state.yaml, blocker.md, or milestone-result.json.",
		promptGuidelines: [
			"Use this tool after editing spec.yaml/plan.yaml during /replanner so task alignment, checkpoint reset, blocker clearing, execution evidence, and next-command recommendation are handled natively.",
		],
		parameters: Type.Object({
			milestone: Type.String({ description: "Milestone id/slug/directory from the active plan." }),
			summary: Type.String({ description: "Markdown summary of what was wrong and what changed." }),
			checkpointTaskId: Type.Optional(Type.String({ description: "Task id to resume next. Omit to auto-select the next pending task deterministically." })),
			checkpointStep: Type.Optional(StringEnum(CHECKPOINT_STEPS)),
			skippedTaskIds: Type.Optional(
				Type.Array(Type.String({ description: "Task ids that should be marked skipped in the repaired state." })),
			),
			milestoneStatus: Type.Optional(StringEnum(REPLAN_MILESTONE_STATUSES)),
			timestamp: Type.Optional(Type.String({ description: "ISO timestamp. Defaults to now." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const milestoneContext = await resolveMilestoneToolContext(pi, ctx.cwd, ctx.ui, params.milestone);
			const summary = params.summary.trim();
			if (!summary) {
				throw new Error("planner_apply_replan requires a non-empty summary.");
			}

			const timestamp = params.timestamp?.trim() || timestampNow();
			const statePath = path.join(milestoneContext.milestoneDir, "state.yaml");
			const specPath = path.join(milestoneContext.milestoneDir, "spec.yaml");
			const executionPath = path.join(milestoneContext.milestoneDir, "execution.md");
			const spec = await loadMilestoneSpecData(specPath);
			const replanned = await applyMilestoneReplan(statePath, {
				milestoneId: milestoneContext.milestone.id,
				specTasks: spec.tasks,
				milestoneStatus: params.milestoneStatus,
				checkpointTaskId: params.checkpointTaskId?.trim() || undefined,
				checkpointStep: params.checkpointStep,
				skippedTaskIds: params.skippedTaskIds,
				timestamp,
			});
			const clearedBlocker = await clearMilestoneBlocker({
				milestoneDir: milestoneContext.milestoneDir,
				timestamp,
				archiveSuffix: "replanned",
			});
			const clearedResult = await clearMilestoneResult(milestoneContext.milestoneDir);
			await appendExecutionSection(executionPath, {
				timestamp,
				title: "milestone replanned",
				body: [
					`- Command: \`/replanner ${milestoneContext.milestone.id}\``,
					`- Milestone: ${formatResolvedMilestone(milestoneContext.milestone)}`,
					`- Replanned status: \`${replanned.milestoneStatus}\``,
					`- Replanned phase: \`${replanned.milestoneStatus === "planned" ? "not_started" : "task_execution"}\``,
					`- Checkpoint: \`{ task_id: ${replanned.checkpoint.taskId ?? "null"}, step: ${replanned.checkpoint.step} }\``,
					`- Added task ids: ${replanned.addedTaskIds.length > 0 ? replanned.addedTaskIds.join(", ") : "none"}`,
					`- Removed task ids: ${replanned.removedTaskIds.length > 0 ? replanned.removedTaskIds.join(", ") : "none"}`,
					`- Skipped task ids: ${replanned.skippedTaskIds.length > 0 ? replanned.skippedTaskIds.join(", ") : "none"}`,
					clearedBlocker.archivedBlockerPath ? `- Archived blocker: \`${clearedBlocker.archivedBlockerPath}\`` : "- Archived blocker: none",
					clearedResult.removed ? `- Cleared stale result: \`${clearedResult.outputPath}\`` : undefined,
					`- Recommended next command: \`${replanned.nextCommand}\``,
					"",
					"### Replanning summary",
					"",
					summary,
				].filter(Boolean).join("\n"),
			});
			return {
				content: [{ type: "text", text: `Applied native replanning updates for milestone ${milestoneContext.milestone.id}. Recommended next command: ${replanned.nextCommand}.` }],
				details: {
					milestoneId: milestoneContext.milestone.id,
					statePath,
					specPath,
					executionPath,
					archivedBlockerPath: clearedBlocker.archivedBlockerPath,
					clearedResultPath: clearedResult.removed ? clearedResult.outputPath : undefined,
					addedTaskIds: replanned.addedTaskIds,
					removedTaskIds: replanned.removedTaskIds,
					skippedTaskIds: replanned.skippedTaskIds,
					checkpoint: replanned.checkpoint,
					milestoneStatus: replanned.milestoneStatus,
					nextCommand: replanned.nextCommand,
					timestamp,
				},
			};
		},
	});
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
	let resolvedMilestone: PlanMilestone | undefined;
	let resolvedMilestoneDir: string | undefined;
	let resolvedTask: TaskResolution | undefined;

	if (spec.requiresActivePlan) {
		activePlan = await validateActivePlanContext(pi, ctx, repoRoot);

		if (spec.resolveMilestone && argument) {
			resolvedMilestone = resolveMilestoneSelector(argument, activePlan.plan.milestones);
			resolvedMilestoneDir = resolveMilestoneDirectory(activePlan.plan, resolvedMilestone);
			await ensureMilestoneFiles(resolvedMilestoneDir);
			canonicalArg = resolvedMilestone.id;
		}

		if (spec.resolveTask && argument) {
			resolvedTask = await resolveTaskInPlan(activePlan.plan, argument);
			canonicalArg = resolvedTask.taskId;
		}

		if (spec.requiresStartPreflight) {
			await enforceMilestoneStartPreconditions(pi, repoRoot, activePlan.defaultBranch);
		}
	}

	if (commandName === "planner") {
		await runPlannerNativeKickoff(pi, ctx, repoRoot, argument, parsed.tokens);
		return;
	}

	if (spec.requiredActiveTools?.length) {
		enforceRequiredActiveTools(pi, spec.requiredActiveTools, commandName);
	}

	if (commandName === "milestoner" && activePlan && resolvedMilestone && resolvedMilestoneDir) {
		await runMilestonerNative(pi, ctx, activePlan, resolvedMilestone, resolvedMilestoneDir);
		return;
	}

	if (
		commandName === "milestone_start" &&
		activePlan &&
		resolvedMilestone &&
		resolvedMilestoneDir &&
		canonicalArg
	) {
		await runMilestoneStartNative(pi, ctx, activePlan, resolvedMilestone, resolvedMilestoneDir, canonicalArg);
		return;
	}

	if (commandName === "tasker" && activePlan && resolvedTask) {
		await runTaskerNative(pi, ctx, activePlan, resolvedTask);
		return;
	}

	if (commandName === "milestone_harden" && activePlan && resolvedMilestone && resolvedMilestoneDir) {
		await runMilestoneHardenNative(pi, ctx, activePlan, resolvedMilestone, resolvedMilestoneDir);
		return;
	}

	if (commandName === "milestone_review" && activePlan && resolvedMilestone && resolvedMilestoneDir) {
		await runMilestoneReviewNative(pi, ctx, activePlan, resolvedMilestone, resolvedMilestoneDir);
		return;
	}

	if (commandName === "milestone_finish" && activePlan && resolvedMilestone && resolvedMilestoneDir) {
		await runMilestoneFinishNative(pi, ctx, activePlan, resolvedMilestone, resolvedMilestoneDir);
		return;
	}

	if (commandName === "resume_milestone" && activePlan && resolvedMilestone && resolvedMilestoneDir) {
		await runResumeMilestoneNative(pi, ctx, activePlan, resolvedMilestone, resolvedMilestoneDir);
		return;
	}

	if (commandName === "replanner" && activePlan && resolvedMilestone && resolvedMilestoneDir) {
		await runReplannerNative(pi, ctx, activePlan, resolvedMilestone, resolvedMilestoneDir);
		return;
	}

	throw new Error(`/${commandName} is expected to run natively, but no native handler completed.`);
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
	let plan: PlanData;
	try {
		plan = loadStructuredPlanDataSync(planPath);
	} catch {
		return null;
	}

	return {
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

async function resolveMilestoneToolContext(
	pi: ExtensionAPI,
	cwd: string,
	ui: ExtensionCommandContext["ui"],
	selector: string,
): Promise<{ activePlan: ActivePlanContext; milestone: PlanMilestone; milestoneDir: string }> {
	const repoRoot = await ensureGitRepo(pi, cwd, "milestoner");
	const activePlan = await validateActivePlanContext(pi, { cwd, ui } as ExtensionCommandContext, repoRoot);
	const milestone = resolveMilestoneSelector(selector, activePlan.plan.milestones);
	const milestoneDir = resolveMilestoneDirectory(activePlan.plan, milestone);
	await ensureMilestoneFiles(milestoneDir);
	return { activePlan, milestone, milestoneDir };
}

async function resolveTaskToolContext(
	pi: ExtensionAPI,
	cwd: string,
	ui: ExtensionCommandContext["ui"],
	taskId: string,
): Promise<{ activePlan: ActivePlanContext } & TaskResolution> {
	const repoRoot = await ensureGitRepo(pi, cwd, "tasker");
	const activePlan = await validateActivePlanContext(pi, { cwd, ui } as ExtensionCommandContext, repoRoot);
	const resolvedTask = await resolveTaskInPlan(activePlan.plan, taskId);
	return { activePlan, ...resolvedTask };
}

async function resolvePlannerValidationTarget(
	pi: ExtensionAPI,
	cwd: string,
	ui: ExtensionCommandContext["ui"],
	options: { milestone?: string; specPath?: string },
): Promise<{ milestone?: PlanMilestone; milestoneDir?: string; specPath: string }> {
	const milestone = options.milestone?.trim();
	const specPath = options.specPath?.trim();
	if (!milestone && !specPath) {
		throw new Error("planner_apply_validation_profile requires either 'milestone' or 'specPath'.");
	}
	if (milestone && specPath) {
		throw new Error("planner_apply_validation_profile requires exactly one of 'milestone' or 'specPath', not both.");
	}

	if (specPath) {
		return {
			specPath: path.resolve(cwd, specPath),
		};
	}

	const milestoneContext = await resolveMilestoneToolContext(pi, cwd, ui, milestone!);
	return {
		milestone: milestoneContext.milestone,
		milestoneDir: milestoneContext.milestoneDir,
		specPath: path.join(milestoneContext.milestoneDir, "spec.yaml"),
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
	return loadStructuredPlanData(planPath);
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

async function tryGitStdout(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", ["-C", repoRoot, ...args]);
		if (result.code !== 0) {
			return undefined;
		}
		const stdout = result.stdout.trim();
		return stdout || undefined;
	} catch {
		return undefined;
	}
}

async function detectPlannerDefaultBranchHint(pi: ExtensionAPI, repoRoot: string): Promise<string | undefined> {
	const remoteHead = await tryGitStdout(pi, repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
	if (remoteHead) {
		const segments = remoteHead.split("/");
		const branch = segments[segments.length - 1]?.trim();
		if (branch) {
			return branch;
		}
	}

	return tryGitStdout(pi, repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function formatPlannerInspectionLines(
	inspection: Awaited<ReturnType<typeof inspectRepoValidationProfile>>,
): string[] {
	return [
		`- Package manager: ${inspection.packageManager ?? "unresolved"}`,
		`- package.json scripts: ${inspection.scripts.length > 0 ? inspection.scripts.join(", ") : "none"}`,
		`- just targets: ${inspection.justTargets.length > 0 ? inspection.justTargets.join(", ") : "none"}`,
		`- Tooling signals: ${inspection.configSignals.length > 0 ? inspection.configSignals.join(", ") : "none detected"}`,
	];
}

function buildNativePlannerBrief(options: {
	repoRoot: string;
	workDescription: string;
	originUrl?: string;
	defaultBranchHint?: string;
	inspection: Awaited<ReturnType<typeof inspectRepoValidationProfile>>;
}): string {
	const validationYaml = renderValidationProfileYaml(options.inspection.validationProfile);

	return [
		"Continue the native /planner workflow for this repository.",
		"",
		"Native repo inspection already completed:",
		`- Repo root: \`${options.repoRoot}\``,
		`- Work description: ${options.workDescription}`,
		options.originUrl ? `- Git origin: \`${options.originUrl}\`` : "- Git origin: unresolved",
		options.defaultBranchHint
			? `- Default branch hint: \`${options.defaultBranchHint}\``
			: "- Default branch hint: unresolved",
		...formatPlannerInspectionLines(options.inspection),
		"",
		"Milestone-local validation profile requirement:",
		"- Every generated milestone `spec.yaml` must include an explicit `validation:` block.",
		"- Start from the repo-derived baseline below for every milestone, then narrow or extend it explicitly when milestone scope requires that.",
		"- Keep repo-declared commands as `origin: canonical` and guessed fallback commands as `origin: exploratory`.",
		"- Keep validation profiles small, explicit, and deterministic.",
		"- Tasks default to the normal TDD flow; only non-default tasks should declare explicit `execution_mode` plus `execution_mode_reason`.",
		"- Supported non-default task execution modes: `docs_only`, `pure_refactor`, `build_config`, `generated_update`.",
		"",
		"Suggested baseline validation block to copy into each milestone spec:",
		"```yaml",
		...validationYaml,
		"```",
		"",
		"Use native planner tooling for validation-profile stamping and plan finalization:",
		"- After creating each milestone `spec.yaml`, call `planner_apply_validation_profile` with `specPath` to write or normalize the milestone-local `validation.commands` block.",
		"- Use `includeKinds` / `excludeKinds` / `additionalCommands` only when a milestone genuinely needs a narrower or extended profile than the repo baseline.",
		"- Do not leave any milestone spec without an explicit `validation:` block.",
		"- After generating README.md, plan.yaml, and milestone files, call `planner_finalize_plan` exactly once to verify structure, repair any missing validation blocks, write `<repo-root>/.pi/active_plan`, and apply pointer ignore handling deterministically.",
		"",
		"If a milestone truly has no applicable broader validations, keep `validation.commands: []` explicit and explain why in the milestone guide.",
		"Use this native inspection context instead of re-discovering repo tooling unless you find contradictory evidence.",
		"",
		"Native reminder:",
		"- `/planner` plan synthesis may still use model reasoning, but planner-workflow state mutation, validation-profile stamping, and plan finalization are native-tool driven.",
	].filter(Boolean).join("\n");
}

async function runPlannerNativeKickoff(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoRoot: string,
	workDescription: string,
	_tokens: string[],
): Promise<void> {
	const [inspection, originUrl, defaultBranchHint] = await Promise.all([
		inspectRepoValidationProfile(repoRoot),
		tryGitStdout(pi, repoRoot, ["remote", "get-url", "origin"]),
		detectPlannerDefaultBranchHint(pi, repoRoot),
	]);

	dispatchWorkflowMessage(
		pi,
		ctx,
		"planner",
		buildNativePlannerBrief({
			repoRoot,
			workDescription,
			originUrl,
			defaultBranchHint,
			inspection,
		}),
	);
}

function collectCommitShasFromState(taskCommits: Array<{ commit?: string | null }>): string[] {
	return taskCommits
		.map((task) => task.commit)
		.filter((commit): commit is string => typeof commit === "string" && commit.trim().length > 0);
}

async function blockCommandAsPlanDefect(
	commandName: PlannerCommandName,
	options: {
		milestoneDir: string;
		milestone: PlanMilestone;
		stage: string;
		reason: string;
		commitShas: string[];
	},
): Promise<void> {
	const nextCommand = `/replanner ${options.milestone.id}`;
	const blocker = await blockMilestone({
		milestoneDir: options.milestoneDir,
		milestoneId: options.milestone.id,
		milestoneSlug: options.milestone.slug,
		stage: options.stage,
		blockerType: "plan_defect",
		reason: options.reason,
		recommendedNextCommand: nextCommand,
	});

	const summary: MilestoneResultSummary = {
		milestoneId: options.milestone.id,
		milestoneSlug: options.milestone.slug,
		status: "blocked",
		stage: options.stage,
		blockerType: "plan_defect",
		blockerPath: blocker.blockerPath,
		nextCommand,
		commitShas: options.commitShas,
	};
	await writeMilestoneResult(options.milestoneDir, summary);

	throw new Error(
		[
			`/${commandName} blocked at stage '${options.stage}'.`,
			"Blocker type: plan_defect",
			`Blocker file: ${blocker.blockerPath}`,
			`Recommended next command: ${nextCommand}`,
			"",
			options.reason,
		].join("\n"),
	);
}

function collectTaskExecutionModePlanDefects(
	spec: Awaited<ReturnType<typeof loadMilestoneSpecData>>,
): string[] {
	return spec.tasks.flatMap((task) => {
		const defects: string[] = [];
		if (task.invalidExecutionMode) {
			defects.push(
				`Task ${task.id} declares unsupported execution_mode '${task.invalidExecutionMode}'. Allowed values: tdd, docs_only, pure_refactor, build_config, generated_update.`,
			);
		}
		const executionMode = normalizeTaskExecutionMode(task.executionMode);
		if (executionMode !== "tdd" && !task.executionModeReason?.trim()) {
			defects.push(`Task ${task.id} uses execution_mode '${executionMode}' but is missing execution_mode_reason.`);
		}
		return defects;
	});
}

async function runPlanDefectPreflight(
	commandName: PlannerCommandName,
	milestone: PlanMilestone,
	milestoneDir: string,
): Promise<void> {
	const specPath = path.join(milestoneDir, "spec.yaml");
	const statePath = path.join(milestoneDir, "state.yaml");
	const [spec, state] = await Promise.all([
		loadMilestoneSpecData(specPath),
		loadMilestoneStateData(statePath),
	]);
	const commitShas = collectCommitShasFromState(state.tasks);

	const modeDefects = collectTaskExecutionModePlanDefects(spec);
	if (modeDefects.length > 0) {
		const reason = [
			"spec.yaml.tasks contains invalid task execution-mode declarations.",
			...modeDefects,
		].join("\n");
		await blockCommandAsPlanDefect(commandName, {
			milestoneDir,
			milestone,
			stage: "task_contract",
			reason,
			commitShas,
		});
	}

	const alignment = compareTaskAlignment(spec, state);
	if (!alignment.isAligned) {
		const reason = [
			"spec.yaml.tasks and state.yaml.tasks are out of sync.",
			alignment.missingInState.length > 0
				? `Missing in state.yaml: ${alignment.missingInState.join(", ")}`
				: undefined,
			alignment.extraInState.length > 0
				? `Extra in state.yaml: ${alignment.extraInState.join(", ")}`
				: undefined,
		].filter(Boolean).join("\n");

		await blockCommandAsPlanDefect(commandName, {
			milestoneDir,
			milestone,
			stage: "task_alignment",
			reason,
			commitShas,
		});
	}

	const graph = resolveTaskGraph(spec.tasks);
	if (graph.missingDependencies.length > 0) {
		const reason = [
			"spec.yaml contains dependencies that do not exist as task ids.",
			...graph.missingDependencies.map(
				(entry) => `Task ${entry.taskId} depends on missing task ${entry.dependencyId}`,
			),
		].join("\n");
		await blockCommandAsPlanDefect(commandName, {
			milestoneDir,
			milestone,
			stage: "task_ordering",
			reason,
			commitShas,
		});
	}

	if (graph.hasCycle) {
		const reason = [
			"spec.yaml task dependencies contain a cycle; deterministic task order cannot be resolved.",
			`Cycle-involved tasks: ${graph.cycleTaskIds.join(", ")}`,
		].join("\n");
		await blockCommandAsPlanDefect(commandName, {
			milestoneDir,
			milestone,
			stage: "task_ordering",
			reason,
			commitShas,
		});
	}
}

async function runMilestonerNativePreflight(
	milestone: PlanMilestone,
	milestoneDir: string,
): Promise<void> {
	await runPlanDefectPreflight("milestoner", milestone, milestoneDir);
}

function findBlockerMetadata(stateRecord: Record<string, unknown>): {
	blockerType?: string;
	stage?: string;
	recommendedNextCommand?: string;
	reason?: string;
} {
	const blockedOn = asRecord(stateRecord.blocked_on);
	if (!blockedOn) {
		return {};
	}

	return {
		blockerType: asString(blockedOn.type),
		stage: asString(blockedOn.stage),
		recommendedNextCommand: asString(blockedOn.recommended_next_command),
		reason: asString(blockedOn.reason),
	};
}

async function resolveActiveBlockerPath(milestoneDir: string): Promise<string | undefined> {
	const blockerPath = path.join(milestoneDir, "blocker.md");
	try {
		const stat = await fs.stat(blockerPath);
		return stat.isFile() ? blockerPath : undefined;
	} catch {
		return undefined;
	}
}

function resolveNextTaskFromState(
	spec: Awaited<ReturnType<typeof loadMilestoneSpecData>>,
	state: Awaited<ReturnType<typeof loadMilestoneStateData>>,
): { taskId?: string; activeTaskIds: string[] } {
	const graph = resolveTaskGraph(spec.tasks);
	const statusByTaskId = new Map(state.tasks.map((task) => [task.id, task.status ?? "planned"]));
	const activeTaskIds = graph.orderedTaskIds.filter((taskId) => statusByTaskId.get(taskId) === "in_progress");
	if (activeTaskIds.length > 0) {
		return {
			taskId: activeTaskIds[0],
			activeTaskIds,
		};
	}

	for (const taskId of graph.orderedTaskIds) {
		const status = statusByTaskId.get(taskId) ?? "planned";
		if (status !== "done" && status !== "skipped") {
			return {
				taskId,
				activeTaskIds,
			};
		}
	}

	return { activeTaskIds };
}

async function runMilestonerNative(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	activePlan: ActivePlanContext,
	milestone: PlanMilestone,
	milestoneDir: string,
): Promise<void> {
	await ensureMilestoneFiles(milestoneDir);
	await runMilestonerNativePreflight(milestone, milestoneDir);

	const statePath = path.join(milestoneDir, "state.yaml");
	const specPath = path.join(milestoneDir, "spec.yaml");
	let stateRecord = await loadMilestoneStateRecord(statePath);
	let state = await loadMilestoneStateData(statePath);
	const currentStatus = asString(stateRecord.status) ?? state.status ?? "planned";
	const currentPhase = asString(stateRecord.phase) ?? state.phase ?? "not_started";

	if (currentStatus === "blocked") {
		const blocker = findBlockerMetadata(stateRecord);
		const blockerPath = await resolveActiveBlockerPath(milestoneDir);
		throw new Error(
			[
				`/milestoner cannot continue because milestone '${milestone.id}' is currently blocked.`,
				blocker.blockerType ? `Blocker type: ${blocker.blockerType}` : undefined,
				blockerPath ? `Blocker file: ${blockerPath}` : undefined,
				`Recommended next command: ${blocker.recommendedNextCommand ?? `/resume_milestone ${milestone.id}`}`,
				blocker.reason ? "" : undefined,
				blocker.reason,
			].filter(Boolean).join("\n"),
		);
	}

	if (currentStatus === "done" || currentPhase === "finished") {
		ctx.ui.notify(
			`Milestone ${milestone.id}${milestone.slug ? ` (${milestone.slug})` : ""} is already complete.`,
			"info",
		);
		return;
	}

	if (currentStatus === "planned" || currentPhase === "not_started") {
		await enforceMilestoneStartPreconditions(pi, activePlan.repoRoot, activePlan.defaultBranch);
		await runMilestoneStartNative(pi, ctx, activePlan, milestone, milestoneDir, milestone.id, {
			invokedByMilestoner: true,
		});
		stateRecord = await loadMilestoneStateRecord(statePath);
		state = await loadMilestoneStateData(statePath);
	}

	const spec = await loadMilestoneSpecData(specPath);
	const nextTask = resolveNextTaskFromState(spec, state);
	if (nextTask.activeTaskIds.length > 1) {
		await blockCommandAsPlanDefect("milestoner", {
			milestoneDir,
			milestone,
			stage: "task_execution",
			reason: `Multiple tasks are marked in_progress simultaneously: ${nextTask.activeTaskIds.join(", ")}`,
			commitShas: collectCommitShasFromState(state.tasks),
		});
	}

	if (nextTask.taskId) {
		await runTaskerNative(pi, ctx, activePlan, {
			taskId: nextTask.taskId,
			milestone,
			milestoneDir,
		}, {
			invokedByMilestoner: true,
		});
		return;
	}

	const phase = state.phase ?? asString(stateRecord.phase) ?? "task_execution";
	if (phase === "started" || phase === "task_execution") {
		await runMilestoneHardenNative(pi, ctx, activePlan, milestone, milestoneDir);
		return;
	}
	if (phase === "hardening") {
		await runMilestoneReviewNative(pi, ctx, activePlan, milestone, milestoneDir);
		return;
	}
	if (phase === "review") {
		await runMilestoneFinishNative(pi, ctx, activePlan, milestone, milestoneDir);
		return;
	}

	if (phase === "finished") {
		ctx.ui.notify(
			`Milestone ${milestone.id}${milestone.slug ? ` (${milestone.slug})` : ""} is already finished.`,
			"info",
		);
		return;
	}

	throw new Error(`/milestoner encountered plan_defect: unsupported milestone phase '${phase}'.`);
}

function timestampNow(): string {
	return new Date().toISOString();
}

function resolveMilestoneBranchName(milestone: PlanMilestone): string {
	return `feat/${milestone.slug ?? milestone.id}`;
}

async function ensureBranchDoesNotExist(
	pi: ExtensionAPI,
	repoRoot: string,
	branchName: string,
): Promise<void> {
	const result = await pi.exec("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
	if (result.code === 0) {
		throw new Error(`/milestone_start requires a new branch, but '${branchName}' already exists.`);
	}
}

async function createAndSwitchBranch(
	pi: ExtensionAPI,
	repoRoot: string,
	branchName: string,
): Promise<void> {
	const result = await pi.exec("git", ["-C", repoRoot, "switch", "-c", branchName]);
	if (result.code !== 0) {
		throw new Error(`Failed to create/switch branch '${branchName}': ${result.stderr?.trim() || result.stdout?.trim() || "unknown git error"}`);
	}
}

async function runMilestoneStartNative(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	activePlan: ActivePlanContext,
	milestone: PlanMilestone,
	milestoneDir: string,
	milestoneSelector: string,
	options?: { invokedByMilestoner?: boolean },
): Promise<void> {
	const branchName = resolveMilestoneBranchName(milestone);
	const statePath = path.join(milestoneDir, "state.yaml");
	const executionPath = path.join(milestoneDir, "execution.md");
	const timestamp = timestampNow();

	await ensureMilestoneFiles(milestoneDir);
	await runPlanDefectPreflight("milestone_start", milestone, milestoneDir);
	const stateRecord = await loadMilestoneStateRecord(statePath);
	assertMilestoneCanStart("/milestone_start", stateRecord);
	await ensureBranchDoesNotExist(pi, activePlan.repoRoot, branchName);
	await createAndSwitchBranch(pi, activePlan.repoRoot, branchName);
	await setMilestoneStartState(statePath, {
		branchName,
		timestamp,
	});

	const state = await loadMilestoneStateData(statePath);
	const snapshotLines = state.tasks.map(
		(task) => `  - \`${task.id}\`: \`${task.status ?? "planned"}\``,
	);

	await appendExecutionSection(executionPath, {
		timestamp,
		title: "milestone start",
		body: [
			`- Command: \`/milestone_start ${milestoneSelector}\``,
			`- Resolved milestone: \`${milestone.id}\`${milestone.slug ? ` / \`${milestone.slug}\`` : ""}`,
			`- Path: \`${milestoneDir}\``,
			`- Created branch: \`${branchName}\``,
			"- Initial task snapshot:",
			...snapshotLines,
		].join("\n"),
	});

	ctx.ui.notify(
		[
			`Started milestone ${milestone.id}${milestone.slug ? ` (${milestone.slug})` : ""}.`,
			`Branch: ${branchName}`,
			`State: ${statePath}`,
			options?.invokedByMilestoner
				? `Next: continuing under /milestoner ${milestone.id}`
				: `Next: /tasker <task-id> or /milestoner ${milestone.id}`,
		].join("\n"),
		"info",
	);
}

async function getCurrentBranch(pi: ExtensionAPI, repoRoot: string, commandName: PlannerCommandName): Promise<string> {
	const branch = await pi.exec("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch.code !== 0) {
		throw new Error(`Failed to determine current git branch for /${commandName}.`);
	}
	const currentBranch = branch.stdout.trim();
	if (!currentBranch) {
		throw new Error(`Current branch is empty/unresolved for /${commandName}.`);
	}
	return currentBranch;
}

async function ensureCurrentBranch(
	pi: ExtensionAPI,
	repoRoot: string,
	expectedBranch: string,
	commandName: PlannerCommandName,
): Promise<void> {
	const currentBranch = await getCurrentBranch(pi, repoRoot, commandName);
	if (currentBranch !== expectedBranch) {
		throw new Error(`/${commandName} requires current branch '${expectedBranch}', but found '${currentBranch}'.`);
	}
}

async function ensureTaskToolBranchContext(
	pi: ExtensionAPI,
	taskContext: Awaited<ReturnType<typeof resolveTaskToolContext>>,
	commandName: PlannerCommandName = "tasker",
): Promise<Record<string, unknown>> {
	const statePath = path.join(taskContext.milestoneDir, "state.yaml");
	const stateRecord = await loadMilestoneStateRecord(statePath);
	const expectedBranch = asString(stateRecord.branch);
	if (expectedBranch) {
		await ensureCurrentBranch(pi, taskContext.activePlan.repoRoot, expectedBranch, commandName);
	}
	return stateRecord;
}

async function verifyCommitShaOnCurrentBranch(
	pi: ExtensionAPI,
	repoRoot: string,
	commitSha: string,
	commandName: PlannerCommandName = "tasker",
): Promise<string> {
	const cleanCommitSha = commitSha.trim();
	if (!/^[0-9a-f]{7,40}$/i.test(cleanCommitSha)) {
		throw new Error(`/${commandName} requires a valid git commit SHA, but received '${commitSha}'.`);
	}

	const resolved = await pi.exec("git", ["-C", repoRoot, "rev-parse", "--verify", `${cleanCommitSha}^{commit}`]);
	if (resolved.code !== 0) {
		throw new Error(`/${commandName} cannot record commit '${cleanCommitSha}' because it does not exist in this repository.`);
	}

	const ancestry = await pi.exec("git", ["-C", repoRoot, "merge-base", "--is-ancestor", cleanCommitSha, "HEAD"]);
	if (ancestry.code !== 0) {
		throw new Error(`/${commandName} cannot record commit '${cleanCommitSha}' because it is not reachable from the current milestone branch.`);
	}

	return cleanCommitSha;
}

function findTaskSpecById(spec: Awaited<ReturnType<typeof loadMilestoneSpecData>>, taskId: string) {
	return spec.tasks.find((task) => task.id === taskId);
}

function formatResolvedMilestone(milestone: PlanMilestone): string {
	return milestone.slug ? `\`${milestone.id}\` / \`${milestone.slug}\`` : `\`${milestone.id}\``;
}

function defaultRecommendedNextCommandForBlockerType(
	milestoneId: string,
	blockerType?: string,
): string {
	return blockerType === "plan_defect" || blockerType === "scope_explosion"
		? `/replanner ${milestoneId}`
		: `/resume_milestone ${milestoneId}`;
}

function normalizeTaskExecutionMode(value: string | undefined): TaskExecutionMode {
	switch (value?.trim()) {
		case "docs_only":
			return "docs_only";
		case "pure_refactor":
			return "pure_refactor";
		case "build_config":
			return "build_config";
		case "generated_update":
			return "generated_update";
		default:
			return "tdd";
	}
}

function formatTaskExecutionMode(mode: TaskExecutionMode): string {
	switch (mode) {
		case "docs_only":
			return "docs_only";
		case "pure_refactor":
			return "pure_refactor";
		case "build_config":
			return "build_config";
		case "generated_update":
			return "generated_update";
		default:
			return "tdd";
	}
}

function taskCompletionCheckpointRequirement(mode: TaskExecutionMode): string {
	return mode === "tdd" ? "tests_green_verified" : "implementation_started";
}

function taskExecutionModeGuidance(mode: TaskExecutionMode): string {
	switch (mode) {
		case "docs_only":
			return "Docs-only flow: do not invent red/green test evidence; record the docs rationale and complete after the work itself is implemented/reviewed.";
		case "pure_refactor":
			return "Pure-refactor flow: preserve behavior, record the explicit refactor rationale, and only claim test evidence you actually ran.";
		case "build_config":
			return "Build/config flow: record the wiring rationale and the exact validation used instead of forcing a fake red/green story.";
		case "generated_update":
			return "Generated-update flow: record the generation source/process and any validating checks instead of forcing a fake red/green story.";
		default:
			return "Default TDD flow: follow red → green → broader validation unless the task's explicit execution mode says otherwise.";
	}
}

function formatTaskExecutionModeLines(options: {
	executionMode?: string;
	executionModeReason?: string;
}): string[] {
	const mode = normalizeTaskExecutionMode(options.executionMode);
	return [
		`- Execution mode: \`${formatTaskExecutionMode(mode)}\``,
		options.executionModeReason ? `- Execution mode rationale: ${options.executionModeReason}` : undefined,
		`- Completion gate: checkpoint must reach \`${taskCompletionCheckpointRequirement(mode)}\` before final task completion.`,
		`- Mode guidance: ${taskExecutionModeGuidance(mode)}`,
	].filter(Boolean) as string[];
}

function dependencyStatusLines(
	dependencyIds: string[],
	state: Awaited<ReturnType<typeof loadMilestoneStateData>>,
): string[] {
	if (dependencyIds.length === 0) {
		return ["- Dependencies: none"];
	}

	const statusByTaskId = new Map(state.tasks.map((task) => [task.id, task.status ?? "planned"]));
	return [
		"- Dependencies:",
		...dependencyIds.map((dependencyId) => `  - \`${dependencyId}\`: \`${statusByTaskId.get(dependencyId) ?? "planned"}\``),
	];
}

function assertTaskDependenciesSatisfied(
	taskId: string,
	dependencyIds: string[],
	state: Awaited<ReturnType<typeof loadMilestoneStateData>>,
): void {
	if (dependencyIds.length === 0) return;

	const incomplete = dependencyIds
		.map((dependencyId) => {
			const task = state.tasks.find((entry) => entry.id === dependencyId);
			const status = task?.status ?? "planned";
			return status === "done" || status === "skipped" ? undefined : { dependencyId, status };
		})
		.filter(
			(entry): entry is { dependencyId: string; status: string } => Boolean(entry),
		);

	if (incomplete.length === 0) return;

	throw new Error(
		[
			`/tasker cannot start '${taskId}' until its dependencies are complete.`,
			...incomplete.map(
				(entry) => `Dependency ${entry.dependencyId} is still '${entry.status}'.`,
			),
		].join("\n"),
	);
}

function buildTaskOutcomeExecutionSectionBody(options: {
	milestone: PlanMilestone;
	taskId: string;
	taskTitle?: string;
	executionMode?: string;
	executionModeReason?: string;
	outcome: (typeof TASK_OUTCOMES)[number];
	summary: string;
	commitSha?: string;
	blockerType?: string;
	recommendedNextCommand?: string;
}): string {
	return [
		`- Milestone: ${formatResolvedMilestone(options.milestone)}`,
		`- Task: \`${options.taskId}\`${options.taskTitle ? ` — ${options.taskTitle}` : ""}`,
		`- Execution mode: \`${formatTaskExecutionMode(normalizeTaskExecutionMode(options.executionMode))}\``,
		options.executionModeReason ? `- Execution mode rationale: ${options.executionModeReason}` : undefined,
		`- Outcome: \`${options.outcome}\``,
		options.commitSha ? `- Commit: \`${options.commitSha}\`` : undefined,
		options.blockerType ? `- Blocker type: \`${options.blockerType}\`` : undefined,
		options.recommendedNextCommand
			? `- Recommended next command: \`${options.recommendedNextCommand}\``
			: undefined,
		"",
		"Summary:",
		options.summary.trim(),
	].filter(Boolean).join("\n");
}

function buildNativeTaskerBrief(options: {
	milestone: PlanMilestone;
	milestoneDir: string;
	taskId: string;
	taskTitle?: string;
	executionMode?: string;
	executionModeReason?: string;
	branchName: string;
	checkpointStep: (typeof CHECKPOINT_STEPS)[number];
	dependencyLines: string[];
	invokedByMilestoner?: boolean;
}): string {
	const contractPath = path.join(PACKAGE_ROOT, "docs", "planner-workflow.md");
	const milestoneGuidePath = path.join(options.milestoneDir, "milestone.md");
	const specPath = path.join(options.milestoneDir, "spec.yaml");
	const statePath = path.join(options.milestoneDir, "state.yaml");
	const executionPath = path.join(options.milestoneDir, "execution.md");

	return [
		options.invokedByMilestoner
			? `Continue the native /milestoner workflow for milestone ${formatResolvedMilestone(options.milestone)}. Current task: \`${options.taskId}\`.`
			: `Continue the native /tasker workflow for task \`${options.taskId}\`.`,
		"",
		"Read before acting:",
		`- Workflow contract: \`${contractPath}\``,
		`- Milestone guide: \`${milestoneGuidePath}\``,
		`- Spec: \`${specPath}\``,
		`- State: \`${statePath}\``,
		`- Execution log: \`${executionPath}\``,
		"",
		"Resolved context:",
		`- Milestone: ${formatResolvedMilestone(options.milestone)}`,
		`- Task: \`${options.taskId}\`${options.taskTitle ? ` — ${options.taskTitle}` : ""}`,
		`- Branch: \`${options.branchName}\``,
		...formatTaskExecutionModeLines({
			executionMode: options.executionMode,
			executionModeReason: options.executionModeReason,
		}),
		...options.dependencyLines,
		"",
		"Native state already set:",
		"- milestone status: `in_progress`",
		"- milestone phase: `task_execution`",
		`- task \`${options.taskId}\` status: \`in_progress\``,
		`- checkpoint: \`{ task_id: ${options.taskId}, step: ${options.checkpointStep} }\``,
		...formatTaskExecutionModeLines({
			executionMode: options.executionMode,
			executionModeReason: options.executionModeReason,
		}),
		"",
		options.invokedByMilestoner
			? "Execute the current task now as the next step of /milestoner-owned milestone execution."
			: "Execute exactly this one task now.",
		"Follow the contract for TDD, checkpoint progression, execution evidence, blocker handling, and the mandatory per-task commit.",
		options.invokedByMilestoner
			? "Do not redirect the user to run /tasker manually for routine progression; /milestoner owns the normal task-to-task flow unless the milestone blocks."
			: undefined,
		"Use native planner tools instead of manual workflow-file edits:",
		"- `planner_task_checkpoint` whenever the checkpoint advances",
		"- `planner_append_execution_section` for intermediate execution evidence sections",
		"- `planner_finalize_task_outcome` to atomically append final task evidence and mark the task `done` or `blocked`",
		"- `planner_complete_task` / `planner_block_milestone` only for exceptional recovery or manual repair flows",
		"If the task blocks, recommend `/resume_milestone <milestone>` unless evidence shows a plan defect that needs `/replanner`.",
		"",
		"Required final response:",
		"- milestone + task resolved",
		"- task outcome (`done` or `blocked`)",
		"- checkpoint state",
		"- commit SHA (or explicit allow-empty reason)",
		"- blocker file path + next command when blocked",
	].join("\n");
}

async function runTaskerNative(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	activePlan: ActivePlanContext,
	resolvedTask: TaskResolution,
	options?: { invokedByMilestoner?: boolean },
): Promise<void> {
	const milestone = resolvedTask.milestone;
	const milestoneDir = resolvedTask.milestoneDir;
	const taskId = resolvedTask.taskId;
	const statePath = path.join(milestoneDir, "state.yaml");
	const executionPath = path.join(milestoneDir, "execution.md");

	await ensureMilestoneFiles(milestoneDir);
	await runPlanDefectPreflight("tasker", milestone, milestoneDir);

	const specPath = path.join(milestoneDir, "spec.yaml");
	const [spec, state, stateRecord] = await Promise.all([
		loadMilestoneSpecData(specPath),
		loadMilestoneStateData(statePath),
		loadMilestoneStateRecord(statePath),
	]);
	const taskSpec = findTaskSpecById(spec, taskId);
	if (!taskSpec) {
		throw new Error(`Task '${taskId}' missing from ${specPath}.`);
	}
	const executionMode = normalizeTaskExecutionMode(taskSpec.executionMode);
	const executionModeReason = taskSpec.executionModeReason?.trim();

	assertTaskDependenciesSatisfied(taskId, taskSpec.dependsOn, state);

	const expectedBranch = asString(stateRecord.branch);
	if (expectedBranch) {
		await ensureCurrentBranch(pi, activePlan.repoRoot, expectedBranch, "tasker");
	}

	const timestamp = timestampNow();
	const startResult = await setTaskExecutionStart(statePath, {
		milestoneId: milestone.id,
		taskId,
		executionMode,
		executionModeReason,
		timestamp,
	});

	if (startResult.firstActivation) {
		await appendExecutionSection(executionPath, {
			timestamp,
			title: `task \`${taskId}\` started`,
			body: [
				`- Command: \`/tasker ${taskId}\``,
				`- Milestone: ${formatResolvedMilestone(milestone)}`,
				`- Task title: \`${taskSpec.title ?? "(untitled task)"}\``,
				`- Path: \`${milestoneDir}\``,
				...formatTaskExecutionModeLines({
					executionMode,
					executionModeReason,
				}),
				...dependencyStatusLines(taskSpec.dependsOn, state),
				"- Native checkpoint set:",
				`  - task_id: \`${taskId}\``,
				"  - step: `not_started`",
			].join("\n"),
		});
	}

	const checkpointStep = normalizeCheckpointStep(asString(asRecord(startResult.state.checkpoint)?.step));
	dispatchWorkflowMessage(
		pi,
		ctx,
		"tasker",
		buildNativeTaskerBrief({
			milestone,
			milestoneDir,
			taskId,
			taskTitle: taskSpec.title,
			executionMode,
			executionModeReason,
			branchName: expectedBranch ?? asString(startResult.state.branch) ?? resolveMilestoneBranchName(milestone),
			checkpointStep,
			dependencyLines: dependencyStatusLines(taskSpec.dependsOn, state),
			invokedByMilestoner: options?.invokedByMilestoner,
		}),
	);
}

function formatValidationProfileLines(spec: Awaited<ReturnType<typeof loadMilestoneSpecData>>): string[] {
	const commands = spec.validation?.commands ?? [];
	if (commands.length === 0) {
		return [
			"- Validation profile: no explicit `spec.yaml.validation.commands` entries recorded yet.",
			"- Run broader repo-appropriate validation per the workflow contract and record the exact commands/results.",
		];
	}

	return [
		"- Validation profile:",
		...commands.map((entry) => {
			const meta = [entry.kind, entry.origin].filter(Boolean).join(" / ");
			return `  - \`${entry.command}\`${meta ? ` (${meta})` : ""}`;
		}),
	];
}

function validationResultExcerpt(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) {
		return undefined;
	}
	const collapsed = trimmed.replace(/\s+/g, " ");
	return collapsed.length > 180 ? `${collapsed.slice(0, 177)}...` : collapsed;
}

function buildValidationExecutionSectionBody(options: {
	milestone: PlanMilestone;
	stage: (typeof VALIDATION_STAGES)[number];
	results: Awaited<ReturnType<typeof runValidationProfile>>["results"];
	blockingExploratoryKinds?: readonly string[];
	blockingExploratoryCommands?: readonly string[];
	note?: string;
}): string {
	const resultLines =
		options.results.length === 0
			? ["- No validation commands were configured in spec.yaml.validation.commands."]
			: options.results.flatMap((result) => {
				const meta = [result.kind, result.origin].filter(Boolean).join(" / ");
				return [
					`- ${result.status === "passed" ? "PASS" : result.blocking ? "FAIL (blocking)" : "FAIL (advisory)"}: \`${result.command}\`${meta ? ` (${meta})` : ""}`,
					`  - exit code: ${result.exitCode}`,
					validationResultExcerpt(result.stdout) ? `  - stdout: ${validationResultExcerpt(result.stdout)}` : undefined,
					validationResultExcerpt(result.stderr) ? `  - stderr: ${validationResultExcerpt(result.stderr)}` : undefined,
				].filter(Boolean);
			});

	return [
		`- Milestone: ${formatResolvedMilestone(options.milestone)}`,
		`- Validation stage: \`${options.stage}\``,
		options.blockingExploratoryKinds?.length
			? `- Escalated exploratory kinds: ${options.blockingExploratoryKinds.map((entry) => `\`${entry}\``).join(", ")}`
			: undefined,
		options.blockingExploratoryCommands?.length
			? `- Escalated exploratory commands: ${options.blockingExploratoryCommands.map((entry) => `\`${entry}\``).join(", ")}`
			: undefined,
		options.note?.trim() ? `- Note: ${options.note.trim()}` : undefined,
		...resultLines,
	].filter(Boolean).join("\n");
}

function chooseValidationBlockerType(
	failure: Awaited<ReturnType<typeof runValidationProfile>>["blockingFailures"][number],
): (typeof BLOCKER_TYPES)[number] {
	const stderr = `${failure.stderr}\n${failure.stdout}`.toLowerCase();
	if (failure.exitCode === 127 || stderr.includes("command not found") || stderr.includes("not found")) {
		return "environment";
	}
	if (failure.kind === "test") {
		return "test_failure";
	}
	return "unknown";
}

function buildValidationBlockerReason(
	stage: (typeof VALIDATION_STAGES)[number],
	validation: Awaited<ReturnType<typeof runValidationProfile>>,
	note?: string,
): string {
	return [
		`Validation failed during ${stage}.`,
		...validation.blockingFailures.map((failure) => {
			const meta = [failure.kind, failure.origin].filter(Boolean).join(" / ");
			return [
				`Command: ${failure.command}${meta ? ` (${meta})` : ""}`,
				`Exit code: ${failure.exitCode}`,
				validationResultExcerpt(failure.stderr) ? `stderr: ${validationResultExcerpt(failure.stderr)}` : undefined,
				validationResultExcerpt(failure.stdout) ? `stdout: ${validationResultExcerpt(failure.stdout)}` : undefined,
			].filter(Boolean).join("\n");
		}),
		validation.advisoryFailures.length > 0
			? `Advisory exploratory failures also observed: ${validation.advisoryFailures.map((failure) => `\`${failure.command}\``).join(", ")}`
			: undefined,
		note?.trim() ? `Execution note: ${note.trim()}` : undefined,
	].filter(Boolean).join("\n\n");
}

function buildNativeHardenBrief(options: {
	milestone: PlanMilestone;
	milestoneDir: string;
	validationLines: string[];
}): string {
	const contractPath = path.join(PACKAGE_ROOT, "docs", "planner-workflow.md");
	const specPath = path.join(options.milestoneDir, "spec.yaml");
	const statePath = path.join(options.milestoneDir, "state.yaml");
	const executionPath = path.join(options.milestoneDir, "execution.md");

	return [
		`Continue the native /milestone_harden workflow for milestone ${formatResolvedMilestone(options.milestone)}.`,
		"",
		"Read before acting:",
		`- Workflow contract: \`${contractPath}\``,
		`- Spec: \`${specPath}\``,
		`- State: \`${statePath}\``,
		`- Execution log: \`${executionPath}\``,
		"",
		"Native state already set:",
		"- milestone status: `in_progress`",
		"- milestone phase: `hardening`",
		...options.validationLines,
		"",
		"Run hardening now.",
		"Use native planner tools instead of manual workflow-file edits:",
		"- `planner_run_validation_profile` to execute `spec.yaml.validation.commands` with canonical vs exploratory blocking policy",
		"- `planner_append_execution_section` for extra hardening evidence beyond the validation tool output",
		"- `planner_block_milestone` only for non-validation blockers; validation blockers should normally come from `planner_run_validation_profile`",
		"Canonical validation failures block by default. Exploratory validation failures are advisory by default unless you explicitly escalate them because the milestone acceptance criteria or touched code makes them blocking.",
		"If hardening creates code/docs changes, make the required milestone hardening commit and record it in execution evidence.",
	].join("\n");
}

function buildNativeReviewBrief(options: {
	milestone: PlanMilestone;
	milestoneDir: string;
	reviewPrompt: string;
	reviewPath: string;
	branchName: string;
	baseBranch: string;
}): string {
	const contractPath = path.join(PACKAGE_ROOT, "docs", "planner-workflow.md");
	const statePath = path.join(options.milestoneDir, "state.yaml");
	const executionPath = path.join(options.milestoneDir, "execution.md");

	return [
		`Continue the native /milestone_review workflow for milestone ${formatResolvedMilestone(options.milestone)}.`,
		"",
		"Read before acting:",
		`- Workflow contract: \`${contractPath}\``,
		`- State: \`${statePath}\``,
		`- Execution log: \`${executionPath}\``,
		`- Review output: \`${options.reviewPath}\``,
		"",
		"Native state already set:",
		"- milestone status: `in_progress`",
		"- milestone phase: `review`",
		`- review scope: branch diff \`${options.baseBranch}...${options.branchName}\``,
		"",
		"Use native planner tools instead of manual workflow-file edits:",
		"- `planner_run_validation_profile` to rerun milestone validation with canonical vs exploratory policy after review fixes",
		"- `planner_append_execution_section` for extra review evidence/rerun summaries beyond the validation tool output",
		"- `planner_block_milestone` only for non-validation blockers; validation blockers should normally come from `planner_run_validation_profile`",
		"Canonical validation failures block by default. Exploratory validation failures are advisory by default unless you explicitly escalate them because the milestone acceptance criteria or touched code makes them blocking.",
		"",
		options.reviewPrompt.trim(),
	].join("\n");
}

async function runMilestoneHardenNative(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	activePlan: ActivePlanContext,
	milestone: PlanMilestone,
	milestoneDir: string,
	options?: { resumeFromValidationBlocker?: boolean },
): Promise<void> {
	await ensureMilestoneFiles(milestoneDir);
	await runPlanDefectPreflight("milestone_harden", milestone, milestoneDir);

	const statePath = path.join(milestoneDir, "state.yaml");
	const executionPath = path.join(milestoneDir, "execution.md");
	const specPath = path.join(milestoneDir, "spec.yaml");
	const [stateRecord, spec] = await Promise.all([
		loadMilestoneStateRecord(statePath),
		loadMilestoneSpecData(specPath),
	]);
	const expectedBranch = asString(stateRecord.branch);
	if (expectedBranch) {
		await ensureCurrentBranch(pi, activePlan.repoRoot, expectedBranch, "milestone_harden");
	}

	const timestamp = timestampNow();
	if (options?.resumeFromValidationBlocker) {
		const currentStatus = asString(stateRecord.status) ?? "planned";
		const currentPhase = asString(stateRecord.phase) ?? "not_started";
		if (currentStatus !== "in_progress" || currentPhase !== "hardening") {
			throw new Error(
				`/milestone_harden cannot resume validation unless milestone '${milestone.id}' is in_progress and already in phase 'hardening'.`,
			);
		}
	} else {
		await setMilestoneHardeningStart(statePath, {
			milestoneId: milestone.id,
			timestamp,
		});
	}

	const validationLines = formatValidationProfileLines(spec);
	await appendExecutionSection(executionPath, {
		timestamp,
		title: options?.resumeFromValidationBlocker ? "milestone hardening resumed" : "milestone hardening started",
		body: [
			`- Command: \`/milestone_harden ${milestone.id}\``,
			`- Milestone: ${formatResolvedMilestone(milestone)}`,
			...(options?.resumeFromValidationBlocker ? ["- Resume reason: rerun the hardening phase after a blocked validation run."] : []),
			...validationLines,
		].join("\n"),
	});

	dispatchWorkflowMessage(
		pi,
		ctx,
		"milestone_harden",
		buildNativeHardenBrief({
			milestone,
			milestoneDir,
			validationLines,
		}),
	);
}

async function runMilestoneReviewNative(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	activePlan: ActivePlanContext,
	milestone: PlanMilestone,
	milestoneDir: string,
	options?: { resumeFromValidationBlocker?: boolean },
): Promise<void> {
	await ensureMilestoneFiles(milestoneDir);
	await runPlanDefectPreflight("milestone_review", milestone, milestoneDir);

	const statePath = path.join(milestoneDir, "state.yaml");
	const executionPath = path.join(milestoneDir, "execution.md");
	const stateRecord = await loadMilestoneStateRecord(statePath);
	const expectedBranch = asString(stateRecord.branch);
	if (expectedBranch) {
		await ensureCurrentBranch(pi, activePlan.repoRoot, expectedBranch, "milestone_review");
	}
	if (options?.resumeFromValidationBlocker) {
		const currentStatus = asString(stateRecord.status) ?? "planned";
		const currentPhase = asString(stateRecord.phase) ?? "not_started";
		if (currentStatus !== "in_progress" || currentPhase !== "review") {
			throw new Error(
				`/milestone_review cannot resume validation unless milestone '${milestone.id}' is in_progress and already in phase 'review'.`,
			);
		}
	}

	const reviewPath = path.join(milestoneDir, "review.md");
	const prepared = await prepareReviewRequest(pi, {
		scope: {
			kind: "branch",
			base: activePlan.defaultBranch,
			head: expectedBranch,
		},
		outputPath: reviewPath,
		reviewIds: undefined,
		});

	const timestamp = timestampNow();
	if (!options?.resumeFromValidationBlocker) {
		await setMilestoneReviewStart(statePath, {
			milestoneId: milestone.id,
			timestamp,
		});
	}

	await appendExecutionSection(executionPath, {
		timestamp,
		title: options?.resumeFromValidationBlocker ? "milestone review resumed" : "milestone review started",
		body: [
			`- Command: \`/milestone_review ${milestone.id}\``,
			`- Milestone: ${formatResolvedMilestone(milestone)}`,
			...(options?.resumeFromValidationBlocker ? ["- Resume reason: rerun the review phase after a blocked validation run."] : []),
			`- Review branch scope: \`${activePlan.defaultBranch}...${prepared.branch}\``,
			`- Review output path: \`${reviewPath}\``,
			`- Review types: ${prepared.activeReviews.map((review) => `\`${review.id}\``).join(", ")}`,
		].join("\n"),
	});

	dispatchWorkflowMessage(
		pi,
		ctx,
		"milestone_review",
		buildNativeReviewBrief({
			milestone,
			milestoneDir,
			reviewPrompt: prepared.prompt,
			reviewPath,
			branchName: prepared.branch,
			baseBranch: activePlan.defaultBranch,
		}),
	);
}

function extractCommitShasFromText(text: string): string[] {
	const matches = text.match(/\b[0-9a-f]{7,40}\b/gi) ?? [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const match of matches) {
		const normalized = match.toLowerCase();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(match);
	}
	return out;
}

function mergeCommitShas(...groups: string[][]): string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const group of groups) {
		for (const sha of group) {
			const normalized = sha.trim().toLowerCase();
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			merged.push(sha.trim());
		}
	}
	return merged;
}

async function readRequiredReviewFile(reviewPath: string, milestoneId: string): Promise<string> {
	let reviewRaw: string;
	try {
		reviewRaw = await fs.readFile(reviewPath, "utf8");
	} catch {
		throw new Error(`/milestone_finish requires review evidence at ${reviewPath}. Complete /milestone_review ${milestoneId} first.`);
	}
	if (!reviewRaw.trim()) {
		throw new Error(`/milestone_finish requires non-empty review evidence at ${reviewPath}.`);
	}
	return reviewRaw;
}

function hasUnresolvedHighMediumFindings(reviewRaw: string): boolean {
	const unresolvedSection = /(^|\n)#{1,6}\s*High\s*\/\s*medium\s+(?!fixed\b)([^\n]*)/i;
	if (unresolvedSection.test(reviewRaw)) {
		return true;
	}

	const deferredHighMedium = /\*\*(High|Medium)\*\*[\s\S]{0,120}(deferred|unresolved|open)/i;
	return deferredHighMedium.test(reviewRaw);
}

function formatCompletionCommitLines(commitShas: string[]): string[] {
	if (commitShas.length === 0) {
		return ["- Commits recorded: none"];
	}
	return ["- Commits recorded:", ...commitShas.map((sha) => `  - \`${sha}\``)];
}

async function runMilestoneFinishNative(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	activePlan: ActivePlanContext,
	milestone: PlanMilestone,
	milestoneDir: string,
): Promise<void> {
	await ensureMilestoneFiles(milestoneDir);
	await runPlanDefectPreflight("milestone_finish", milestone, milestoneDir);

	const statePath = path.join(milestoneDir, "state.yaml");
	const executionPath = path.join(milestoneDir, "execution.md");
	const reviewPath = path.join(milestoneDir, "review.md");
	const activeBlockerPath = await resolveActiveBlockerPath(milestoneDir);
	if (activeBlockerPath) {
		throw new Error(
			`/milestone_finish cannot complete milestone '${milestone.id}' while blocker.md is present: ${activeBlockerPath}`,
		);
	}

	const stateRecord = await loadMilestoneStateRecord(statePath);
	const expectedBranch = asString(stateRecord.branch);
	if (expectedBranch) {
		await ensureCurrentBranch(pi, activePlan.repoRoot, expectedBranch, "milestone_finish");
	}

	const reviewRaw = await readRequiredReviewFile(reviewPath, milestone.id);
	if (hasUnresolvedHighMediumFindings(reviewRaw)) {
		throw new Error(
			`/milestone_finish cannot complete milestone '${milestone.id}' because review.md still appears to contain unresolved high/medium findings.`,
		);
	}

	const executionRaw = await fs.readFile(executionPath, "utf8");
	const state = await loadMilestoneStateData(statePath);
	const timestamp = timestampNow();
	const finishedState = await setMilestoneFinished(statePath, {
		milestoneId: milestone.id,
		timestamp,
	});
	const commitShas = mergeCommitShas(
		collectCommitShasFromState(state.tasks),
		extractCommitShasFromText(executionRaw),
		extractCommitShasFromText(reviewRaw),
	);

	await appendExecutionSection(executionPath, {
		timestamp,
		title: "milestone finish",
		body: [
			`- Command: \`/milestone_finish ${milestone.id}\``,
			`- Final status: \`${asString(finishedState.status) ?? "done"}\``,
			`- Final phase: \`${asString(finishedState.phase) ?? "finished"}\``,
			`- Completed at: \`${timestamp}\``,
			`- Review evidence: \`${reviewPath}\``,
			...formatCompletionCommitLines(commitShas),
		].join("\n"),
	});

	const resultPath = await writeMilestoneResult(milestoneDir, {
		milestoneId: milestone.id,
		milestoneSlug: milestone.slug,
		status: "completed",
		stage: "finished",
		commitShas,
	});

	ctx.ui.notify(
		[
			`Finished milestone ${milestone.id}${milestone.slug ? ` (${milestone.slug})` : ""}.`,
			`Status: done`,
			`Phase: finished`,
			`Review: ${reviewPath}`,
			`Result: ${resultPath}`,
		].join("\n"),
		"info",
	);
}

function normalizeCheckpointStep(value: string | undefined): (typeof CHECKPOINT_STEPS)[number] {
	return CHECKPOINT_STEPS.includes(value as (typeof CHECKPOINT_STEPS)[number])
		? (value as (typeof CHECKPOINT_STEPS)[number])
		: "not_started";
}

function resumeActionHint(step: (typeof CHECKPOINT_STEPS)[number]): string {
	switch (step) {
		case "not_started":
			return "Start the task normally from the beginning.";
		case "tests_written":
			return "Rerun the narrow tests, confirm expected red state, then continue.";
		case "tests_red_verified":
			return "Implement the task next, then continue through green and broader validation.";
		case "implementation_started":
			return "Inspect the partial implementation carefully and continue conservatively.";
		case "tests_green_verified":
			return "Run broader validation, close the task, and record the mandatory task commit.";
		case "done":
			return "Move to the next task or milestone phase.";
	}
}

function buildNativeResumeBrief(options: {
	milestone: PlanMilestone;
	milestoneDir: string;
	taskId?: string;
	checkpointStep: (typeof CHECKPOINT_STEPS)[number];
	executionMode?: string;
	executionModeReason?: string;
	blockerType?: string;
	blockerReason?: string;
	archivedBlockerPath?: string;
}): string {
	const contractPath = path.join(PACKAGE_ROOT, "docs", "planner-workflow.md");
	const milestoneGuidePath = path.join(options.milestoneDir, "milestone.md");
	const specPath = path.join(options.milestoneDir, "spec.yaml");
	const statePath = path.join(options.milestoneDir, "state.yaml");
	const executionPath = path.join(options.milestoneDir, "execution.md");

	return [
		`Continue the native /resume_milestone workflow for milestone ${formatResolvedMilestone(options.milestone)}.`,
		"",
		"Read before acting:",
		`- Workflow contract: \`${contractPath}\``,
		`- Milestone guide: \`${milestoneGuidePath}\``,
		`- Spec: \`${specPath}\``,
		`- State: \`${statePath}\``,
		`- Execution log: \`${executionPath}\``,
		"",
		"Resume context:",
		options.blockerType ? `- Prior blocker type: \`${options.blockerType}\`` : undefined,
		options.blockerReason ? `- Prior blocker reason: ${options.blockerReason}` : undefined,
		options.archivedBlockerPath ? `- Archived blocker: \`${options.archivedBlockerPath}\`` : undefined,
		`- Checkpoint: \`{ task_id: ${options.taskId ?? "null"}, step: ${options.checkpointStep} }\``,
		...formatTaskExecutionModeLines({
			executionMode: options.executionMode,
			executionModeReason: options.executionModeReason,
		}),
		`- Resume guidance: ${resumeActionHint(options.checkpointStep)}`,
		"",
		"Native state already set:",
		"- milestone status: `in_progress`",
		"- blocked_on: `null`",
		options.taskId ? `- task \`${options.taskId}\` is ready to continue` : undefined,
		"",
		"Use native planner tools instead of manual workflow-file edits:",
		"- `planner_task_checkpoint` whenever the checkpoint advances",
		"- `planner_append_execution_section` for resume/intermediate evidence updates",
		"- `planner_finalize_task_outcome` to atomically append final task evidence and mark the task `done` or `blocked`",
		"- `planner_complete_task` / `planner_block_milestone` only for exceptional recovery or manual repair flows",
	].filter(Boolean).join("\n");
}

async function listArchivedBlockerPaths(milestoneDir: string): Promise<string[]> {
	const blockersDir = path.join(milestoneDir, "blockers");
	try {
		const entries = await fs.readdir(blockersDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile())
			.map((entry) => path.join(blockersDir, entry.name))
			.sort((left, right) => left.localeCompare(right));
	} catch {
		return [];
	}
}

function buildNativeReplannerBrief(options: {
	milestone: PlanMilestone;
	activePlan: ActivePlanContext;
	milestoneDir: string;
	blockerPath?: string;
	archivedBlockerPaths: string[];
}): string {
	const contractPath = path.join(PACKAGE_ROOT, "docs", "planner-workflow.md");
	const specPath = path.join(options.milestoneDir, "spec.yaml");
	const statePath = path.join(options.milestoneDir, "state.yaml");
	const executionPath = path.join(options.milestoneDir, "execution.md");
	const milestoneGuidePath = path.join(options.milestoneDir, "milestone.md");

	return [
		`Continue the native /replanner workflow for milestone ${formatResolvedMilestone(options.milestone)}.`,
		"",
		"Read before acting:",
		`- Workflow contract: \`${contractPath}\``,
		`- Plan index: \`${options.activePlan.plan.planPath}\``,
		`- Milestone guide: \`${milestoneGuidePath}\``,
		`- Spec: \`${specPath}\``,
		`- State: \`${statePath}\``,
		`- Execution log: \`${executionPath}\``,
		options.blockerPath ? `- Current blocker: \`${options.blockerPath}\`` : "- Current blocker: none",
		`- Archived blockers: ${options.archivedBlockerPaths.length > 0 ? options.archivedBlockerPaths.map((entry) => `\`${entry}\``).join(", ") : "none"}`,
		"",
		"Replanning rules:",
		"- You may split/reorder/add tasks, narrow scope, move overflow scope to future milestones, revise acceptance criteria/test strategy, and mark tasks `skipped` only with explicit rationale.",
		"- Do not silently discard already completed useful work.",
		"- After replanning, spec/state task ids must match exactly.",
		"- Set milestone status back to `planned` or `in_progress` based on the repaired plan context.",
		"- Clear incompatible blocked state, set `unblocked_at` when appropriate, and adjust checkpoint to a safe resumable state.",
		"- Append a replanning summary to execution.md.",
		"",
		"Use built-in file-edit tools for spec.yaml / plan.yaml changes, then call `planner_apply_replan` exactly once to repair state alignment, clear blockers, append replanning evidence, and get the exact next command.",
		"Do not hand-edit state.yaml, blocker.md, blockers/, execution.md, or milestone-result.json for replanning finalization.",
	].join("\n");
}

async function runResumeMilestoneNative(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	activePlan: ActivePlanContext,
	milestone: PlanMilestone,
	milestoneDir: string,
): Promise<void> {
	await ensureMilestoneFiles(milestoneDir);
	await runPlanDefectPreflight("resume_milestone", milestone, milestoneDir);

	const statePath = path.join(milestoneDir, "state.yaml");
	const executionPath = path.join(milestoneDir, "execution.md");
	const stateRecord = await loadMilestoneStateRecord(statePath);
	const status = asString(stateRecord.status) ?? "planned";
	const phase = asString(stateRecord.phase) ?? "not_started";
	if (status === "done" || phase === "finished") {
		throw new Error(`/resume_milestone cannot run because milestone '${milestone.id}' is already complete.`);
	}
	if (status !== "blocked" && status !== "in_progress") {
		throw new Error(
			`/resume_milestone cannot run because milestone '${milestone.id}' has status '${status}'.`,
		);
	}

	const expectedBranch = asString(stateRecord.branch);
	if (expectedBranch) {
		await ensureCurrentBranch(pi, activePlan.repoRoot, expectedBranch, "resume_milestone");
	}

	const blocker = findBlockerMetadata(stateRecord);
	const blockerPath = await resolveActiveBlockerPath(milestoneDir);
	if (status === "blocked" && ["plan_defect", "scope_explosion"].includes(blocker.blockerType ?? "")) {
		throw new Error(
			[
				`/resume_milestone cannot continue milestone '${milestone.id}' while blocker type '${blocker.blockerType}' is active.`,
				blockerPath ? `Blocker file: ${blockerPath}` : undefined,
				`Recommended next command: ${blocker.recommendedNextCommand ?? `/replanner ${milestone.id}`}`,
			].filter(Boolean).join("\n"),
		);
	}

	const checkpoint = asRecord(stateRecord.checkpoint);
	const checkpointTaskId = asString(checkpoint?.task_id);
	const checkpointStep = normalizeCheckpointStep(asString(checkpoint?.step));
	const checkpointExecutionMode = asString(checkpoint?.execution_mode);
	const checkpointExecutionModeReason = asString(checkpoint?.execution_mode_reason);
	const blockedStage = blocker.stage;
	let archivedBlockerPath: string | undefined;
	const timestamp = timestampNow();

	if (status === "blocked") {
		const cleared = await clearMilestoneBlocker({
			milestoneDir,
			timestamp,
			archiveSuffix: checkpointTaskId ?? "resume",
		});
		archivedBlockerPath = cleared.archivedBlockerPath;
		await setMilestoneResumed(statePath, {
			milestoneId: milestone.id,
			taskId: checkpointTaskId,
			checkpointStep,
			timestamp,
		});
		await clearMilestoneResult(milestoneDir);
		await appendExecutionSection(executionPath, {
			timestamp,
			title: "milestone resume",
			body: [
				`- Command: \`/resume_milestone ${milestone.id}\``,
				`- Milestone: ${formatResolvedMilestone(milestone)}`,
				blocker.blockerType ? `- Cleared blocker type: \`${blocker.blockerType}\`` : undefined,
				blockedStage ? `- Cleared blocker stage: \`${blockedStage}\`` : undefined,
				blocker.reason ? `- Prior blocker reason: ${blocker.reason}` : undefined,
				archivedBlockerPath ? `- Archived blocker: \`${archivedBlockerPath}\`` : undefined,
				`- Resumed checkpoint: \`{ task_id: ${checkpointTaskId ?? "null"}, step: ${checkpointStep} }\``,
				...formatTaskExecutionModeLines({
					executionMode: checkpointExecutionMode,
					executionModeReason: checkpointExecutionModeReason,
				}),
			].filter(Boolean).join("\n"),
		});
		if (blockedStage === "hardening_validation") {
			await runMilestoneHardenNative(pi, ctx, activePlan, milestone, milestoneDir, {
				resumeFromValidationBlocker: true,
			});
			return;
		}
		if (blockedStage === "review_validation") {
			await runMilestoneReviewNative(pi, ctx, activePlan, milestone, milestoneDir, {
				resumeFromValidationBlocker: true,
			});
			return;
		}
		if (!checkpointTaskId || checkpointStep === "done") {
			await runMilestonerNative(pi, ctx, activePlan, milestone, milestoneDir);
			return;
		}
	}

	if (status === "in_progress" && (!checkpointTaskId || checkpointStep === "done")) {
		await runMilestonerNative(pi, ctx, activePlan, milestone, milestoneDir);
		return;
	}

	dispatchWorkflowMessage(
		pi,
		ctx,
		"resume_milestone",
		buildNativeResumeBrief({
			milestone,
			milestoneDir,
			taskId: checkpointTaskId,
			checkpointStep,
			executionMode: checkpointExecutionMode,
			executionModeReason: checkpointExecutionModeReason,
			blockerType: blocker.blockerType,
			blockerReason: blocker.reason,
			archivedBlockerPath,
		}),
	);
}

async function runReplannerNative(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	activePlan: ActivePlanContext,
	milestone: PlanMilestone,
	milestoneDir: string,
): Promise<void> {
	await ensureMilestoneFiles(milestoneDir);
	const blockerPath = await resolveActiveBlockerPath(milestoneDir);
	const archivedBlockerPaths = await listArchivedBlockerPaths(milestoneDir);

	dispatchWorkflowMessage(
		pi,
		ctx,
		"replanner",
		buildNativeReplannerBrief({
			milestone,
			activePlan,
			milestoneDir,
			blockerPath,
			archivedBlockerPaths,
		}),
	);
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
				milestoneDir,
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
	return readStructuredTaskIdsFromYaml(filePath);
}

function readTaskIdsFromYamlSync(filePath: string): Set<string> {
	return readStructuredTaskIdsFromYamlSync(filePath);
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

function dispatchWorkflowMessage(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	commandName: PlannerCommandName,
	message: string,
): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(message);
	} else {
		pi.sendUserMessage(message, { deliverAs: "followUp" });
		ctx.ui.notify(`Queued validated /${commandName} workflow as follow-up.`, "info");
	}
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
	normalizeOriginUrl,
	resolveMilestoneSelector,
	getArgumentCompletionsForCommand,
	collectMilestoneCompletionItems,
	collectTaskCompletionItems,
	loadCompletionPlanContext,
	commandSpecs: COMMAND_SPECS,
};
