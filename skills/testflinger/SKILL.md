---
name: testflinger
description: Reserve freshly deployed physical lab machines through Testflinger, wait for deployment, connect over SSH as ubuntu, and cancel reservations early when finished. Use when you need temporary beefy physical servers for running tests.
compatibility: Linux host with VPN access to the lab, SSH, and either cephtools or testflinger-cli/testflinger installed.
---

# Testflinger skill

Use this skill for Testflinger lab reservations and follow-up access.

Keep context lean: load only the topic file needed for the request.

## Defaults and guardrails

- Use `cephtools testflinger reserve` to reserve and deploy a machine.
- Check VPN reachability before reserving or connecting: `ping -c 1 -W 1 10.172.192.1`.
- If the VPN check fails, stop and tell the user the lab is unreachable until VPN access is restored.
- Physical deployments are slow. Reservation and provisioning can take up to 20 minutes; do not treat a long wait as failure by itself.
- Default OS is Ubuntu 24.04 unless the user explicitly requests something else.
- Reservations produce fresh machines. It is fine to install tools, clone repos, and make disposable changes on the host.
- SSH user is `ubuntu`; passwordless sudo is available.
- Keep the final reservation details: queue name, job id, expiration time, SSH command, and cancel command.
- If work finishes early, cancel the reservation to release the lab machine with `testflinger cancel <job-id>`.

## Preflight

```bash
ping -c 1 -W 1 10.172.192.1
command -v cephtools || command -v testflinger || command -v testflinger-cli
ssh -V
```

If `cephtools` is unavailable but `testflinger` is present, use the raw CLI workflow in the references.

## Load only the relevant topic

- Reserve a machine and connect: [references/reserve-and-connect.md](references/reserve-and-connect.md)
- Bootstrap and work on the reserved host: [references/bootstrap.md](references/bootstrap.md)
- Troubleshooting and reservation management: [references/troubleshooting.md](references/troubleshooting.md)

## Execution style

- Use generous command timeouts for reservation commands.
- Prefer foreground execution so the full reservation output is captured.
- Parse and preserve the printed SSH and cancel commands exactly when available.
- After login, verify basic state with guest checks such as `hostnamectl`, `lsb_release -a`, and `sudo -n true`.
- Summarize the reservation outcome clearly, including any tools installed on the host.

## Validate the documented commands

From the skill directory, run:

```bash
./tests/smoke.sh
```

For a live end-to-end reservation test, use:

```bash
./tests/smoke.sh --live --queue <queue-name>
```
