# Run one roadctl queue from a user timer

The service runs the installed `~/.local/bin/roadctl serve --once`. Set up the machine's local conductor configuration and try that command manually against the intended service clone first. Inspect the board, the run ledger and the command's exit status. The service inherits the systemd user manager's environment, which can differ from your shell. Configure absolute executable paths in launch templates where needed.

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

Use one schedule for a given board and orchestrator profile. Before switching away from the timer, run:

```sh
systemctl --user disable --now roadctl-conductor.timer
systemctl --user is-active roadctl-conductor.timer
systemctl --user is-active roadctl-conductor.service
```

Wait for an active service turn to finish. Both units should then report `inactive`. Check the run ledger and board for an unfinished claim before scheduling the same board and profile in the application.

In OpenMausBot, select the registered bot profile and create a one-shot scheduled trigger for the isolated queue. Specify the board path, profile, cache directory and exact command in the routine instructions. Read back the trigger ID and its scheduled time. Verify the resulting scheduled run ID, board changes and ledger. To switch back, pause the trigger, verify `enabled=false` and `nextRunAt=null`, and wait for any in-flight run to finish before enabling the systemd timer. Other schedulers, including Hermes, follow the same handover.

## Uninstall

After disabling the timer and waiting for the service turn to finish, remove the two installed files and reload the manager:

```sh
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
rm -- "$units/roadctl-conductor.timer" "$units/roadctl-conductor.service"
systemctl --user daemon-reload
```
