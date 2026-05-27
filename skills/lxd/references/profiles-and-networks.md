# Profiles and networks

## Profiles: compose small, reusable units

If you are not piping profile YAML/content into `lxc profile create`, redirect stdin from `/dev/null`; otherwise the command can hang waiting for stdin.

Likewise, in scripts/CI/remote runners, prefer `lxc launch ... </dev/null` so launch does not inherit the runner stdin and block waiting for EOF. A common symptom is a stuck `lxc launch` process even though `lxc list` still shows no new instance. See also [Troubleshooting](troubleshooting.md).

Compute profile:

```bash
lxc profile show compute-small >/dev/null 2>&1 || lxc profile create compute-small </dev/null
lxc profile set compute-small limits.cpu 2
lxc profile set compute-small limits.memory 4GiB
```

Shared mount profile:

```bash
lxc profile show mount-projects >/dev/null 2>&1 || lxc profile create mount-projects </dev/null
lxc profile device list mount-projects | grep -qx projects || \
  lxc profile device add mount-projects projects disk source=/srv/projects path=/mnt/projects readonly=true
```

Apply at launch time:

```bash
lxc launch ubuntu:26.04 c-dev --profile default --profile compute-small --profile mount-projects </dev/null
lxc launch ubuntu:26.04 vm-dev --vm --profile default --profile compute-small </dev/null
```

Apply to existing instances:

```bash
lxc profile assign c-dev default,compute-small,mount-projects
```

## Networks: managed bridge + profile

```bash
lxc network show br-dev >/dev/null 2>&1 || lxc network create br-dev ipv4.address=10.77.0.1/24 ipv4.nat=true ipv6.address=none
lxc profile show net-br-dev >/dev/null 2>&1 || lxc profile create net-br-dev </dev/null
lxc profile device list net-br-dev | grep -qx eth0 || \
  lxc profile device add net-br-dev eth0 nic network=br-dev name=eth0
```

Launch using network profile (after `default` so profile order overrides `eth0`):

```bash
lxc launch ubuntu:26.04 c-net --profile default --profile net-br-dev </dev/null
lxc launch ubuntu:26.04 vm-net --vm --profile default --profile net-br-dev </dev/null
```

Optional static IP override per instance:

```bash
lxc config device override c-net eth0 ipv4.address=10.77.0.10
```

## Scripting tip

Prefer JSON parsing over `grep|cut` when extracting network values:

```bash
lxc network list --format=json | jq -r '.[] | select(.name=="br-dev") | .config["ipv4.address"]'
```
