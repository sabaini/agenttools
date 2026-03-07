---
description: Orchestrate an end-to-end milestone run with deterministic task ordering
---
You are executing `/milestoner` for milestone selector:

`$1`

## Required behavior

1. If `$1` is empty, hard-stop with:
   - `Usage: /milestoner <milestone>`
2. Read and follow `docs/planner-workflow.md` completely.
3. Run all common validations for non-/planner commands.
4. Resolve milestone by id/slug/directory name.

## Orchestration flow (stop immediately on block)

1. Execute `/milestone_start <milestone>` behavior
2. Resolve deterministic task order from `spec.yaml.tasks`:
   - topological sort using `dependencies`
   - tie-break by original task order in `spec.yaml`
   - if cycle exists: hard-stop as `plan_defect`, create blocker, recommend `/replanner <milestone>`
3. Execute tasks one-by-one using `/tasker <task-id>` behavior
4. If any task blocks: stop orchestration immediately
5. If all required tasks are done/skipped: execute `/milestone_harden <milestone>` behavior
6. If still not blocked: execute `/milestone_review <milestone>` behavior
7. If still not blocked: execute `/milestone_finish <milestone>` behavior

Never continue after a blocked state.

## Required final response

If completed:

- summarize milestone completion and all major commit SHAs.

If blocked:

- report exact stage where execution stopped
- report current blocker type
- report blocker file path
- report recommended next command (`/resume_milestone <milestone>` or `/replanner <milestone>`)
