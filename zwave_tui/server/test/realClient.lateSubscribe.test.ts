/**
 * The data layer over the REAL HaWsClient and _realHa's mock Core, with a
 * subscribe Home Assistant answers after the client's 10 s reply timeout
 * (v0.79.7). The client rejects it and drops its handler; Home Assistant
 * attaches the listener when it reaches the command. Through v0.79.6 that
 * listener stayed on the node (or controller) object, live on the connection
 * with no handle anywhere, beside the one the node retry or the next rebuild
 * made. The client now releases it on its socket, behind the subscribe.
 *
 * Every test uses the client's own 10 s bound, unpatched: the Core holds the
 * command 10.6 s.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withHa, invariants, addSkip } from './_realRun';

test('a node status subscribe answered after the client timeout, then the retry: one statistics and one status listener on each node object, every live subscription held (v0.79.7)', { timeout: 120_000 }, async () => {
  let free!: () => void;
  const hold = new Promise<void>((r) => { free = r; });
  let held = false;
  await withHa(async (r) => {
    assert.ok(r.logs.some((l) => /^node-status subscribe failed \(node 60\): HA WS timeout/.test(l)), 'precondition: the boot rebuild gave up on node 60');
    assert.equal(r.priv.pendingNodeSubs.has(60), true, 'precondition: node 60 is queued for the retry');
    // Home Assistant has reached the subscribe since: its listener was made.
    assert.ok(r.m.subLog.some((s) => s.kind === 'status' && s.node === 60), 'precondition: Home Assistant attached the late listener');
    await r.priv.retryNodeSubs();
    await r.settle();
    await r.poll();
    const v = invariants(r, 'after the retry');
    assert.deepEqual(v, [], v.join('\n'));
    const cur = r.m.current()!;
    const o = r.w.nodes.get(60)!;
    assert.equal([...o.status].filter((s) => s.conn === cur).length, 1, 'one status listener on node 60');
    assert.equal(r.m.releaseMisses, 0, 'the release found the subscription it named');
  }, {
    setup: (w, m) => {
      m.hooks.push((_c, msg) => {
        if (held || msg.type !== 'zwave_js/subscribe_node_status') return null;
        const dev = w.reg.devices.get(String(msg.device_id));
        if (!dev || !dev.ids[0].endsWith('-60')) return null;
        held = true;
        setTimeout(free, 10_600);
        return { hold };
      });
    },
  });
});

test('the controller statistics subscribe answered after the client timeout: one controller feed on the connection once the rebuild runs again (v0.79.7)', { timeout: 120_000 }, async () => {
  let free!: () => void;
  const hold = new Promise<void>((r) => { free = r; });
  let held = false;
  await withHa(async (r) => {
    assert.ok(r.logs.some((l) => /^subscribeStatistics failed: HA WS timeout/.test(l)), 'precondition: the rebuild gave up on the controller subscribe');
    await r.poll();             // the poll starts the rebuild again
    await r.poll();
    const v = invariants(r, 'after the rebuild');
    assert.deepEqual(v, [], v.join('\n'));
    assert.equal(r.m.subLog.filter((s) => s.kind === 'ctrl').length, 2, 'Home Assistant made the late feed and the rebuild\'s');
  }, {
    bootWait: (_p, logs) => logs.some((l) => /^subscribeStatistics failed: HA WS timeout/.test(l)),
    setup: (_w, m) => {
      m.hooks.push((_c, msg) => {
        if (held || msg.type !== 'zwave_js/subscribe_controller_statistics') return null;
        held = true;
        setTimeout(free, 10_600);
        return { hold };
      });
    },
  });
});

test('the state_changed subscribe answered after the client timeout: no whole-house feed is left live on the connection without a handle, and the one the activity retry makes a minute on is the only one Home Assistant holds (v0.79.7)', { timeout: 120_000 }, async () => {
  let free!: () => void;
  const hold = new Promise<void>((r) => { free = r; });
  let held = false;
  // Either form of the failure line: through v0.79.6 it did not name the feed.
  const gaveUp = (l: string) => /^activity subscribe failed( \(state_changed\))?: HA WS timeout/.test(l);
  await withHa(async (r) => {
    assert.ok(r.logs.some(gaveUp), 'precondition: the rebuild gave up on the state_changed subscribe');
    await r.settle();
    await r.poll();
    assert.ok(r.m.subLog.some((s) => s.kind === 'state'), 'precondition: Home Assistant attached the late listener');
    // A minute on (the host's uptime), the roster poll that succeeds makes
    // the state feed the rebuild could not.
    addSkip(61_000);
    await r.poll();
    const v = invariants(r, 'after the retry');
    assert.deepEqual(v, [], v.join('\n'));
    assert.equal(r.m.subLog.filter((s) => s.kind === 'state').length, 2, 'Home Assistant made the late feed and the retry\'s');
    const cur = r.m.current()!;
    const live = [...cur.subs.values()].filter((s) => s.kind === 'state').map((s) => s.id);
    assert.equal(live.length, 1, `one state_changed subscription live on the connection: ${JSON.stringify(live)}`);
    const books = (r.priv.ownedStatsSubs as Array<{ subscriptionId: number }>).map((s) => s.subscriptionId);
    assert.ok(books.includes(live[0]), 'the live one is the feed set\'s, where a re-arm releases it');
    assert.equal([...r.w.bus].filter((s) => s.kind === 'state').length, 1, 'one state_changed listener on the event bus for the add-on');
    assert.equal(r.m.releaseMisses, 0, 'the release found the subscription it named');
  }, {
    bootWait: (_p, logs) => logs.some(gaveUp),
    setup: (_w, m) => {
      m.hooks.push((_c, msg) => {
        if (held || msg.type !== 'subscribe_events' || msg.event_type !== 'state_changed') return null;
        held = true;
        setTimeout(free, 10_600);
        return { hold };
      });
    },
  });
});
