---
description: Create or refresh a deterministic implementation plan and activate it for this repo
---
You are executing `/planner`.

Work description:

`$ARGUMENTS`

## Required behavior

1. If `$ARGUMENTS` is empty, hard-stop with:
   - `Usage: /planner <workdesc>`
2. Read and follow `docs/planner-workflow.md` completely.
3. Apply the `/planner` contract exactly, including:
   - repository inspection
   - milestone decomposition
   - creation of `README.md`, `plan.yaml`, and milestone files
   - repo-local pointer creation at `<repo-root>/.pi/active_plan`
   - pointer ignore handling via `.git/info/exclude` (fallback `.gitignore` + README note)
4. Ask clarifying questions only when ambiguity materially affects architecture/API/persistence/milestone boundaries/test strategy.
   - Otherwise proceed and record explicit assumptions.

## Determinism rules

- Derive `plan-name` from the first 50 characters of `$ARGUMENTS`.
- If `$ARGUMENTS` is longer than 50 characters, truncate before slug generation.
- Slugify deterministically to stable lowercase (`[a-z0-9-]`, collapse repeated `-`).
- Prefer stable milestone ids and slugs (`m1`, `m2`, ... in recommended execution order).
- Keep `plan.yaml` small and index-focused.
- Initialize each milestone `state.yaml` in `planned/not_started` state with null timestamps and per-task `planned` statuses.

## Required final response

Return a concise summary with:

1. Plan directory path
2. Active pointer path and selected ignore strategy (`.git/info/exclude` or `.gitignore` fallback)
3. Milestone list (`id`, `slug`, path)
4. Assumptions recorded
5. Open questions (if any)
