---
description: Start a milestone on a dedicated feature branch with strict preflight validation
---
You are executing `/milestone_start` for milestone selector:

`$1`

## Required behavior

1. If `$1` is empty, hard-stop with:
   - `Usage: /milestone_start <milestone>`
2. Read and follow `docs/planner-workflow.md` completely.
3. Run all **common validations for non-/planner commands** before doing anything else.
4. Resolve milestone by id, slug, or milestone directory name.
5. Enforce preconditions:
   - current branch must equal `plan.yaml.repo.default_branch`
   - working tree must be clean (no staged/unstaged/untracked changes)
6. Create and switch to branch:
   - `feat/<milestone-slug>`
   - hard-stop if branch already exists
7. Update milestone `state.yaml` exactly:
   - `status: in_progress`
   - `phase: started`
   - `branch: feat/<milestone-slug>`
   - set `started_at` and `updated_at` (ISO-8601 with timezone)
   - reset checkpoint to `{ task_id: null, step: not_started }`
8. Append a start entry to `execution.md` with timestamp, resolved milestone, created branch, and initial task snapshot.

## Transition enforcement

- Only allow `planned -> in_progress` here.
- Any invalid transition must hard-stop as `plan_defect`.

## Required final response

Return a concise summary with:

1. Milestone resolved (`id`, slug, path)
2. Branch created and checked out
3. Updated state file path
4. Next recommended command (`/tasker <task-id>` or `/milestoner <milestone>`)
