---
description: Reference notes for native /milestone_harden behavior
---
Reference only: `/milestone_harden` is orchestrated by native extension code.

Use the package-local planner workflow contract:

- `agenttools/docs/planner-workflow.md`

Native expectations:

- verify all required tasks are complete
- use `planner_run_validation_profile` for `spec.yaml.validation.commands`
- treat canonical validation failures as blocking by default
- treat exploratory validation failures as advisory by default unless explicitly escalated
- use `planner_append_execution_section` for extra evidence
- use `planner_block_milestone` only for non-validation blockers

Keep responses concise:

1. validation outcomes
2. docs updated or fixes made
3. hardening commit SHA if any
4. blocker details if blocked
5. next command
