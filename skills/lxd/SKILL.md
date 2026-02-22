---
name: lxd
description: "Workflows for LXD containers and VMs: launch Ubuntu instances, mount host directories and storage volumes, and define reusable profiles and networks."
compatibility: Linux host with LXD/LXC CLI access (tested on LXD 5.x+).
---

# LXD skill

Use this skill for LXD/LXC tasks.

Keep context lean: load only the topic file needed for the user request.

## Defaults and guardrails

- Default image for both containers and VMs: `ubuntu:24.04`.
- Prefer containers unless the user explicitly asks for a VM, or needs virtualized devices (for example, storage devices).
- Prefer reusable profiles and managed storage volumes over one-off instance tweaks.
- For host-path mounts, default to `readonly=true` unless write access is requested.
- Do not delete or reconfigure existing instances, networks, or profiles unless asked.
- Avoid `security.privileged`, `security.nesting`, and `raw.lxc` unless explicitly required.

## Preflight

```bash
lxc info >/dev/null
lxc remote list --format=table
lxc image info ubuntu:24.04
```

If `ubuntu:24.04` is unavailable, try `ubuntu:noble` and then `ubuntu:lts`, and report what was used.

## Load only the relevant topic

- Instance bring-up and readiness: [references/instances.md](references/instances.md)
- Host mounts and managed volumes: [references/storage-and-mounts.md](references/storage-and-mounts.md)
- Profiles and networks: [references/profiles-and-networks.md](references/profiles-and-networks.md)
- Device-heavy privileged test labs (high risk): [references/advanced-labs.md](references/advanced-labs.md)

## Execution style

- Prefer `init` → `config` → `start` for repeatable provisioning.
- Use idempotent checks (`show/list` before `create`) in scripts/automation.
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
