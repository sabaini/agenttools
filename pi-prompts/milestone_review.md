---
description: Reference notes for native /milestone_review behavior
---
Reference only: `/milestone_review` is orchestrated by native extension code.

Use the package-local planner workflow contract:

- `agenttools/docs/planner-workflow.md`

Native expectations:

- require active deterministic review tooling via `prepare_review`
- prepare deterministic review input with `prepare_review`
- write milestone `review.md`
- fix high and medium findings
- rerun milestone validation with `planner_run_validation_profile`
- treat canonical validation failures as blocking by default
- treat exploratory validation failures as advisory by default unless explicitly escalated
- use `planner_append_execution_section` for extra review evidence
- use `planner_block_milestone` only for non-validation blockers

Keep responses concise:

1. review method used
2. findings fixed/deferred
3. validation rerun result
4. review-fix commit SHA if any
5. blocker details if blocked
6. next command
