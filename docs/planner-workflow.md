# Planner Workflow Contract (v1)

This document defines the deterministic workflow used by these commands:

- `/planner`
- `/milestoner`
- `/milestone_start`
- `/tasker`
- `/milestone_harden`
- `/milestone_review`
- `/milestone_finish`
- `/resume_milestone`
- `/replanner`

Use this as a strict contract. If a command cannot satisfy a hard rule, it must stop with a clear error.

Prompt markdown files in `pi-prompts/` are reference/spec aids only. Native planner-workflow execution, state mutation, blocker handling, validation policy, and result emission must live in extension/runtime code.

---

## Core goals

1. Deterministic behavior
2. Explicit state transitions
3. Small recoverable work units
4. TDD where appropriate
5. Resume from checkpoints
6. Low ambiguity for coding agents

---

## Plan location and layout

All plans live under:

`~/data/planner/<plan-name>/`

Required structure:

```text
~/data/planner/<plan-name>/
  README.md
  plan.yaml
  milestones/
    m1-<slug>/
      spec.yaml
      state.yaml
      milestone.md
      execution.md
      blocker.md        # only when currently blocked
      blockers/         # archive of prior blockers
        <timestamp>-<task-id>.md
      review.md         # only after review
    m2-<slug>/
      ...
```

---

## Repo-local active plan pointer (required)

All commands except `/planner` must use this file to resolve the active plan:

`<repo-root>/.pi/active_plan`

Pointer format:

- Single line
- Absolute path to plan directory

Example:

`/home/user/data/planner/encrypted-sync`

### Pointer behavior

`/planner` must:

1. Create or update `<repo-root>/.pi/active_plan`.
2. Ensure this pointer does not dirty the repo:
   - Preferred: append to `.git/info/exclude`
   - Fallback: append to `.gitignore` if `.git/info/exclude` is not writable
3. If fallback is used, record that in plan `README.md`.

If pointer is missing/unreadable for non-`/planner` commands, stop and instruct user to run `/planner` (or restore the pointer).

---

## File roles

### `plan.yaml` (small index)

Contains:

- `schema_version`
- plan metadata
- repo identity + default branch
- milestone index and paths
- optional high-level dependencies

### `spec.yaml` (milestone contract; mostly static)

Contains:

- milestone goal
- scope / out-of-scope
- dependencies / risks
- acceptance criteria
- task definitions
- test strategy
- done conditions

### `state.yaml` (runtime mutable state)

Contains:

- schema version
- milestone status and phase
- branch
- timestamps
- task statuses + commit evidence
- blocked info
- checkpoint
- last completed task

### `milestone.md`

Human-readable milestone guide.

### `execution.md`

Append-only evidence log.

Must include concrete evidence:

- commands run
- summarized test outputs
- commit SHAs

### `blocker.md`

Current blocker report (exists only while blocked).

### `blockers/`

Archive for older blockers (append-only history).

### `review.md`

Review findings, fixes, and remaining deferred items.

---

## Allowed enums

### Milestone status

- `planned`
- `in_progress`
- `blocked`
- `done`
- `skipped`

### Milestone phase

- `not_started`
- `started`
- `task_execution`
- `hardening`
- `review`
- `finished`

### Task status

- `planned`
- `in_progress`
- `blocked`
- `done`
- `skipped`

### Task execution mode

- `tdd`
- `docs_only`
- `pure_refactor`
- `build_config`
- `generated_update`

`execution_mode` is optional in `spec.yaml.tasks[]`.
If omitted, the task defaults to `tdd`.
If a non-`tdd` mode is used, `execution_mode_reason` is required.

### Blocker types

- `clarification`
- `test_failure`
- `environment`
- `plan_defect`
- `scope_explosion`
- `external_dependency`
- `unknown`

### Checkpoint steps

- `not_started`
- `tests_written`
- `tests_red_verified`
- `implementation_started`
- `tests_green_verified`
- `done`

### Timestamp format

ISO-8601 with timezone offset, e.g.:

`2026-03-07T10:12:00+01:00`

---

## Validation execution policy

Validation commands declared in `spec.yaml.validation.commands` must be treated as one of:

- `origin: canonical`
- `origin: exploratory`

Policy:

- canonical failures are blocking by default
- exploratory failures are advisory by default
- exploratory failures become blocking when the milestone acceptance criteria or milestone-touched code makes that validation class attributable/relevant
- all validation outcomes must be recorded in `execution.md` and, when relevant, `review.md`

This policy is intended to keep milestone execution deterministic without turning unrelated pre-existing repo debt into an automatic blocker.

---

## Explicit transition rules

### Milestone status transitions (hard-enforced)

Allowed only:

- `planned -> in_progress` via `/milestone_start`
- `in_progress -> blocked` via `/tasker`, `/milestone_harden`, `/milestone_review`
- `blocked -> in_progress` via `/resume_milestone`
- `in_progress -> done` via `/milestone_finish`
- `planned|in_progress|blocked -> skipped` via `/replanner`

Any other transition is a hard stop as `plan_defect`.

### Milestone phase transitions (hard-enforced)

Allowed only:

- `not_started -> started` via `/milestone_start`
- `started|task_execution -> task_execution` via `/tasker`
- `task_execution -> hardening` via `/milestone_harden`
- `hardening -> review` via `/milestone_review`
- `review -> finished` via `/milestone_finish`

Phase may remain unchanged when blocking, but must never jump outside this graph.

---

## Common validations (all commands except `/planner`)

Before doing anything:

1. Verify execution is inside a git repo; resolve repo root.
2. Read `<repo-root>/.pi/active_plan`; resolve plan dir.
3. Load `plan.yaml` and validate repo identity (best effort):
   - same repo root
   - if `origin_url` exists in plan, current origin should match
4. Use `plan.yaml.repo.default_branch` (never hardcode `main`/`master`).

On failure: stop with a clear fix message.

---

## Hard rule: spec/state task alignment

For each milestone, the task-id sets must match exactly:

- `spec.yaml.tasks[].id`
- `state.yaml.tasks[].id`

Mismatch handling (hard stop):

- set milestone status to `blocked`
- set blocker type to `plan_defect`
- recommend `/replanner <milestone>`

---

## Command contracts

## `/planner <workdesc>`

Purpose:

- Create initial plan structure for a larger software change.

Responsibilities:

- inspect repo structure/conventions
- infer language/tooling/testing/docs setup
- detect repo identity and default branch
- derive milestone-local validation profiles under `spec.yaml.validation`
- decompose into milestones
- create plan root + milestone directories
- write static files (`README.md`, `plan.yaml`, `spec.yaml`, `state.yaml`, `milestone.md`, `execution.md`)
- create/update repo-local active-plan pointer and ignore entry

Clarification policy:

- Ask only when ambiguity materially affects architecture/API/persistence/milestones/test strategy.
- Otherwise proceed with explicit assumptions.

Plan-name derivation:

- take the first 50 characters of `<workdesc>`
- if `<workdesc>` is longer, truncate before slug generation
- slugify deterministically to lowercase `[a-z0-9-]`
- collapse repeated `-`

`README.md` must include:

- title
- work description
- scope / out of scope
- repository context (identity + default branch)
- assumptions
- open questions
- milestone overview
- recommended execution order
- overall definition of done

Initial `state.yaml` for each milestone:

- `status: planned`
- `phase: not_started`
- `branch: null`
- timestamps null
- `blocked_on: null`
- checkpoint set to `{ task_id: null, step: not_started }`
- per-task entries with `status: planned`, `commit: null`

Each generated milestone `spec.yaml` must also include an explicit milestone-local validation block:

- `validation.commands`
- each command annotated with `kind` and `origin`
- repo-declared validations should be `canonical`
- guessed fallback validations should be `exploratory`

Task contracts may also declare explicit non-default execution behavior:

- default task flow is implicit `execution_mode: tdd`
- tasks that are not appropriate for the default TDD loop must declare:
  - `execution_mode`
  - `execution_mode_reason`
- supported non-default modes are:
  - `docs_only`
  - `pure_refactor`
  - `build_config`
  - `generated_update`

## `/milestone_start <milestone>`

Preconditions:

- common validations pass
- current branch equals plan default branch
- no staged or unstaged tracked changes (ignore untracked files)

Behavior:

- resolve milestone by id/slug/directory name
- create and switch to `feat/<milestone-slug>`; stop if branch exists
- update `state.yaml`:
  - `status: in_progress`
  - `phase: started`
  - `branch: feat/<milestone-slug>`
  - set `started_at`, `updated_at`
  - reset checkpoint to `task_id: null`, `step: not_started`
- append start evidence to `execution.md`

## `/tasker <task-id>`

Execute exactly one task.

Default flow (unless a documented exception applies):

1. inspect task contract + code context
2. write tests from task test strategy
3. checkpoint -> `tests_written`
4. run narrow tests
5. verify expected red
6. checkpoint -> `tests_red_verified`
7. implement code
8. checkpoint -> `implementation_started`
9. rerun tests until green
10. checkpoint -> `tests_green_verified`
11. run slightly broader validation
12. create the required task commit
13. finalize task outcome natively (`done`, checkpoint -> `done`)

Execution-mode policy:

- default task flow is `tdd`
- non-`tdd` tasks must be explicitly declared in `spec.yaml.tasks[]`
- supported non-`tdd` modes are:
  - `docs_only`
  - `pure_refactor`
  - `build_config`
  - `generated_update`
- non-`tdd` tasks must carry `execution_mode_reason`
- runtime state/evidence must preserve the chosen mode and rationale

TDD policy:

- `tdd` tasks follow default red->green->refactor
- never claim red unless observed
- do not force fake TDD checkpoints for explicit non-`tdd` tasks
- for non-`tdd` tasks, completion is allowed only after checkpoint `implementation_started` (or later) and only when the explicit mode/rationale has been recorded

Per-task commit policy (hard rule):

- each successful task gets a commit
- message format: `<task-id>: <task title>`
- if no changes are needed, use `--allow-empty` and explain why in commit body + `execution.md`
- record commit SHA in state + execution log
- task-completion tooling must verify that the provided commit SHA exists and is reachable from the current milestone branch
- prefer `planner_finalize_task_outcome` to atomically append final task evidence and mark the task `done`
- `planner_complete_task` should only be used once the task checkpoint has already reached `tests_green_verified` (or an equivalent documented exception flow has been recorded in evidence)

Blocking behavior:

- prefer `planner_finalize_task_outcome` to atomically append final task evidence and mark the task `blocked`
- task-scoped state mutation tools must verify the milestone branch before mutating workflow files

- on block, task -> `blocked`, milestone -> `blocked`
- set `blocked_at` if unset
- set structured `blocked_on`
- archive prior `blocker.md` to `blockers/<timestamp>-<task-id>.md`
- create fresh `blocker.md`
- recommend `/resume_milestone <milestone>`

## `/milestone_harden <milestone>`

- set phase to `hardening`
- verify all non-skipped tasks are done
- run `spec.yaml.validation.commands` using the canonical vs exploratory policy above
- update docs as needed
- fix obvious inconsistencies
- if hardening makes changes, commit `<milestone-id>: hardening`
- append evidence to `execution.md`
- on failure: block milestone and create blocker report

## `/milestone_review <milestone>`

- set phase to `review`
- require the shared `prepare_review` tool to be installed and active
- call `prepare_review` deterministically using branch scope against `plan.yaml.repo.default_branch`
- use the returned review packet to perform the review and write milestone `review.md`
- fix high and medium findings
- rerun `spec.yaml.validation.commands` using the canonical vs exploratory policy above
- commit review fixes as `<milestone-id>: review fixes` (prefer one commit)
- write `review.md` including method/findings/fixes/deferred/rerun evidence/commit SHA
- if `prepare_review` is unavailable or inactive, stop with a clear error; do not silently fall back to manual self-review
- on failure: block milestone and create blocker report

## `/milestone_finish <milestone>`

Before finishing verify:

- required tasks are done or skipped
- review phase completed
- no unresolved high/medium review issues in `review.md`
- no active `blocker.md`

Then set:

- status -> `done`
- phase -> `finished`
- set `completed_at`, `updated_at`

Append final completion summary to `execution.md`.

## `/milestoner <milestone>`

Thin orchestration flow:

1. milestone start
2. deterministic task ordering:
   - topological sort by task dependencies
   - tie-break by original order in `spec.yaml`
   - if cycle -> hard-stop `plan_defect`, recommend `/replanner <milestone>`
3. execute tasks one-by-one (`/tasker` behavior)
4. stop immediately on block
5. hardening
6. review
7. finish

On any block, stop and report:

- exact stage where it stopped
- blocker type
- blocker file path
- recommended next command

## `/resume_milestone <milestone>`

Allowed statuses:

- `blocked`
- `in_progress`

Disallowed:

- `done`
- clearly invalid milestone contracts requiring replanning

Blocker-type decisions:

- `clarification`: resume only after clarification/spec update exists
- `environment`: verify environment fixed
- `test_failure`: retry task unless evidence indicates plan defect
- `plan_defect|scope_explosion`: do not continue blindly; recommend `/replanner`
- `external_dependency`: resume only if dependency is available or intentionally bypassed

Checkpoint resume rules:

- `not_started` -> start task normally
- `tests_written` -> rerun tests and continue
- `tests_red_verified` -> implement next
- `implementation_started` -> inspect partial state; continue safely
- `tests_green_verified` -> broader validation then close
- `done` -> move to next task/phase

On resume:

- append resume entry to `execution.md`
- clear/archive stale blocker info when appropriate
- set status back to `in_progress` if unblocked

If resume is unsafe/impossible, stop and direct user clearly.

## `/replanner <milestone>`

Use when execution evidence indicates plan defects/scope issues.

Inputs to read:

- `spec.yaml`
- `state.yaml`
- `execution.md`
- `blocker.md` + archive

Allowed revisions:

- split/reorder/add tasks
- narrow scope
- move overflow scope to future milestone(s)
- revise acceptance criteria/test strategy
- mark tasks `skipped` (only here, with rationale)

After replanning:

- ensure spec/state task-id sets match exactly
- set status to `planned` or `in_progress` based on context
- clear incompatible blocked state and set `unblocked_at` when applicable
- adjust checkpoint safely
- append replanning summary to `execution.md`
- if milestones split, update root `plan.yaml`

Output summary must include:

- what was wrong
- what changed
- recommended next command (usually `/resume_milestone` or `/milestoner`)

---

## Global guardrails

Never:

- run without active plan pointer (except `/planner`)
- ignore repo identity mismatch
- start milestone with staged or unstaged tracked changes
- silently ignore test failures
- mark done without contract evidence
- invent test/review success
- continue past blocked state without resume/replan logic
- allow spec/state task-id drift
- mark tasks skipped outside `/replanner`

Prefer:

- repo conventions over generic defaults
- narrow validation during task execution
- broader validation during hardening/review
- explicit checkpointing
- explicit blocker reporting with history preservation
- per-task commits
- resumable transitions

---

## Recommended user flow

Normal:

1. `/planner <workdesc>`
2. `/milestoner <milestone>`

When blocked:

1. `/resume_milestone <milestone>`

When the plan is wrong:

1. `/replanner <milestone>`
2. `/resume_milestone <milestone>`

---

## Short example

Example goal:

> Add a planner workflow extension with milestone/task orchestration.

Typical session:

```text
/planner Add a planner workflow extension with milestone/task orchestration
```

This creates a plan under `~/data/planner/<plan-name>/` and writes the active pointer to:

```text
<repo-root>/.pi/active_plan
```

Inspect the generated milestones, then run one end-to-end:

```text
/milestoner m1
```

If you want to drive the milestone manually instead of using `/milestoner`:

```text
/milestone_start m1
/tasker m1-t1
/tasker m1-t2
/milestone_harden m1
/milestone_review m1
/milestone_finish m1
```

If execution blocks partway through:

```text
/resume_milestone m1
```

If the execution evidence shows the plan itself is wrong:

```text
/replanner m1
/resume_milestone m1
```

Use milestone ids from `plan.yaml` and task ids from the milestone `spec.yaml` / `state.yaml`.
