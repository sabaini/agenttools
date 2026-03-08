# README

Tools for coding agents (currently focused on pi).

## Planner workflow suite

This repository now includes a deterministic planning/execution prompt suite for pi commands:

- `/planner`
- `/milestoner`
- `/milestone_start`
- `/tasker`
- `/milestone_harden`
- `/milestone_review`
- `/milestone_finish`
- `/resume_milestone`
- `/replanner`

Prompt templates live in `pi-prompts/`.
Shared workflow contract: `docs/planner-workflow.md`.

Validated command wrapper extension:

- `pi-extensions/planner-workflow.ts`
- `.pi/extensions/planner-workflow.ts` (project-local auto-load entrypoint)

This wrapper hard-validates arguments and repo/plan preflight checks before dispatching to the prompt workflows.
It also provides argument auto-completion from the active plan (milestone ids/slugs/dirs and task ids).
You can load it explicitly with `pi -e ./pi-extensions/planner-workflow.ts`.

## Pi package usage

This repository is also a local pi package. It exposes:

- extensions from `pi-extensions/*.ts`
- prompt templates from `pi-prompts/*.md`

Install it globally so commands like `/milestoner` and `/review` are available in every project:

```bash
pi install /home/ubuntu/src/agenttools
```

Then reload pi resources:

```text
/reload
```

The review extension also registers a shared `prepare_review` tool. `/review` uses the same core review-preparation logic as planner-driven milestone review, so orchestration no longer depends on slash-command availability during the review phase.

### Quick example

```text
/planner Add a planner workflow extension with milestone/task orchestration
/milestoner m1
```

Manual flow:

```text
/milestone_start m1
/tasker m1-t1
/tasker m1-t2
/milestone_harden m1
/milestone_review m1
/milestone_finish m1
```

If blocked:

```text
/resume_milestone m1
```

If the plan is wrong:

```text
/replanner m1
/resume_milestone m1
```
