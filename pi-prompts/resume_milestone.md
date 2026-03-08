---
description: Reference notes for native /resume_milestone behavior
---
Reference only: `/resume_milestone` is orchestrated by native extension code.

Use the package-local planner workflow contract:

- `agenttools/docs/planner-workflow.md`

Native expectations:

- validate blocked/in-progress resume eligibility
- reject `plan_defect` / `scope_explosion` resumes and recommend `/replanner`
- preserve checkpoint-based continuation
- archive stale blocker state when safely resuming
- use native tools for further task/evidence mutation after resume:
  - `planner_task_checkpoint`
  - `planner_append_execution_section`
  - `planner_finalize_task_outcome` for the final resumed-task outcome
  - `planner_complete_task` / `planner_block_milestone` only for exceptional recovery flows

Keep responses concise:

1. resume decision
2. blocker assessment + checkpoint
3. state changes made
4. exact next command
