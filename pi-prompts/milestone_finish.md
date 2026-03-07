---
description: Finalize a reviewed milestone and mark completion state
---
You are executing `/milestone_finish` for milestone selector:

`$1`

## Required behavior

1. If `$1` is empty, hard-stop with:
   - `Usage: /milestone_finish <milestone>`
2. Read and follow `docs/planner-workflow.md` completely.
3. Run all common validations for non-/planner commands.
4. Resolve milestone by id/slug/directory name.
5. Verify completion preconditions:
   - all required tasks are `done` or `skipped`
   - review phase completed
   - no unresolved high/medium review issues in `review.md`
   - no active `blocker.md`
6. Enforce transition:
   - status `in_progress -> done`
   - phase `review -> finished`

State updates:

- `status: done`
- `phase: finished`
- set `completed_at`
- set `updated_at`

Append final summary to `execution.md` including:

- tests added
- docs updated
- validations run
- commits created (task + hardening + review)
- remaining low-priority deferred issues

## Required final response

Return a concise completion summary with:

1. milestone resolved
2. final status + phase
3. completed timestamp
4. key evidence sources (`execution.md`, `review.md`)
5. next recommended command (usually next milestone)
