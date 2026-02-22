# Advanced labs (privileged/device-heavy)

Use this only when the user explicitly needs loop/block device access inside containers (for example, storage integration tests).

This reduces isolation and should not be the default for app workloads.

## Example pattern

```bash
lxc init ubuntu:24.04 c-osd-test --profile default
lxc config set c-osd-test security.privileged true
lxc config set c-osd-test security.nesting true
printf 'lxc.cgroup2.devices.allow = b 7:* rwm\nlxc.cgroup2.devices.allow = c 10:237 rwm' | lxc config set c-osd-test raw.lxc -
lxc start c-osd-test
```

## Additional cautions

- Prefer VMs over privileged containers if isolation matters.
- Keep this setup scoped to disposable test environments.
- Document exactly why privileged/raw settings were required.
