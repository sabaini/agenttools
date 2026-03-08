---
description: Reference notes for native /milestone_start behavior
---
Reference only: `/milestone_start` is orchestrated by native extension code.

Use the package-local planner workflow contract:

- `agenttools/docs/planner-workflow.md`

Native expectations:

- enforce branch/working-tree preflight
- create `feat/<milestone-slug>`
- initialize milestone state and checkpoint
- append start evidence to `execution.md`

Keep responses concise:

1. milestone resolved
2. branch created
3. state path
4. next recommended command
