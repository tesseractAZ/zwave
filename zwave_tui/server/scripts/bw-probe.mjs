/**
 * Per-session bandwidth of the telnet TUI — time-windowed, no heuristics.
 *
 * Usage: node scripts/bw-probe.mjs <host> <port> <cols> <rows> <warm-s> <meas-s>
 *   e.g. node scripts/bw-probe.mjs 192.168.1.10 2324 200 60 10 60
 *
 * Negotiates the terminal size over telnet NAWS (without it the server assumes
 * a default and the number describes the wrong screen), discards a fixed
 * warm-up window, then measures a fixed window and prints the per-second series
 * alongside the summary.
 *
 * WHY NO QUIET-DETECTION. The obvious design splits "opening paint" from
 * "steady state" by waiting for the line to fall silent. It never falls silent:
 * the TUI redraws the whole frame on a 1 Hz timer (telnet/server.ts:419), so
 * every window carries traffic. A probe built that way returns 0 for every
 * steady-state field — which is almost certainly how PERFORMANCE.md came to
 * publish "0 KB/s at 80x24", a heuristic that never fired reported as a
 * measured absence.
 *
 * So: no heuristic. Discard a fixed warm-up window, measure a fixed window
 * after it, and print the per-second series so the shape is visible rather than
 * asserted — the 2x peaks against the median are sampling alignment against
 * that 1 Hz redraw, not burstiness.
 */
import net from 'node:net';

const [host, port, cols, rows, warmSecs, measSecs] = [
  process.argv[2] ?? '127.0.0.1',
  Number(process.argv[3] ?? 2324),
  Number(process.argv[4] ?? 80),
  Number(process.argv[5] ?? 24),
  Number(process.argv[6] ?? 10),
  Number(process.argv[7] ?? 60),
];

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const NAWS = 31, ECHO = 1, SGA = 3;

const sock = net.createConnection({ host, port });
sock.setNoDelay(true);

let total = 0;
const perSecond = [];       // bytes received in each whole second since connect
let bucket = 0;
const t0 = Date.now();

const sendNaws = () => sock.write(
  Buffer.from([IAC, SB, NAWS, cols >> 8, cols & 255, rows >> 8, rows & 255, IAC, SE]));

sock.on('connect', () => { sock.write(Buffer.from([IAC, WILL, NAWS])); sendNaws(); });

sock.on('data', (buf) => {
  total += buf.length;
  bucket += buf.length;
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] !== IAC) continue;
    const verb = buf[i + 1], opt = buf[i + 2];
    if (verb === DO && opt === NAWS) { sock.write(Buffer.from([IAC, WILL, NAWS])); sendNaws(); }
    else if (verb === DO) sock.write(Buffer.from([IAC, WONT, opt]));
    else if (verb === WILL && (opt === ECHO || opt === SGA)) sock.write(Buffer.from([IAC, DO, opt]));
    else if (verb === WILL) sock.write(Buffer.from([IAC, DONT, opt]));
  }
});

const tick = setInterval(() => { perSecond.push(bucket); bucket = 0; }, 1000);

setTimeout(() => {
  clearInterval(tick);
  const warm = perSecond.slice(0, warmSecs);
  const meas = perSecond.slice(warmSecs, warmSecs + measSecs);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const sorted = [...meas].sort((a, b) => a - b);
  const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
  const steady = meas.length ? sum(meas) / meas.length : 0;
  console.log(JSON.stringify({
    cols, rows,
    warmupSeconds: warm.length,
    warmupBytes: sum(warm),
    firstSecondBytes: perSecond[0] ?? 0,
    measuredSeconds: meas.length,
    measuredBytes: sum(meas),
    steadyBytesPerSec: Number(steady.toFixed(1)),
    steadyKbPerSec: Number((steady / 1024).toFixed(2)),
    medianBytesPerSec: pct(0.5),
    p95BytesPerSec: pct(0.95),
    minBytesPerSec: sorted[0] ?? 0,
    maxBytesPerSec: sorted[sorted.length - 1] ?? 0,
    zeroSeconds: meas.filter((b) => b === 0).length,
    totalBytes: total,
    wallSeconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
  }));
  sock.destroy();
  process.exit(0);
}, (warmSecs + measSecs) * 1000 + 1500);

sock.on('error', (e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
