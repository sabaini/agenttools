# Reserve and connect

## Preflight

Check that the lab network is reachable over VPN before doing anything else:

```bash
ping -c 1 -W 1 10.172.192.1
```

Check which client commands are available:

```bash
command -v cephtools || true
command -v testflinger || command -v testflinger-cli
```


## Preferred reservation path: cephtools wrapper

Reserve a machine:

```bash
cephtools testflinger reserve
```

Optional flags:

```bash
cephtools testflinger reserve <queue-name> \
  --reserve-for 21600
```

queue-name defaults to the ceph-qa-1 queue -- use this queue unless specifically told otherwise.
Each machine has a queue with the same name, so it's also possible to request specific machines via this mechanism.

Useful wrapper variants:

```bash
cephtools testflinger reserve --help
cephtools testflinger deploy <queue-name>
```

Use `deploy` when the user specifically wants a machine with `cephtools` and `testenv` installed automatically.

## Raw CLI fallback

If `cephtools` is unavailable, reserve directly with Testflinger:

```bash
testflinger reserve --queue <queue-name>
```

The default deployment is Ubuntu 26.04. Only pass an explicit image if the user requests a different OS and you know the correct image identifier for that lab.

You can also provide SSH keys explicitly:

```bash
testflinger reserve --queue <queue-name> --key lp:<launchpad-id>
```

## Expected success shape

Successful wrapper output looks like this:

```text
Submitted job b294fa28-4b99-438d-8795-6b075fae6cee to reserve ceph-qa-1. Waiting for details.
...
Reserved queue ceph-qa-1 under job b294fa28-4b99-438d-8795-6b075fae6cee. Reservation expires at 2026-03-24T03:33:53.453887+00:00.
Connect with: ssh -o 'StrictHostKeyChecking=no' -o 'UserKnownHostsFile=/dev/null' 'ubuntu@10.241.4.23'
Cancel early with: testflinger cancel b294fa28-4b99-438d-8795-6b075fae6cee
```

Capture these fields:

- queue name
- job id
- expiration timestamp
- SSH command
- cancel command

Be patient while waiting for this output. Provisioning can take up to 20 minutes.

## Connect and verify

Prefer the printed SSH command exactly as provided. A typical connection looks like:

```bash
ssh -o 'StrictHostKeyChecking=no' -o 'UserKnownHostsFile=/dev/null' 'ubuntu@10.241.4.23'
```

After connecting, verify the host quickly:

```bash
hostnamectl
lsb_release -a || cat /etc/os-release
sudo -n true
```

If you need to run one-off commands without an interactive shell:

```bash
ssh -o 'StrictHostKeyChecking=no' -o 'UserKnownHostsFile=/dev/null' ubuntu@<ip> 'hostname && sudo -n true'
```

## What to report back

Summarize:

- whether reservation succeeded
- queue name and job id
- expiration time
- SSH target/IP
- any immediate post-boot validation results
