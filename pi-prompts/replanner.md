---
description: Reference notes for native /replanner behavior
---
Reference only: `/replanner` is orchestrated by native extension code.

Use the package-local planner workflow contract:

- `agenttools/docs/planner-workflow.md`

Native expectations:

- replan from `spec.yaml`, `state.yaml`, `execution.md`, and blocker evidence
- keep useful completed work
- repair spec/state task alignment
- use `planner_apply_replan` exactly once after spec/plan edits
- if milestone-local validation scope changes, keep `spec.yaml.validation.commands` explicit

Keep responses concise:

1. what was wrong
2. what changed in spec/state/plan
3. skipped tasks and rationale
4. recommended next command
