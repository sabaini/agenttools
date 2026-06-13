---
name: jira
description: Use the local jira CLI for Jira Cloud work, list/search/view CEPH issues, inspect boards/sprints, and carefully create/comment/update tickets.
metadata:
  openclaw:
    requires:
      bins: ["jira"]
---

# Jira CLI

Use `/usr/local/bin/jira` / `jira` for Jira work. Prefer this over MCP.

Configured default:
- site: `https://warthogs.atlassian.net`
- project: `CEPH`
- board: `CEPH board`
- auth: `~/.netrc` (do not print or copy secrets)

## Read-only commands

List recent CEPH issues:

```bash
jira issue list --plain --no-headers \
  --columns KEY,SUMMARY,STATUS,ASSIGNEE,UPDATED \
  --order-by updated --paginate 0:20
```

Search with Jira text query:

```bash
jira issue list "replication" --plain --no-truncate --paginate 0:20
```

Use JQL when needed, but keep sorting in CLI flags when possible:

```bash
jira issue list -q 'status = "In Progress"' --order-by updated --plain --paginate 0:20
```

View an issue:

```bash
jira issue view CEPH-1771 --plain
```

Raw JSON for scripts/parsing:

```bash
jira issue list --raw --paginate 0:20
jira issue view CEPH-1771 --raw
```

## Mutations

Ask Peter before external writes/mutations: create, edit, transition, assign, comment, or link issues.

Useful commands after confirmation:

```bash
jira issue create
jira issue edit CEPH-123
jira issue comment add CEPH-123
jira issue move CEPH-123
```

## Notes

- Keep replies concise: summarize key, summary, status, assignee, updated.
- If CLI errors on auth, check `~/.netrc` permissions are `600` and avoid exposing token values.
- For command details, run `jira <command> <subcommand> --help`.
