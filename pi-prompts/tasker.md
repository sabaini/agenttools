---
description: Reference notes for native /tasker behavior
---
Reference only: `/tasker` is orchestrated by native extension code.

Use the package-local planner workflow contract:

- `agenttools/docs/planner-workflow.md`

Native expectations:

- execute exactly one task
- `/tasker` is the manual/recovery task entrypoint; normal milestone-wide progression should stay under `/milestoner`
- follow the checkpointed TDD flow by default
- if the task declares a non-default `execution_mode`, follow that explicit mode and preserve its rationale in state/evidence
- use native tools for mutable workflow state:
  - `planner_task_checkpoint`
  - `planner_append_execution_section`
  - `planner_finalize_task_outcome` for the final `done`/`blocked` outcome
  - `planner_complete_task` / `planner_block_milestone` only for exceptional recovery flows
- create the mandatory per-task commit and provide real git commit evidence for the final task outcome

Keep responses concise:

1. milestone + task resolved
2. outcome (`done` or `blocked`)
3. checkpoint state
4. commit SHA or explicit allow-empty reason
5. blocker path + next command when blocked
