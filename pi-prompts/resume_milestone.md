---
description: Resume a blocked or incomplete milestone from the safest checkpoint
---
You are executing `/resume_milestone` for milestone selector:

`$1`

## Required behavior

1. If `$1` is empty, hard-stop with:
   - `Usage: /resume_milestone <milestone>`
2. Read and follow `docs/planner-workflow.md` completely.
3. Run all common validations for non-/planner commands.
4. Resolve milestone by id/slug/directory name.
5. Inspect:
   - milestone `state.yaml`
   - current `blocker.md` (if present)
   - checkpoint data

## Resume rules

Allowed milestone statuses:

- `blocked`
- `in_progress`

Do not resume if:

- milestone is `done`
- blocker evidence indicates `plan_defect` or `scope_explosion` requiring `/replanner`
- contract is clearly invalid

Blocker-type handling:

- `clarification`: resume only after required clarification/spec update exists
- `environment`: verify environment appears fixed before retry
- `test_failure`: retry from blocked task unless evidence indicates plan defect
- `plan_defect|scope_explosion`: stop and recommend `/replanner <milestone>`
- `external_dependency`: resume only if dependency is now available or intentionally bypassed

Checkpoint-based continuation:

- `not_started` -> start task normally
- `tests_written` -> rerun tests then continue
- `tests_red_verified` -> implement next
- `implementation_started` -> inspect partial state and continue safely
- `tests_green_verified` -> run broader validation then close task
- `done` -> continue to next task/phase

If partial state is ambiguous/unsafe, restart current task conservatively and record that decision in `execution.md`.

On successful unblocking:

- clear/adjust `blocked_on`
- set milestone status back to `in_progress`
- set `unblocked_at`
- append resume entry to `execution.md`

## Required final response

Return a concise summary with:

1. resume decision (`resumed` vs `cannot resume`)
2. blocker assessment and checkpoint used
3. state changes made (`blocked_on`, status, `unblocked_at`)
4. exact next command
