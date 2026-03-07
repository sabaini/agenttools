---
description: Review milestone output, fix findings, rerun validation, and record review results
---
You are executing `/milestone_review` for milestone selector:

`$1`

## Required behavior

1. If `$1` is empty, hard-stop with:
   - `Usage: /milestone_review <milestone>`
2. Read and follow `docs/planner-workflow.md` completely.
3. Run all common validations for non-/planner commands.
4. Resolve milestone by id/slug/directory name.
5. Enforce phase transition `hardening -> review`.

Review flow:

1. run `/review`
2. parse findings
3. fix all high and medium findings
4. rerun relevant validation/tests
5. create review-fix commit (prefer one):
   - `<milestone-id>: review fixes`

If `/review` is unavailable:

- perform a manual self-review
- explicitly state this in `review.md`

Write `review.md` with:

- review method
- findings summary
- high/medium issues fixed
- low issues deferred
- validation rerun evidence
- review-fix commit SHA (if any)

On block/failure:

- set milestone status `blocked`
- set `blocked_at` if needed
- archive old `blocker.md` if present
- write new `blocker.md`
- recommend `/resume_milestone <milestone>`

## Required final response

Return a concise summary with:

1. review method used (`/review` or manual)
2. findings fixed/deferred
3. validation rerun result
4. review commit SHA (if any)
5. blocker details + path if blocked
6. next recommended command
