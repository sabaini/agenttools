---
description: Execute exactly one milestone task with checkpointing, evidence, and per-task commit
---
You are executing `/tasker` for task id:

`$1`

## Required behavior

1. If `$1` is empty, hard-stop with:
   - `Usage: /tasker <task-id>`
2. Read and follow `docs/planner-workflow.md` completely.
3. Run all common validations for non-/planner commands.
4. Resolve the owning milestone and task from the active plan.
5. Load milestone `spec.yaml` and `state.yaml`.
6. Enforce hard rule: `spec.yaml.tasks[].id` set must exactly match `state.yaml.tasks[].id` set.
   - On mismatch: block milestone as `plan_defect`, create/refresh blocker report, recommend `/replanner <milestone>`, and stop.

## Execution contract (exactly one task)

- Mark task `in_progress`
- Set milestone phase to `task_execution`
- Update `updated_at`
- Follow TDD by default (Red -> Green -> Refactor) unless documented exception applies.

Default flow:

1. inspect task contract and relevant code
2. add tests from `test_strategy`
3. checkpoint -> `tests_written`
4. run narrow relevant tests
5. verify expected red
6. checkpoint -> `tests_red_verified`
7. implement code
8. checkpoint -> `implementation_started`
9. rerun relevant tests until green
10. checkpoint -> `tests_green_verified`
11. run slightly broader validation
12. mark task `done`
13. checkpoint -> `done`
14. create task commit

Per-task commit is mandatory for success:

- Commit message: `<task-id>: <task title>`
- If no file changes are required, use `--allow-empty` and document why in commit body + `execution.md`
- Record commit SHA in `state.yaml.tasks[].commit` and `execution.md`

## If blocked

- Set task status `blocked`
- Set milestone status `blocked`
- Populate `blocked_on` structure in `state.yaml`
- Set `blocked_at` if needed
- Archive existing `blocker.md` to `blockers/<timestamp>-<task-id>.md`
- Write new `blocker.md` with required sections
- Recommend `/resume_milestone <milestone>`

Never claim tests/review passed unless actually run.

## Required final response

Return a concise outcome summary:

1. milestone + task resolved
2. task outcome (`done` or `blocked`)
3. checkpoint state
4. commit SHA (or explicit reason for empty/no-op commit)
5. blocker file path + next command when blocked
