---
description: Run milestone-wide hardening and record broad validation evidence
---
You are executing `/milestone_harden` for milestone selector:

`$1`

## Required behavior

1. If `$1` is empty, hard-stop with:
   - `Usage: /milestone_harden <milestone>`
2. Read and follow `docs/planner-workflow.md` completely.
3. Run all common validations for non-/planner commands.
4. Resolve milestone by id/slug/directory name.
5. Enforce phase transition to `hardening` only from `task_execution`.
6. Verify all non-skipped tasks are `done` before hardening continues.

Then perform hardening:

- run broader relevant tests
- run lint/typecheck/build if applicable
- update docs for user/operator facing behavior changes
- fix obvious consistency issues
- append evidence to `execution.md` (commands/results/docs/fixes/deferred)

If hardening creates changes, commit:

- `<milestone-id>: hardening`

If hardening fails or blocks:

- set milestone status `blocked`
- set `blocked_at` if needed
- archive previous `blocker.md` (if present)
- create new `blocker.md`
- recommend `/resume_milestone <milestone>`

## Required final response

Return a concise summary with:

1. hardening validations run + outcomes
2. docs updated (if any)
3. hardening commit SHA (if any)
4. blocked details and blocker path if not successful
5. next recommended command
