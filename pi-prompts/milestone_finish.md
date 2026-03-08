---
description: Reference notes for native /milestone_finish behavior
---
Reference only: `/milestone_finish` is orchestrated by native extension code.

Use the package-local planner workflow contract:

- `agenttools/docs/planner-workflow.md`

Native expectations:

- verify review completion
- verify no unresolved high/medium review findings remain
- verify no active blocker remains
- finalize state to `done` / `finished`
- append final evidence and write `milestone-result.json`

Keep responses concise:

1. milestone resolved
2. final status + phase
3. completion timestamp
4. evidence paths
5. next command
