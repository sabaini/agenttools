# README

Tools for coding agents (currently focused on pi).

## Planner workflow suite

This repository now includes a deterministic planning/execution prompt suite for pi commands:

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
Shared workflow contract: `docs/planner-workflow.md`.

Validated command wrapper extension:

- `pi-extensions/planner-workflow.ts`
- `.pi/extensions/planner-workflow.ts` (project-local auto-load entrypoint)

This wrapper hard-validates arguments and repo/plan preflight checks before dispatching to the prompt workflows.
It also provides argument auto-completion from the active plan (milestone ids/slugs/dirs and task ids).
You can load it explicitly with `pi -e ./pi-extensions/planner-workflow.ts`.
