---
description: Reference notes for native /planner behavior
---
Reference only: `/planner` is orchestrated by native extension code.

Use the package-local planner workflow contract:

- `agenttools/docs/planner-workflow.md`

Native expectations:

- inspect the repo and derive milestone-local validation profiles
- create `README.md`, `plan.yaml`, milestone files, and the repo-local active-plan pointer
- use `planner_apply_validation_profile` for each milestone `spec.yaml`
- use `planner_finalize_plan` exactly once after file generation
- record canonical vs exploratory validation intent explicitly in `spec.yaml.validation.commands`
- for any non-default task flow, record explicit `execution_mode` and `execution_mode_reason` in that task contract

Keep responses concise:

1. plan directory
2. pointer path + ignore strategy
3. milestone list
4. assumptions
5. open questions
