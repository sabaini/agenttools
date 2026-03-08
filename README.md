# README

Tools for coding agents (currently focused on pi).

## Planner workflow suite

This repository now includes a deterministic planner-workflow command suite for pi:

- `/planner`
- `/milestoner`
- `/milestone_start`
- `/tasker`
- `/milestone_harden`
- `/milestone_review`
- `/milestone_finish`
- `/resume_milestone`
- `/replanner`

Prompt templates live in `pi-prompts/`.
They are reference/spec aids only; native planner-workflow execution lives in extension/runtime code.
Shared workflow contract lives in this package: `docs/planner-workflow.md`.
Target repos do not need their own copy.

Planner workflow extension:

- `pi-extensions/planner-workflow.ts`
- `.pi/extensions/planner-workflow.ts` (project-local auto-load entrypoint)

It hard-validates arguments and repo/plan preflight checks, provides argument auto-completion from the active plan (milestone ids/slugs/dirs and task ids), and runs the planner-workflow lifecycle natively.
Current native pieces include YAML-backed plan parsing, native `/planner` kickoff with repo-derived milestone validation-profile guidance plus `planner_apply_validation_profile` and `planner_finalize_plan`, native validation-policy execution via `planner_run_validation_profile`, native `/milestoner` task-graph defect blocking and next-step orchestration through milestone completion, native `/milestone_start` branch/state/evidence handling, native `/tasker` kickoff/state/checkpoint handling with explicit non-TDD execution-mode support, verified task-commit evidence, plus atomic `planner_finalize_task_outcome` support, native `/milestone_harden`, `/milestone_review`, `/milestone_finish`, and `/resume_milestone`, native `/replanner` kickoff plus native replanning state-repair/finalization via `planner_apply_replan`, and planner workflow tools for checkpoint/completion/blocker/evidence mutations.
You can load it explicitly with `pi -e ./pi-extensions/planner-workflow.ts`.

## Pi package usage

This repository is also a local pi package. It exposes:

- extensions from `pi-extensions/*.ts`
- prompt templates from `pi-prompts/*.md`

Install it globally so commands like `/milestoner` and `/review` are available in every project:

```bash
pi install /home/ubuntu/src/agenttools
```

Then reload pi resources:

```text
/reload
```

The review extension also registers a shared `prepare_review` tool. `/review` uses the same core review-preparation logic as planner-driven milestone review, and native `/milestone_review` requires that tool to be installed and active.

### Quick example

```text
/planner Add a planner workflow extension with milestone/task orchestration
/milestoner m1
```

Manual flow:

```text
/milestone_start m1
/tasker m1-t1
/tasker m1-t2
/milestone_harden m1
/milestone_review m1
/milestone_finish m1
```

If blocked:

```text
/resume_milestone m1
```

If the plan is wrong:

```text
/replanner m1
/resume_milestone m1
```
