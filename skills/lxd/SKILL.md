---
name: lxd
description: "Workflows for LXD containers and VMs: launch Ubuntu instances, mount host directories and storage volumes, and define reusable profiles and networks."
compatibility: Linux host with LXD/LXC CLI access (tested on LXD 5.x+).
---

# LXD skill

Use this skill for LXD/LXC tasks.

## Defaults and guardrails

- Default image for both containers and VMs: `ubuntu:26.04`.
- Prefer containers unless the user explicitly asks for a VM, or needs virtualized devices (for example, storage devices).
- Prefer reusable profiles and managed storage volumes over one-off instance tweaks.
- Do not delete or reconfigure existing instances, networks, or profiles unless asked.
- Avoid `security.privileged`, `security.nesting`, and `raw.lxc` unless explicitly required.

## Preflight

```bash
lxc info >/dev/null
lxc remote list --format=table
lxc image info ubuntu:26.04
```

## Topics

- Instance bring-up and readiness: [references/instances.md](references/instances.md)
- Host mounts and managed volumes: [references/storage-and-mounts.md](references/storage-and-mounts.md)
- Profiles and networks: [references/profiles-and-networks.md](references/profiles-and-networks.md)
- Troubleshooting hanging commands: [references/troubleshooting.md](references/troubleshooting.md)

## Execution style

- Prefer `init` → `config` → `start` for repeatable provisioning.
- Use idempotent checks (`show/list` before `create`) in scripts/automation.
- `lxc profile create <name>` can hang waiting for stdin; if you are not piping profile YAML/content into it, redirect stdin from `/dev/null` (for example, `lxc profile create <name> </dev/null`).
- Important: in non-interactive shells, CI, or SSH/Testflinger-style runners, `lxc init`, `lxc launch`, and `lxc storage volume create` can also inherit stdin and block waiting for EOF; if you are not intentionally feeding them input, redirect stdin from `/dev/null`. Also see troubleshooting hanging commands.
- Validate after changes (`lxc list`, `lxc info <instance>`, guest-level checks).
- Summarize assumptions and non-default settings clearly.


## Validate the documented commands

From the skill directory, run:

```bash
./tests/smoke.sh
```

Useful options:

```bash
./tests/smoke.sh --require-vm   # fail if VM tests cannot run
./tests/smoke.sh --keep         # keep test resources for debugging
```
