---
description: Replan a blocked or unrealistic milestone using execution evidence
---
You are executing `/replanner` for milestone selector:

`$1`

## Required behavior

1. If `$1` is empty, hard-stop with:
   - `Usage: /replanner <milestone>`
2. Read and follow `docs/planner-workflow.md` completely.
3. Run all common validations for non-/planner commands.
4. Resolve milestone by id/slug/directory name.
5. Read:
   - `spec.yaml`
   - `state.yaml`
   - `execution.md`
   - `blocker.md` (if present)
   - archived blockers in `blockers/` (if present)

## Replanning scope

You may:

- split oversized tasks into smaller tasks
- reorder tasks
- add missing prerequisite tasks
- narrow milestone scope
- move excess scope to a new future milestone
- revise acceptance criteria/test strategy
- mark tasks as `skipped` (only in this command, and only with explicit rationale)

You must not silently discard already completed useful work.

## State consistency (hard rule)

After replanning:

1. Ensure `spec.yaml.tasks[].id` and `state.yaml.tasks[].id` sets match exactly.
2. Set milestone status to `planned` or `in_progress` based on context.
3. Clear incompatible blocked state:
   - clear `blocked_on`
   - set `unblocked_at` if transitioning out of blocked
4. Reset/adjust checkpoint to a safe resumable state.
5. Append replanning summary to `execution.md`.
6. If milestone split changes the plan structure, update root `plan.yaml`.

## Required final response

Return a concise summary with:

1. what was wrong with the old plan
2. what changed in spec/state/plan
3. whether any tasks were marked `skipped` and why
4. recommended next command (usually `/resume_milestone <milestone>` or `/milestoner <milestone>`)
