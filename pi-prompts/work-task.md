---
description: Execute one grns task and return strict JSON for automation
---
You are running one task execution loop for task **$1**.

## Rules

- Task id is: `$1`
- You may read/update code and run tests.
- You may run git commands, including commit, if changes are ready.
- **Do NOT mutate grns task state directly** (no `grns update`, `grns close`, `grns create`, `grns dep add`).
  - The outer worker process applies task updates from your JSON result.
- If you are uncertain or blocked, prefer requesting human input instead of guessing.

## Required workflow

1. Inspect task details and dependencies:
   - `grns show $1 --json`
2. Implement the task in code (or determine why it cannot be completed now).
3. Run relevant validation (tests/lint/build as appropriate).
4. If implementation is complete and validated, create a git commit:
   - Commit message should start with `$1: ...`
   - Capture commit SHA.
5. Decide final outcome and any follow-up work.

## Output format (STRICT)

Return **only** one JSON object (no markdown, no prose):

```json
{
  "task_id": "$1",
  "outcome": "done",
  "summary": "Short summary of what happened",
  "status": "closed",
  "notes": "Checkpoint-style note with key details",
  "commit_sha": "0123456789abcdef0123456789abcdef01234567",
  "commit_repo": "github.com/org/repo",
  "followups": [
    {
      "title": "Optional follow-up task",
      "type": "task",
      "priority": 2,
      "description": "Why this follow-up exists",
      "labels": ["auth"],
      "blocks_current": false
    }
  ],
  "human_gate": {
    "needed": false,
    "title": "",
    "assignee": "",
    "kind": "decision",
    "description": "",
    "acceptance": "",
    "priority": 1,
    "labels": []
  }
}
```

## Field constraints

- `outcome`: one of `done|blocked|needs_human|failed|deferred`
- `status`: one of `open|in_progress|blocked|deferred|closed`
- `commit_sha`: optional, but if present must be 40-char lowercase hex
- `followups`: optional array (empty if none)
- `human_gate.needed=true` requires non-empty `title`, `assignee`, `kind`
- If no commit was made, set `commit_sha` to empty string.
- If no followups/human gate are needed, return empty values as shown.
