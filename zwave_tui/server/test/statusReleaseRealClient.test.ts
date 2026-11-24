/**
 * v0.79.7 review — a status a node's old status feed hears while the node's
 * own re-subscribe releases it, over the REAL HaWsClient and _realHa's mock
 * Core (commands processed in arrival order, network_status answering after
 * its own driver round trip, a one-way latency per frame).
 *
 * The re-subscribe releases the statistics feed first, and the client drops
 * the status feed's handler only as that feed's release starts, so the old
 * status feed still delivers while the statistics release is out. Nothing
 * here holds a subscribe: the only hold is a stall of the Core on node 60's
 * statistics release, as a Core busy for one poll gap would make, with the
 * next roster poll's network_status queued behind it in the first test.
 *
 * Each test runs both ways, as statusOrderRealClient.test.ts does: frames
 * uncompressed (the mock's server offers no extension), and permessage-deflate
 * negotiated with server_no_context_takeover and every frame compressed (the
 * mock's server options set before the client connects; aiohttp compresses
 * every message once the extension is agreed), which the client inflates
 * asynchronously, one frame at a time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withHa, addSkip, waitFor, type Run } from './_realRun';
import { sleep, type MockHa } from './_realHa';

type Mode = 'uncompressed' | 'deflate';
const MODES: Mode[] = ['uncompressed', 'deflate'];

/** The mock's server, set to accept permessage-deflate, every frame compressed. */
function frames(m: MockHa, mode: Mode): void {
  if (mode === 'deflate') (m.wss as unknown as { options: Record<string, unknown> }).options.perMessageDeflate = { serverNoContextTakeover: true, threshold: 0 };
}

const books = (r: Run, n: number): { flaps: number; queued: number } => ({
  flaps: (r.priv.flapAccum as Map<number, number>).get(n) ?? 0,
  queued: (r.priv.deadEvents as Array<{ nodeId: number; cleared: boolean }>).filter((e) => e.nodeId === n && !e.cleared).length,
});

/** Stall the Core on the release of node 60's statistics feed (its handle on the live connection). */
function stallOnStatsRelease(r: Run): { arrived: () => boolean; free: () => void } {
  const cur = r.m.current()!;
  const sid = [...cur.subs.values()].find((s) => s.kind === 'stats' && s.node === 60)!.id;
  let free!: () => void;
  const hold = new Promise<void>((res) => { free = res; });
  let arrived = false;
  r.m.hooks.push((_c, msg) => {
    if (arrived || msg.type !== 'unsubscribe_events' || Number(msg.subscription) !== sid) return null;
    arrived = true;
    return { hold };
  });
  return { arrived: () => arrived, free };
}

test('the real client, a Core stall while a re-interviewed node\'s statistics feed is released, its old status feed delivering a death and the next roster poll queued behind the stall: the poll that reads it Dead before the new status feed answers counts nothing more (v0.79.7 review)', { timeout: 60_000 }, async () => {
  for (const mode of MODES) {
    await withHa(async (r) => {
      assert.equal(String(r.cpriv.ws?.extensions ?? ''), mode === 'deflate' ? 'permessage-deflate' : '', `${mode}: precondition: the frames as asked`);
      await r.poll();
      r.w.startInterview(60);
      const st = stallOnStatsRelease(r);
      addSkip(2_000);
      await r.pollOnly();                 // reads node 60 Alive and not ready: its own re-subscribe starts
      await waitFor(st.arrived);
      r.m.statusDelayMs = 40;             // network_status awaits its driver round trip
      addSkip(2_000);
      const next = r.pollOnly();          // the next poll, sent while the Core is stalled
      await sleep(30);
      r.w.emitStatus(60, 'dead');         // forwarded on the old status feed
      await waitFor(() => books(r, 60).flaps === 1);
      st.free();                          // the stall ends
      await next;
      await r.settle();
      assert.equal(r.priv.statusSubbed.has(60), true, `${mode}: precondition: the new status feed is live`);
      assert.deepEqual(books(r, 60), { flaps: 1, queued: 1 }, `${mode}: one death, counted once`);
    }, { setup: (_w, m) => { m.latencyMs = 10; frames(m, mode); } });
  }
});

test('the real client, a death a re-interviewed node\'s old status feed delivers while its statistics feed is released, the node revived before the next roster poll: the revival the new status feed hears clears the death (v0.79.7 review)', { timeout: 60_000 }, async () => {
  for (const mode of MODES) {
    await withHa(async (r) => {
      assert.equal(String(r.cpriv.ws?.extensions ?? ''), mode === 'deflate' ? 'permessage-deflate' : '', `${mode}: precondition: the frames as asked`);
      await r.poll();
      r.w.startInterview(60);
      const st = stallOnStatsRelease(r);
      addSkip(2_000);
      await r.pollOnly();                 // reads node 60 Alive and not ready: its own re-subscribe starts
      await waitFor(st.arrived);
      r.w.emitStatus(60, 'dead');         // forwarded on the old status feed
      await waitFor(() => books(r, 60).flaps === 1);
      st.free();
      await r.settle();
      assert.equal(r.priv.statusSubbed.has(60), true, `${mode}: precondition: the new status feed is live`);
      const seed = (r.priv.subStatus as Map<number, number>).get(60);
      const heard = (r.priv.statusHeardAt as Map<number, number>).get(60);
      addSkip(1_000);
      r.w.emitStatus(60, 'alive');        // heard by the new status feed, before the next poll
      await waitFor(() => (r.priv.statusHeardAt as Map<number, number>).get(60) !== heard);
      r.zd.drainDeadEvents();
      assert.deepEqual(books(r, 60), { flaps: 2, queued: 0 }, `${mode}: the death and the revival counted, the death cleared (the new status feed seeded ${seed})`);
    }, { setup: (_w, m) => { m.latencyMs = 2; frames(m, mode); } });
  }
});
