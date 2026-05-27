# Instances (containers and VMs)

## Preferred lifecycle pattern

Use explicit provisioning for reproducibility.

Containers:

```bash
lxc init ubuntu:26.04 c-<name> --profile default </dev/null
lxc config set c-<name> limits.cpu 2
lxc config set c-<name> limits.memory 4GiB
lxc start c-<name>
```

VM variant:

```bash
lxc init ubuntu:26.04 vm-<name> --vm --profile default </dev/null
lxc config set vm-<name> limits.cpu 4
lxc config set vm-<name> limits.memory 8GiB
lxc config device override vm-<name> root size=40GiB
lxc start vm-<name>
```

## Quick launch variant

For simple one-offs:

```bash
lxc launch ubuntu:26.04 c-quick --profile default
lxc launch ubuntu:26.04 vm-quick --vm --profile default
```

In scripts, CI, or remote runners, prefer detaching `lxc launch` from the parent stdin so it cannot hang waiting for EOF. See also [Troubleshooting](troubleshooting.md).

Why this matters: the failure mode is confusing — `lxc init`/`lxc launch` can stay running while blocked on inherited stdin, but `lxc list` and `lxc info <name>` may still show no instance because LXD has not started creating it yet.

```bash
lxc launch ubuntu:26.04 c-quick --profile default </dev/null
lxc launch ubuntu:26.04 vm-quick --vm --profile default </dev/null
```

## Readiness checks

```bash
lxc list
lxc exec c-<name> -- cloud-init status --wait
```

For VMs, wait for the guest agent to come up first (avoids transient `LXD VM agent isn't currently running`):

```bash
for i in $(seq 1 60); do
  lxc exec vm-<name> -- true >/dev/null 2>&1 && break
  sleep 5
done
lxc exec vm-<name> -- cloud-init status --wait
```

CI/lab retry loop pattern (from MicroCeph-style automation):

```bash
for i in $(seq 1 60); do
  lxc exec vm-<name> -- hostname >/dev/null 2>&1 && break
  sleep 5
done
```

## Command execution in guests

```bash
lxc exec c-<name> -- sh -c "<command>"
lxc exec vm-<name> -- sh -c "<command>"
```

Quote carefully when passing variables through `sh -c`. To avoid quoting issues transfer scripts and exec:

```bash
lxc file push ./script.sh c-dev/mnt
lxc exec vm-<name> -- sh /mnt/script.sh
```
