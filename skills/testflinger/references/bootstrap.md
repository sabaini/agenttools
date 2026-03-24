# Bootstrap and work on the reserved host

Testflinger machines are freshly deployed for each reservation. Treat them as disposable hosts.

## Basic guest bootstrap

Once connected as `ubuntu`, passwordless sudo is available:

```bash
sudo -n true
sudo apt-get update
```

Install whatever is needed for the task. Common examples:

```bash
sudo apt-get install -y git curl jq build-essential
```

## Move code onto the host

Common patterns:

```bash
# clone directly on the host
ssh ubuntu@<ip> 'git clone <repo-url> ~/workdir'

# copy local artifacts
scp ./artifact ubuntu@<ip>:~/

# run a remote command
ssh ubuntu@<ip> 'cd ~/workdir && ./run-tests.sh'
```

If host key prompts are noisy in ephemeral lab environments, use the same SSH options printed by the reservation output:

```bash
-o 'StrictHostKeyChecking=no' -o 'UserKnownHostsFile=/dev/null'
```

## Suggested first checks

```bash
nproc
free -h
df -h
ip -brief addr
uname -a
```

## Cleanup expectations

Do not spend time cleaning up the machine itself unless the user asks. The host is reimaged and torn down automatically when the reservation ends.

The meaningful cleanup action is releasing the reservation early if the work is finished.
