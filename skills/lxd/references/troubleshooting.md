# Troubleshooting

## stdin inheritance in automation

When `lxc` create commands run under CI, SSH, Testflinger, or other non-interactive runners, they can inherit an open stdin pipe and block waiting for EOF before creation actually starts.

Why this matters: the failure mode is confusing — a command can look hung while `lxc list`/`lxc info` still show no new instance, or `lxc storage volume show` still shows no new volume, because creation has not started yet.

Commonly affected commands:

- `lxc init`
- `lxc launch`
- `lxc storage volume create`
- `lxc profile create` when you are **not** intentionally piping profile content into it

Common symptoms:

- the command looks hung
- `lxc list` / `lxc info <name>` still show no new instance
- `lxc storage volume show <pool> <name>` still shows no new volume

Safe default for automation:

```bash
lxc init ubuntu:26.04 c-job --profile default </dev/null
lxc launch ubuntu:26.04 vm-job --vm --profile default </dev/null
lxc storage volume create default data1 size=8GiB </dev/null
lxc profile create compute-small </dev/null
```

Exception: if you are intentionally passing content on stdin, do not redirect it away.
