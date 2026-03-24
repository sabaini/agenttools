---
name: snapcraft
description: Build, troubleshoot, and author snaps with Snapcraft. Use when working on snapcraft.yaml, managed build containers, `snapcraft -v pack`, `snapcraft clean`, Go-based snaps such as MicroCeph, confinement modes, plugs and slots, or debugging packaging/runtime sandbox failures.
---

# Snapcraft skill

Use this skill for Snapcraft packaging work.

Keep context lean: load only the topic file needed for the request.

## Defaults and guardrails

- Prefer explicit subcommands such as `snapcraft -v pack`; do not rely on bare `snapcraft`.
- Prefer a real Snapcraft build over ad-hoc `unsquashfs`/`mksquashfs` repacks. Repacking an old snap is a diagnostic trick, not a trustworthy release artifact.
- Treat `override-*` guards in `snapcraft.yaml` as part of the build contract. If a project blocks dirty trees, surface that clearly before bypassing it.
- Distinguish packaging failures from application failures. A compile error inside `override-build` is usually app code, not Snapcraft itself.
- After changing packages, organize rules, or `prime`, inspect the staged/primed payload before assuming runtime issues are confinement-related.
- For local iteration, use `snap install --dangerous <snap>` and reconnect any non-auto-connected interfaces explicitly.

## Quick workflow

1. Inspect `snap/snapcraft.yaml` or project-root `snapcraft.yaml`.
2. Decide whether to run in a managed environment (`snapcraft -v pack`, optionally `--use-lxd`) or on-host (`--destructive-mode`).
3. If the build fails, rerun with `--debug`, `--shell`, or `--shell-after`.
4. If state looks stale, use `snapcraft clean <part>` or `snapcraft clean` and retry.
5. If the snap builds but fails at runtime, inspect packaged files first, then debug confinement and interface connections.

## Load only the relevant topic

- Build mechanics, managed environments, `pack`, and `clean`: [references/builds-and-troubleshooting.md](references/builds-and-troubleshooting.md)
- Writing `snapcraft.yaml` for Go snaps, especially MicroCeph-style manual builds: [references/go-and-microceph.md](references/go-and-microceph.md)
- Confinement, plugs/slots, and runtime denial debugging: [references/confinement-and-interfaces.md](references/confinement-and-interfaces.md)

## MicroCeph anchor example

Use `/home/ubuntu/src/microceph/snap/snapcraft.yaml` as a concrete example of:

- `plugin: nil` with manual `go build`
- multi-part assembly with `ceph`, `dqlite`, and `microceph`
- `build` vs `stage` vs `prime`
- strict confinement with many interfaces
- dirty-worktree reproducibility checks in `override-build`

## Preflight

```bash
snapcraft --version
snapcraft help pack
snapcraft help clean
```

For a real project build:

```bash
cd /path/to/project
snapcraft -v pack
```
