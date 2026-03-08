---
description: Reference notes for native /milestoner behavior
---
Reference only: `/milestoner` is orchestrated by native extension code.

Use the package-local planner workflow contract:

- `agenttools/docs/planner-workflow.md`

Native expectations:

- deterministic milestone resolution
- deterministic task ordering from `spec.yaml`
- immediate stop on blocked state
- native progression through start, task execution, hardening, review, and finish
- machine-readable `milestone-result.json` output

Keep responses concise:

- if completed: completion summary + key evidence
- if blocked: stage, blocker type, blocker path, next command
