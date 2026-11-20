# Events by webhook (P5.41 slice 4: design only)

Status: **design, no code** (criterion a8). The slice is optional. Polling stays the base; this adds a wake-up for events that happen where nobody is polling.

## What problem it solves

An orchestrator (a chat bot, a scheduler, a coordinator agent) learns about the board by polling: a routine that runs `roadctl tick --json` and `roadctl inbox --json` on a schedule. That is cheap and enough while the work happens inside the orchestrator's own channel. It is slow or blind for events outside it: a routine that failed on another machine, an agent working without a channel, a `report` handed in while the coordinator sleeps, a HOLD.

With a webhook, `roadctl` sends one short message when such an event happens, the orchestrator wakes, reads the board with its normal commands and acts. The message is a **wake-up, not data**.

```text
event on a machine  ->  roadctl writes it locally (report, ask, HOLD, a failed routine)
                    ->  one short POST to the URL set on that machine
orchestrator        ->  a routine with a webhook trigger wakes (its own URL is the target)
                    ->  roadctl pull; roadctl tick --json; roadctl inbox --json; acts as it always does
```

## Events

| event | when | `line` (fixed words and ids, never card or agent text) |
| --- | --- | --- |
| `report` | `report` published a result | `report H-1 by AGENT` |
| `ask` | `ask` wrote a blocking question, or a decision that can be undone | `question H-1 q2` |
| `hold` | a routine went on HOLD (P5.4) | `hold ROUTINE after 3 failed runs` |
| `routine-failed` | a routine run ended failed, aborted, timed out or crashed without a HOLD yet | `failed ROUTINE timeout` |

More events can be added later; a receiver must ignore an event name it does not know.

## Message

One HTTP POST, `Content-Type: application/json`, at most 512 bytes:

```json
{ "v": 1, "event": "report", "board": "my-app", "card": "H-1", "routine": null, "agent": "pi-developer", "line": "report H-1 by pi-developer", "at": "2026-11-20T12:00:00Z", "host": "home-wsl" }
```

- `board` is the project name, `card` the id (or `routine` the routine id), `agent` the name already in the board's Log, `host` the machine name.
- `line` is built by `roadctl` from the event and ids. It never carries the text of a card, a Log line, a question, an answer, a summary or an error message.
- No path, no URL, no token, no provider message, nothing from the environment.

## Where the URL lives

The URL is local to the machine, **never in git, never on a board, never in a Log, a report or a command output**. Many webhook URLs are the secret themselves.

- `ROADCTL_EVENTS_URL`, or the file `${XDG_CONFIG_HOME:-~/.config}/road-map-journal/events.json` (mode 0600):

  ```json
  { "url": "https://hooks.example.com/roadctl/abc", "events": ["report", "ask", "hold", "routine-failed"], "timeout_ms": 3000, "hmac_env": "ROADCTL_EVENTS_KEY" }
  ```

- `https` only; `http` is accepted only for `localhost`. A URL with credentials in the user part is refused.
- Optional `hmac_env` names an environment variable with a key; `roadctl` then adds `X-Roadctl-Signature: sha256=<hmac of the body>`. The key is never stored in the file.
- A later command `roadctl events set|status|test` writes and checks that file; `status` prints the host name of the URL, not the URL.
- Without the setting nothing is sent and nothing changes: a machine that does not set a URL behaves as today.

## Delivery rules (failure breaks nothing)

- Sent **after** the local write succeeded, in a detached step with a short timeout (default 3 s); the command's output and exit code are the same with and without a webhook.
- One attempt. No retry loop, no queue that grows. A failed attempt writes one bounded line into the local state directory (`events.log`, last 50 lines) and `roadctl doctor` shows the last failure.
- Folding: the same event for the same target inside 60 s is one message; at most 20 messages per hour per machine, the rest are counted in `events.log`.
- A receiver that is down, slow or answers with an error changes nothing on the board. The scheduled poll stays the fallback and finds everything the webhook missed.
- Receiver contract: idempotent, duplicates are harmless, a lost message is harmless, the message is never trusted as the source of truth; the receiver reads the board.

## Example with an orchestrator routine

For an orchestrator that can run a routine from a webhook (the owner's OpenBot is the first case; check its trigger settings when this slice is built):

1. In the orchestrator create a routine with a **webhook trigger**; the platform gives that routine a URL.
2. On each machine that should report events set that URL as `ROADCTL_EVENTS_URL` (or `events.json`).
3. The routine prompt is the same as the scheduled one: run `roadctl pull`, `roadctl tick --json --as <name>` and `roadctl inbox --json`, act on the items under the standing rules (questions and approvals go to the owner in the chat by the owner's own words; nothing is approved by the routine).
4. Keep the scheduled routine at a low frequency as the fallback (for example hourly) so a lost message costs at most that interval.

Inside the orchestrator's own channel this is not needed: the orchestrator already hears about results there. The webhook is for events outside it.

## What changes in roadctl (when built)

- A module `events` with a `report-after`, `routine-done-after` and `ask` observer (the hooks of the seam in [developing-roadctl.md](developing-roadctl.md)); no change of the board format, **no `requires` raise, no VERSION change by itself**.
- `roadctl events set|status|test`; docs and a test with a local receiver (a socket in the test, no network).
- Acceptance for that slice: a test that the message has no text of a card; a test that a dead receiver does not change an exit code or output; a test that the URL never appears in output, Log or git.

## Open questions for the owner

- Does the orchestrator's webhook trigger accept a plain JSON POST with a signature header, or does it need its own format? To check against the product's settings; the core stays product-neutral.
- Which events are worth waking for at all (a `report` of every card may be too many at night)? Quiet hours can be the receiver's rule.
