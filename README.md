# README

Tools for coding agents (currently focused on pi).

## Available extensions

This package currently exposes these pi commands:

- `/review`
- `/specwriter`
- `/gh-faults`

It also exposes review prompt templates from `pi-prompts/` and shared skills from `skills/`.

## Pi package usage

This repository is a local pi package. It exposes:

- extensions from `pi-extensions/`
- skills from `skills/`
- prompt templates from `pi-prompts/`

Packaging note:

- keep `package.json` manifest entries directory-based (`./pi-extensions`, `./skills`, `./pi-prompts`), not glob-only
- this is important for local-package mode: directory entries reliably load nested extension entrypoints like `pi-extensions/review/index.ts`
- with glob-only manifest entries, pi may still show the package in `pi list` while commands such as `/review` are missing because the package resources were not actually registered
- after changing package resources, run `/reload`

Install it globally so commands like `/review`, `/specwriter`, and `/gh-faults` are available in every project:

```bash
pi install /home/ubuntu/src/agenttools
```

Then reload pi resources:

```text
/reload
```

## Review extension

The review extension also registers a shared `prepare_review` tool. `/review` uses the same core review-preparation logic as the tool.

Branch-scoped reviews accept any valid git ref (branch/tag/commit) for `base` and `head`. You can also pass a revision expression in `base` (for example `base..head`, `base...head`, or single-commit selectors like `abc123^!`) when using `/review` custom range mode or `prepare_review` branch scope.

Examples:

```text
# /review UI -> choose "Custom ref range"
HEAD^...HEAD
v1.2.0..main
abc1234...def5678
05dce7c^!

# tool form
prepare_review scope=branch base=HEAD^...HEAD
prepare_review scope=branch base=v1.2.0..main
prepare_review scope=branch base=05dce7c^!
```
