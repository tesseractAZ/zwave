/** The data layer wired to the REAL HaWsClient against _realHa's mock Core. */
import assert from 'node:assert/strict';
import { createHaWsClient, type HaWsClient } from '../src/ha/haWsClient';
import { createZwaveData } from '../src/zwave/zwaveData';
import { MockHa, World, ZObj, baseWorld, sleep, type Hook } from './_realHa';

const DAY = 86_400_000;
const realNow = Date.now.bind(Date);
export let skip = 0;
export function addSkip(ms: number): void { skip += ms; }

export async function waitFor(cond: () => boolean, ms = 15_000, why?: () => string): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`waitFor: condition not met in time${why ? ` — ${why()}` : ''}`);
    await sleep(5);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Priv = any;

export interface Run {
  w: World;
  m: MockHa;
  client: HaWsClient;
  cpriv: any;
  zd: ReturnType<typeof createZwaveData>;
  priv: Priv;
  logs: string[];
  clogs: string[];
  /** Everything quiet: no gate parked in the data layer, no command out, socket up. */
  quiet: () => boolean;
  settle: (ms?: number) => Promise<void>;
  /** One roster poll (the loop's own timer is an hour away), then settle. */
  poll: () => Promise<void>;
  pollOnly: () => Promise<void>;
  /** Drop the socket; re-auth follows after the patched backoff. */
  drop: () => void;
  resubs: () => number;
  perNode: () => number;
  rebuilds: () => number;
}

export interface Opts {
  world?: World;
  setup?: (w: World, m: MockHa) => void;
  backoffMs?: number;
  retryMs?: number;
  evictAfterMs?: number;
  refreshMs?: number;
  bootPolled?: boolean;
  /** Boot is over once this holds (instead of a polled, quiet start). */
  bootWait?: (priv: Priv, logs: string[]) => boolean;
}

export async function withHa(body: (r: Run) => Promise<void>, o: Opts = {}): Promise<void> {
  skip = 0;
  Date.now = () => realNow() + skip;
  const w = o.world ?? baseWorld();
  const m = new MockHa(w);
  await m.listen();
  o.setup?.(w, m);
  const logs: string[] = [];
  const clogs: string[] = [];
  const client = createHaWsClient({ url: m.url, token: 'test-token', log: (s) => clogs.push(s) });
  const cpriv = client as any;
  // The backoff, shortened (its floor is 1 s): same path, scheduled sooner.
  const backoff = o.backoffMs ?? 40;
  cpriv.scheduleReconnect = function (this: any) {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, backoff);
  };
  const bootAt = Date.now() - 5 * DAY;
  const zd = createZwaveData({
    client, refreshMs: o.refreshMs ?? 3_600_000, routePollMs: 60_000, evidenceSampleMs: 30 * 60_000,
    historyPath: null, evidencePath: null, baselinesPath: null, outcomesPath: null, driverWsUrl: null,
    log: (s: string) => logs.push(s), uptimeMs: () => Date.now() - bootAt,
    ...(o.evictAfterMs != null ? { evictAfterMs: o.evictAfterMs } : {}),
  });
  const priv = zd as Priv;
  if (o.retryMs != null) {
    const ms = o.retryMs;
    priv.armSubRetry = function (this: any) {
      if (this.pendingNodeSubs.size > 0 && !this.subRetryTimer) {
        this.subRetryTimer = setInterval(() => void this.retryNodeSubs(), ms);
        this.subRetryTimer.unref?.();
      }
    };
  }
  const quiet = () => !priv.ticking && priv.registriesInFlight == null && priv.entryIdInFlight == null && !priv.rebuildInFlight && priv.statsSubscribed
    && !priv.nodeSubsBusy && client.ready() && cpriv.pending.size === 0 && cpriv.readyWaiters.size === 0 && !m.busy()
    && m.current() != null;
  const settle = async (ms = Number(process.env.SETTLE_MS ?? 15_000)) => {
    // Twice, apart: a release fired-and-forgotten lands after a first quiet read.
    await waitFor(quiet, ms, () => `not quiet: ${JSON.stringify({ reg: priv.registriesInFlight != null, rb: priv.rebuildInFlight, ss: priv.statsSubscribed, busy: priv.nodeSubsBusy, ready: client.ready(), pend: cpriv.pending.size, wait: cpriv.readyWaiters.size, mbusy: m.busy() })} | ${logs.slice(-12).join(' | ')}`);
    await sleep(30);
    await waitFor(quiet, ms, () => logs.slice(-12).join(' | '));
  };
  // The loop runs one tick at a time (scheduleNext after each); count them so a
  // test never starts a second beside one in flight.
  const tick0 = priv.tick.bind(priv);
  priv.ticking = 0;
  priv.tick = async () => { priv.ticking += 1; try { await tick0(); } finally { priv.ticking -= 1; } };
  const pollOnly = async () => {
    if (priv.pollTimer) clearTimeout(priv.pollTimer);
    await priv.tick();
  };
  const run: Run = {
    w, m, client, cpriv, zd, priv, logs, clogs, quiet, settle, pollOnly,
    poll: async () => { await pollOnly(); await settle(); },
    drop: () => { m.drop(); },
    resubs: () => logs.filter((l) => /^live statistics: node \d+'s feeds: re-subscribe /.test(l)).length,
    perNode: () => logs.filter((l) => /^live statistics: node \d+'s feeds: /.test(l)).length,
    rebuilds: () => logs.filter((l) => l.startsWith('live statistics: subscribed')).length,
  };
  try {
    client.start();
    zd.start();
    if (o.bootWait) { await waitFor(() => o.bootWait!(priv, logs), 30_000, () => logs.join(' | ')); await waitFor(() => !priv.ticking && !priv.rebuildInFlight, 30_000); }
    else if (o.bootPolled === false) await waitFor(quiet, 15_000, () => logs.join(' | '));
    else await waitFor(() => zd.snapshot().length > 0 && priv.lastHomeId != null && quiet(), 15_000, () => logs.join(' | '));
    if (!o.bootWait) await settle();
    await body(run);
  } finally {
    zd.stop();
    client.stop();
    await m.close();
    Date.now = realNow;
  }
}

/** Node ids whose subscribes can succeed: on the roster, not node 1, with a device, not failing. */
export function subscribable(r: Run): number[] {
  const { w, m } = r;
  const out: number[] = [];
  for (const n of w.nodes.keys()) {
    if (n === 1) continue;
    if (!w.reg.getEntry([w.H(n)], w.entry)) continue;
    if (m.failSubs.has(n)) continue;
    out.push(n);
  }
  return out.sort((a, b) => a - b);
}

const sorted = (xs: Iterable<number>) => [...xs].sort((a, b) => a - b);

/** I1–I4 on the settled state. Returns the violations instead of throwing when `collect`. */
export function invariants(r: Run, why: string): string[] {
  const { w, m, priv } = r;
  const v: string[] = [];
  const cur = m.current();
  if (!cur) return [`${why}: no open connection`];
  // I1: one statistics and one status listener on the node object held now, none elsewhere.
  for (const n of subscribable(r)) {
    const o = w.nodes.get(n)!;
    const st = [...o.stats].filter((s) => s.conn === cur).length;
    const ss = [...o.status].filter((s) => s.conn === cur).length;
    if (m.failFeed.has(`${n}:stats`) ? st !== 0 : st !== 1) v.push(`I1 node ${n}: ${st} statistics listeners on its node object`);
    if (m.failFeed.has(`${n}:status`) ? ss !== 0 : ss !== 1) v.push(`I1 node ${n}: ${ss} status listeners on its node object`);
  }
  const held = new Set<ZObj>(w.nodes.values());
  for (const o of w.objs) {
    if (held.has(o)) continue;
    const k = o.stats.size + o.status.size;
    if (k > 0) v.push(`I1 node ${o.n}: ${k} listeners on a node object HA no longer holds`);
  }
  for (const c of m.conns) if (!c.open && c.subs.size > 0) v.push(`conn ${c.idx} closed with ${c.subs.size} subs`);
  // I2
  const statsHave = new Set<number>(); const statusHave = new Set<number>();
  for (const [n, o] of w.nodes) {
    if ([...o.stats].some((s) => s.conn === cur)) statsHave.add(n);
    if ([...o.status].some((s) => s.conn === cur)) statusHave.add(n);
  }
  const a1 = sorted(priv.statsSubbedNodes as Set<number>), b1 = sorted(statsHave);
  if (JSON.stringify(a1) !== JSON.stringify(b1)) v.push(`I2 statsSubbedNodes ${JSON.stringify(a1)} vs listeners ${JSON.stringify(b1)}`);
  const a2 = sorted(priv.statusSubbed as Set<number>), b2 = sorted(statusHave);
  if (JSON.stringify(a2) !== JSON.stringify(b2)) v.push(`I2 statusSubbed ${JSON.stringify(a2)} vs listeners ${JSON.stringify(b2)}`);
  // I3: the books hold exactly the live handles; none released twice.
  const books = new Set<number>();
  for (const s of priv.ownedStatsSubs as Array<{ subscriptionId: number }>) books.add(s.subscriptionId);
  for (const rec of ((priv.nodeFeedSubs ?? new Map()) as Map<number, { subs: Array<{ subscriptionId: number }> }>).values()) for (const s of rec.subs) books.add(s.subscriptionId);
  const live = new Set<number>(cur.subs.keys());
  const unheld = [...live].filter((id) => !books.has(id)).map((id) => `${id}:${cur.subs.get(id)!.kind}:${cur.subs.get(id)!.node ?? '-'}`);
  const dead = [...books].filter((id) => !live.has(id));
  if (unheld.length) v.push(`I3 live handles no map holds: ${unheld.join(', ')}`);
  if (dead.length) v.push(`I3 books hold handles not live: ${dead.join(', ')}`);
  const twice = [...m.releases.entries()].filter(([, k]) => k > 1).map(([id]) => id);
  if (twice.length) v.push(`I3 released more than once: ${twice.join(', ')}`);
  // I4
  const kinds = (k: string) => [...cur.subs.values()].filter((s) => s.kind === k);
  const ctrl = kinds('ctrl');
  if (ctrl.length !== 1) v.push(`I4 ${ctrl.length} controller feeds on the connection`);
  else if (ctrl[0].obj !== w.ctrl) v.push('I4 the controller feed is bound to an old controller object');
  if (kinds('state').length !== 1) v.push(`I4 ${kinds('state').length} state_changed feeds`);
  if (kinds('notif').length !== 1) v.push(`I4 ${kinds('notif').length} notification feeds`);
  if (m.idReuse.length) v.push(`id reuse: ${m.idReuse.join('; ')}`);
  return v.map((s) => `${why}: ${s}`);
}

export function assertInv(r: Run, why: string): void {
  const v = invariants(r, why);
  assert.deepEqual(v, [], v.join('\n') + '\n--- log tail ---\n' + r.logs.slice(-40).join('\n'));
}

export type { Hook };
