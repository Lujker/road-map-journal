# Run one roadctl queue from a user timer

The service runs the installed `~/.local/bin/roadctl serve --once`. Set up the machine's local conductor configuration and try that command manually against the intended service clone first. Inspect the board, the run ledger and the command's exit status. The service inherits the systemd user manager's environment, which can differ from your shell. Configure absolute executable paths in launch templates where needed.

## Check the installed command and the queue

Run these in the scheduling account. The installed launcher and the source checkout should report the same fingerprint after an update.

```sh
command -v roadctl
roadctl --version
node scripts/roadctl.mjs --version
roadctl help serve
```

Choose the dedicated service clone and the local launch profile in [the conductor configuration](../docs/roadctl.md#one-conductor-turn). `service.profile` names a local profile whose `agent` is the identity for `tick --as`. The service handles every board below that clone's `projects/`. For a trial on one queue, use a service clone containing only the trial board and give it a local test origin.

Set `ROADCTL_WORKSPACE` to that clone, `board` to its board directory, and `agent` to the configured profile's agent. Use the same account, registry and `XDG_CACHE_HOME` for the limits check and both schedulers. With the schedules stopped, inspect the proposed work:

```sh
roadctl doctor --board "$board" --as "$agent"
roadctl tick --board "$board" --as "$agent" --json --no-pull
```

An idle tick returns 4. A reserve or unknown limit returns 1 or 3. Inspect `roadctl limits --check "$agent" --json` for the reason. When the trial queue is ready, run `roadctl serve --once --json` once and inspect `roadctl runs --as "$agent" --json` in the same state directory. Verify the reported commit or marker in the trial origin before enabling a schedule.

## Install on Linux or WSL with systemd

From the repository root, using the same account that owns the service clone and configuration:

```sh
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$units"
install -m 644 conductor/systemd/roadctl-conductor.service conductor/systemd/roadctl-conductor.timer "$units/"
systemctl --user daemon-reload
systemctl --user enable --now roadctl-conductor.timer
systemctl --user list-timers --all roadctl-conductor.timer
journalctl --user -u roadctl-conductor.service
```

A busy or paused turn is a normal service exit. The first turn starts one minute after the timer starts. Later turns start five minutes after the previous service turn ends. To test one turn immediately, use `systemctl --user start roadctl-conductor.service`. For operation after logout, enable lingering for the service account with `loginctl enable-linger "$USER"` if appropriate. In WSL, the distribution must also be running. For example, a Windows logon task can keep a systemd-enabled distribution running by starting `wsl.exe -d Ubuntu-22.04 --exec sleep infinity` with the user's Windows account.

## Switch between the timer and an application routine

Match the board origin and project plus the resolved orchestrator identity across both sources. Inspect the timer with `systemctl --user list-timers --all roadctl-conductor.timer` and list the bot’s native triggers with `trigger_info`. An active timer and an enabled trigger for that pair mean both can schedule work. Choose the source and disable the other before the trial. Before switching away from the timer, run:

```sh
systemctl --user disable --now roadctl-conductor.timer
systemctl --user is-active roadctl-conductor.timer
systemctl --user is-active roadctl-conductor.service
```

Wait for an active service turn to finish. Both units should then report `inactive`. Check the run ledger and board for an unfinished claim before scheduling the same board and profile in the application.

In OpenMausBot, select the registered bot profile and create a one-shot scheduled trigger for the isolated queue. Specify the board path, profile, cache directory and exact command in the routine instructions. Read back the trigger ID and its scheduled time. Verify the resulting scheduled run ID, board changes and ledger. To switch back, pause the trigger, verify `enabled=false` and `nextRunAt=null`, and wait for any in-flight run to finish before enabling the systemd timer. Other schedulers, including Hermes, follow the same handover.

## Check the local executor

Use the installed executable’s absolute path in the launch template. The supervisor sends the prompt on stdin and closes it. The following arguments select one non-interactive turn. Select the approved model and timeout in the local profile.

| Executor | Command accepting a prompt on stdin | Result to inspect |
|---|---|---|
| Codex | `codex exec -` | Last message and exit status. Use `-o FILE` when the caller needs a copy. |
| DSH | `dsh headless -` | Final reply on stdout and diagnostics on stderr. Select the intended model in the DSH profile. |
| pi | `pi -p` | Final reply on stdout after EOF. Select the intended provider and model explicitly. |

Start with `codex exec --help`, `dsh headless --help` or `pi --help` to verify the installed command. For a full trial use one approved test item and inspect its claim, result and Git revision. A model reply alone does not establish that another clone received the report.

## Set up a one-shot with an agent

Give the setup agent the trial board path, the registered orchestrator identity, the absolute command to run and a unique trigger name. Ask it to list triggers, check for that name, and create one future `once` trigger with `overlap=skip` and a timeout. In OpenMausBot the setup conversation can be started with `openmausbot run BOT --task new --message-file FILE --wait job --strict`. Put the approved queue command in the scheduled task. The setup conversation returns the trigger ID. Check its separate scheduled run, then verify the result commit from another clone of the trial origin. The scheduler and the worker must both be able to read any files named in the task.

If the queue is waiting, check these with the same registry and state directory as the scheduler:

```sh
roadctl tick --ledger --as "$agent" -n 10
roadctl tasks --for "$agent"
roadctl runs --open --as "$agent" --json
```

The trigger's final state, scheduler ledger and board report answer different questions. Verify the expected card, commit and output before moving on. If a reviewer runs in a different filesystem, hand over the exact SHA and a Git bundle or a reachable clone.

## Uninstall

After disabling the timer and waiting for the service turn to finish, remove the two installed files and reload the manager:

```sh
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
rm -- "$units/roadctl-conductor.timer" "$units/roadctl-conductor.service"
systemctl --user daemon-reload
```
