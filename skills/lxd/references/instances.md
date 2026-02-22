# Instances (containers and VMs)

## Preferred lifecycle pattern

Use explicit provisioning for reproducibility:

```bash
lxc init ubuntu:24.04 c-<name> --profile default
lxc config set c-<name> limits.cpu 2
lxc config set c-<name> limits.memory 4GiB
lxc start c-<name>
```

VM variant:

```bash
lxc init ubuntu:24.04 vm-<name> --vm --profile default
lxc config set vm-<name> limits.cpu 4
lxc config set vm-<name> limits.memory 8GiB
lxc config device override vm-<name> root size=40GiB
lxc start vm-<name>
```

## Quick launch variant

For simple one-offs:

```bash
lxc launch ubuntu:24.04 c-quick --profile default
lxc launch ubuntu:24.04 vm-quick --vm --profile default
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

Quote carefully when passing variables through `sh -c`.
