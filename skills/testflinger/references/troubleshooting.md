# Troubleshooting and reservation management

## VPN unreachable

If this fails, stop and tell the user the lab is currently unreachable from this environment:

```bash
ping -c 1 -W 1 10.172.192.1
```

## Slow reservations

Provisioning a physical machine can take up to 20 minutes. A long wait alone is not a failure.

If you already have a job id and want more detail, use:

```bash
testflinger status <job-id>
testflinger poll <job-id>
testflinger poll --oneshot <job-id>
testflinger show <job-id>
```

`testflinger poll` can also target a specific phase:

```bash
testflinger poll --phase reserve <job-id>
```

## SSH connection problems

Re-check VPN first, then retry the printed SSH command.

Useful one-off diagnostics:

```bash
ssh -o 'StrictHostKeyChecking=no' -o 'UserKnownHostsFile=/dev/null' ubuntu@<ip> 'hostname'
ping -c 1 <ip>
```

## Releasing the machine early

When finished, cancel the reservation:

```bash
testflinger cancel <job-id>
```

If the wrapper printed a cancel command, prefer using that exact command.

## Useful facts to preserve in notes

Keep these details in your final summary so the user can continue from there if needed:

- queue name
- job id
- expiration time
- SSH command or IP
- whether the machine was reachable over SSH
- any tools you installed
