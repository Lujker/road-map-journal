// Fake external executors for tests: claude, codex, ssh, hermes (and wsl.exe, the transport of the Windows examples).
// Not shipped (the installer copies only scripts/roadctl/). Installed as small wrapper scripts by fakes.mjs, which also reads the log.
//
// Every call appends one JSON line to $FAKE_LOG before doing anything else:
//   { name, argv, cwd, pid, mode, env: { FAKE_*, ROADCTL_*, XDG_* and the keys of FAKE_ENV_KEYS }, stdin }
// stdin is the text received (read to the end), unless FAKE_STDIN=skip, the terminal is stdin, or the call is the interactive codex app-server
// (there every JSON-RPC line goes to the log as its own { name, event: 'rpc', line } entry).
//
// Mode (what the call does after logging): FAKE_<NAME>_MODE (FAKE_CLAUDE_MODE, FAKE_WSL_EXE_MODE, ...), else FAKE_MODE, else "ok".
//   ok      succeed. claude with stream-json prints a limits probe answer (FAKE_U5, FAKE_U7 are 0-1 fractions, FAKE_RESET an epoch), codex app-server
//           answers the rate-limits JSON-RPC (FAKE_5H, FAKE_7D percents), any other call prints FAKE_STDOUT (claude: "ok") and exits 0.
//           FAKE_AFTER: a shell command run after a normal (not a probe) ok call, standing for what the agent did; its exit status becomes ours.
//   hang    never answer (logs first; a timeout or a kill ends it; FAKE_HANG_MS ends it by itself)
//   crash   print "fake <name>: crashed" on stderr and exit FAKE_EXIT (default 70), or die of FAKE_SIGNAL
//   silent  exit 0 without printing anything (also for a probe)
//   huge    print FAKE_HUGE_BYTES (default 8 MiB) of text, then exit 0
//   run     ssh and wsl.exe only: run the remote command locally through `sh -c` (ssh HOST cmd...  /  wsl.exe -e bash -lc CMD), as the real transport would
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const [name, ...argv] = process.argv.slice(2);
const key = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const E = process.env;
const mode = E[`FAKE_${key}_MODE`] || E.FAKE_MODE || 'ok';
const append = (o) => {
  if (E.FAKE_LOG) fs.appendFileSync(E.FAKE_LOG, `${JSON.stringify(o)}\n`);
};
const keep = new Set((E.FAKE_ENV_KEYS || '').split(',').filter(Boolean));
const env = Object.fromEntries(Object.entries(E).filter(([k]) => /^(FAKE_|ROADCTL_|XDG_)/.test(k) || keep.has(k)));
const probe = (name === 'claude' && argv.includes('stream-json')) || (name === 'codex' && argv[0] === 'app-server');

let stdin = null;
if (E.FAKE_STDIN !== 'skip' && !(name === 'codex' && probe) && !process.stdin.isTTY) {
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch {
    stdin = null;
  }
}
append({ name, argv, cwd: process.cwd(), pid: process.pid, mode, env, stdin });

const write = (s) => fs.writeSync(1, s);
if (mode === 'hang') {
  setTimeout(() => process.exit(0), Number(E.FAKE_HANG_MS || 0) || 2 ** 31 - 1);
} else if (mode === 'crash') {
  process.stderr.write(`fake ${name}: crashed\n`);
  if (E.FAKE_SIGNAL) process.kill(process.pid, E.FAKE_SIGNAL);
  else process.exit(Number(E.FAKE_EXIT || 70));
} else if (mode === 'silent') {
  process.exit(0);
} else if (mode === 'huge') {
  const chunk = `${'x'.repeat(1023)}\n`;
  for (let n = Number(E.FAKE_HUGE_BYTES || 8 * 1024 * 1024); n > 0; n -= chunk.length) write(chunk);
} else if (mode === 'run' && (name === 'ssh' || name === 'wsl.exe')) {
  const command = name === 'ssh' ? argv.slice(1).join(' ') : argv[argv.length - 1];
  process.exit(spawnSync('sh', ['-c', command], { stdio: 'inherit' }).status ?? 1);
} else if (name === 'claude' && probe) {
  const reset = Number(E.FAKE_RESET || 4102444800);
  const out = (o) => write(`${JSON.stringify(o)}\n`);
  out({ type: 'system', subtype: 'init', model: 'fake' });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: Number(E.FAKE_U5 ?? 0.1), resetsAt: reset }, seven_day: { utilization: Number(E.FAKE_U7 ?? 0.2), resetsAt: reset + 86400 } } } });
  out({ type: 'result', subtype: 'success' });
} else if (name === 'codex' && probe) {
  const send = (o) => write(`${JSON.stringify(o)}\n`);
  let buffer = '';
  process.stdin.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      append({ name, event: 'rpc', line });
      const m = JSON.parse(line);
      if (m.id === 1) send({ jsonrpc: '2.0', id: 1, result: { userAgent: 'fake' } });
      if (m.id === 2) {
        const reset = Number(E.FAKE_RESET || 4102444800);
        send({ jsonrpc: '2.0', id: 2, result: { rateLimits: { primary: { usedPercent: Number(E.FAKE_5H ?? 10), windowDurationMins: 300, resetsAt: reset }, secondary: { usedPercent: Number(E.FAKE_7D ?? 20), windowDurationMins: 10080, resetsAt: reset + 86400 } } } });
      }
    }
  });
} else {
  const text = E.FAKE_STDOUT ?? (name === 'claude' ? 'ok\n' : '');
  if (text) write(text);
  if (E.FAKE_AFTER) process.exit(spawnSync('sh', ['-c', E.FAKE_AFTER], { stdio: 'inherit' }).status ?? 1);
}
