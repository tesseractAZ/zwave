/**
 * Per-node learned BASELINES (M3, DESIGN.md §3.2) — each node's "normal" for the
 * signals the symptom engine compares against, learned from the evidence stream
 * and persisted so restarts and power blips don't reset weeks of learning.
 *
 * The design review's load-bearing lesson: ONE statistic does not fit all
 * series. This module keeps THREE per series-class:
 *
 *  - COUNTING series (timeoutResponse rate): a decayed Poisson rate λ =
 *    Σevents / Σtrials over a minimum-traffic denominator. Never median/MAD —
 *    a mostly-zero series has MAD 0, which would make any nonzero reading look
 *    infinitely anomalous. Anomaly = the Poisson upper tail (in symptoms.ts).
 *  - CONTINUOUS series (rssi, rtt): median + MAD via a fixed-bin decayed
 *    histogram, with a MAD FLOOR tied to instrument precision (≥3 dB rssi,
 *    ≥1 EMA-step rtt) so a degenerate low-dispersion band can't manufacture an
 *    unbounded z-score. Fed FRESH observations only (a re-sampled driver EMA
 *    carries no new information — pseudo-replication collapses dispersion).
 *  - DISCRETE series (routeKey): handled by the detectors directly (categorical
 *    change/dwell), not here.
 *
 * Bands: normals are split into TIME-OF-DAY bands — interference is diurnal
 * (a baby monitor at night must not poison the daytime baseline). rssi/rtt are
 * additionally reset on a routeKey change (a new route legitimately shifts both;
 * the sanctioned minimum vs full per-route stratification).
 *
 * Honest learning units: a band GRADUATES (its detectors may fire) only after
 * it has seen enough INDEPENDENT observations across ≥K distinct calendar days —
 * not raw 10 s snapshots, which are ~99 % autocorrelated. A dormant band renders
 * `learning (d/K days)`, never a fabricated prior.
 *
 * Baseline lifecycle: windows inside an active symptom's dwell (including the
 * pre-emission arming window) are QUARANTINED from updates (the baseline must
 * not chase the pathology); aggregates DECAY slowly so genuine improvements are
 * eventually absorbed; and routeKey change / re-interview / home-id change force
 * a reset. A permanently-symptomatic node's baseline therefore FREEZES at its
 * last-healthy normal — accepted (v0.14 review): that keeps a genuinely-broken
 * node flagged against its own healthy history rather than normalizing the
 * fault. DESIGN's bounded-quarantine/forced-re-baseline-after-K-weeks is a
 * future refinement, not needed for correctness.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { uptime as osUptime } from 'node:os';
import type { EvidenceSample } from './evidenceStore';

/** Time-of-day bands: 6 × 4 h — diurnal resolution without over-fragmenting. */
export const N_BANDS = 6;
export function bandOf(t: number): number {
  // Local hour → band. Uses the wall clock; a pre-NTP boot can misband a few
  // samples, which the decay + multi-day graduation absorb.
  const hour = new Date(t).getHours();
  return Math.min(N_BANDS - 1, Math.floor(hour / (24 / N_BANDS)));
}

/** RSSI histogram: 2 dB bins from −120 to −20 dBm. */
const RSSI_LO = -120;
const RSSI_HI = -20;
const RSSI_BIN = 2;
const RSSI_NBINS = (RSSI_HI - RSSI_LO) / RSSI_BIN; // 50
/** RTT histogram: 41 log-ish bins, fine near 0 and coarser past 1 s. */
const RTT_EDGES = ((): number[] => {
  const e: number[] = [];
  for (let ms = 0; ms <= 100; ms += 10) e.push(ms); // 0..100 by 10
  for (let ms = 125; ms <= 500; ms += 25) e.push(ms); // 100..500 by 25
  for (let ms = 600; ms <= 2000; ms += 100) e.push(ms); // 500..2000 by 100
  e.push(Infinity);
  return e;
})();

/** MAD floors (instrument precision, RESEARCH §1.11) — a MAD below the floor is
 *  "insufficient dispersion evidence", scaled UP to the floor for z-scoring. */
export const RSSI_MAD_FLOOR = 3; // dB
export const RTT_MAD_FLOOR = 8; // ms (~1 EMA step at typical RTTs)

/** Minimum independent observations AND distinct days before a band graduates. */
const MIN_OBS = 20;
const MIN_DAYS = 3;
/** Per-observation decay — gentle; effective memory ~1/α observations. */
const DECAY = 0.01;
/** Distinct-day ring cap (graduation only needs ≥ MIN_DAYS). */
const DAYS_RING = 10;

export interface RateBaseline {
  /** Decayed Σ events (e.g. timeouts). */
  events: number;
  /** Decayed Σ trials (commandsTX). */
  trials: number;
  /** Decayed independent-observation count. */
  obs: number;
  /** Distinct day-indices seen (bounded). */
  days: number[];
}

export interface HistBaseline {
  /** Decayed bin counts. */
  bins: number[];
  obs: number;
  days: number[];
}

export interface NodeBaseline {
  timeout: RateBaseline[]; // [band]
  rssi: HistBaseline[]; // [band]
  rtt: HistBaseline[]; // [band]
  /** routeKey the rssi/rtt histograms were learned under; a change resets them. */
  routeKey: string | null;
}

/** A learned rate normal, or null when the band hasn't graduated. */
export interface RateNormal {
  rate: number; // events per trial
  trials: number; // decayed denominator (confidence)
  ready: boolean;
  days: number;
}

/** A learned continuous normal, or not-ready. */
export interface ContNormal {
  median: number;
  /** MAD raised to at least the instrument-precision floor. */
  scale: number;
  ready: boolean;
  days: number;
}

export interface BaselineStoreOptions {
  path: string;
  maxAgeMs?: number; // discard a whole file older than this (0 = never; baselines are long-lived)
  bootGraceMs?: number; // kept: baselines are age-judgment-free, boot-grace does NOT drop them
  now?: () => number;
  uptimeMs?: () => number;
  log?: (msg: string) => void;
}

export interface BaselineStore {
  readonly path: string;
  /**
   * Fold one evidence sample into the node's baselines. `quarantined` = the node
   * has an active symptom → skip (don't chase the pathology). Returns nothing;
   * mutates in place.
   */
  observe(nodeId: number, s: EvidenceSample, quarantined: boolean): void;
  /** The learned timeout-rate normal for a node's current-time band. */
  timeoutNormal(nodeId: number, at: number): RateNormal | null;
  /** The learned rssi normal for a node's current-time band. */
  rssiNormal(nodeId: number, at: number): ContNormal | null;
  /** The learned rtt normal for a node's current-time band. */
  rttNormal(nodeId: number, at: number): ContNormal | null;
  /** Force-reset a node's baselines (re-interview / replace / home-id change). */
  resetNode(nodeId: number): void;
  /** Drop everything (home-id change) and rewrite disk immediately. */
  reset(): void;
  load(): void;
  save(): void;
}

interface Persisted {
  v: number;
  savedAt: number;
  nodes: Record<string, NodeBaseline>;
}

const SCHEMA_V = 1;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — baselines are long-lived
const DEFAULT_BOOT_GRACE_MS = 180 * 1000;

function emptyRate(): RateBaseline {
  return { events: 0, trials: 0, obs: 0, days: [] };
}
function emptyHist(nbins: number): HistBaseline {
  return { bins: new Array(nbins).fill(0), obs: 0, days: [] };
}
function emptyNode(): NodeBaseline {
  return {
    timeout: Array.from({ length: N_BANDS }, emptyRate),
    rssi: Array.from({ length: N_BANDS }, () => emptyHist(RSSI_NBINS)),
    rtt: Array.from({ length: N_BANDS }, () => emptyHist(RTT_EDGES.length - 1)),
    routeKey: null,
  };
}

function dayIndex(t: number): number {
  return Math.floor(t / 86_400_000);
}
function noteDay(days: number[], day: number): void {
  if (days.length && days[days.length - 1] === day) return;
  if (days.includes(day)) return;
  days.push(day);
  if (days.length > DAYS_RING) days.shift();
}

function rssiBin(dbm: number): number {
  if (dbm < RSSI_LO || dbm > RSSI_HI) return -1;
  return Math.min(RSSI_NBINS - 1, Math.floor((dbm - RSSI_LO) / RSSI_BIN));
}
function rttBin(ms: number): number {
  for (let i = 0; i < RTT_EDGES.length - 1; i++) {
    if (ms < RTT_EDGES[i + 1]) return i;
  }
  return RTT_EDGES.length - 2;
}
/** Representative value at a histogram bin's center. */
function rssiCenter(i: number): number {
  return RSSI_LO + i * RSSI_BIN + RSSI_BIN / 2;
}
function rttCenter(i: number): number {
  const hi = RTT_EDGES[i + 1] === Infinity ? RTT_EDGES[i] + 100 : RTT_EDGES[i + 1];
  return (RTT_EDGES[i] + hi) / 2;
}

/** Weighted median + MAD from a decayed histogram, with the precision floor. */
function histStats(h: HistBaseline, center: (i: number) => number, madFloor: number): ContNormal | null {
  const ready = h.obs >= MIN_OBS && h.days.length >= MIN_DAYS;
  const total = h.bins.reduce((a, b) => a + b, 0);
  if (total <= 0) return { median: 0, scale: madFloor, ready: false, days: h.days.length };
  // Weighted median.
  const half = total / 2;
  let acc = 0;
  let median = center(0);
  for (let i = 0; i < h.bins.length; i++) {
    acc += h.bins[i];
    if (acc >= half) {
      median = center(i);
      break;
    }
  }
  // MAD: weighted median of |center - median|. Build a small deviation list.
  const devs: { d: number; w: number }[] = [];
  for (let i = 0; i < h.bins.length; i++) {
    if (h.bins[i] > 0) devs.push({ d: Math.abs(center(i) - median), w: h.bins[i] });
  }
  devs.sort((a, b) => a.d - b.d);
  let dacc = 0;
  let mad = 0;
  for (const { d, w } of devs) {
    dacc += w;
    if (dacc >= half) {
      mad = d;
      break;
    }
  }
  // 1.4826·MAD ≈ σ for a normal; floor it to instrument precision.
  const scale = Math.max(1.4826 * mad, madFloor);
  return { median, scale, ready, days: h.days.length };
}

export function createBaselineStore(opts: BaselineStoreOptions): BaselineStore {
  const path = opts.path;
  const tmp = `${path}.tmp`;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const bootGraceMs = opts.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS;
  const now = opts.now ?? Date.now;
  const uptimeMs = opts.uptimeMs ?? (() => osUptime() * 1000);
  const log = opts.log ?? (() => {});

  const map = new Map<number, NodeBaseline>();
  let dirty = false;

  const nodeOf = (id: number): NodeBaseline => {
    let n = map.get(id);
    if (!n) {
      n = emptyNode();
      map.set(id, n);
    }
    return n;
  };

  /** Decay a rate baseline toward 0 by one observation-step, then add. */
  function foldRate(r: RateBaseline, events: number, trials: number, at: number): void {
    r.events = r.events * (1 - DECAY) + events;
    r.trials = r.trials * (1 - DECAY) + trials;
    r.obs = r.obs * (1 - DECAY) + 1;
    noteDay(r.days, dayIndex(at));
  }
  function foldHist(h: HistBaseline, bin: number, at: number): void {
    if (bin < 0 || bin >= h.bins.length) return;
    for (let i = 0; i < h.bins.length; i++) h.bins[i] *= 1 - DECAY;
    h.bins[bin] += 1;
    h.obs = h.obs * (1 - DECAY) + 1;
    noteDay(h.days, dayIndex(at));
  }

  return {
    path,

    observe(nodeId, s, quarantined): void {
      if (quarantined) return; // don't chase the pathology
      const n = nodeOf(nodeId);
      const band = bandOf(s.t);
      // Timeout RATE — only valid windows WITH traffic (a null/zero-tx window
      // carries no rate information).
      if (s.dTx != null && s.dTx > 0 && s.dTimeout != null) {
        foldRate(n.timeout[band], s.dTimeout, s.dTx, s.t);
        dirty = true;
      }
      // rssi/rtt — FRESH observations only; reset on a route change (a new route
      // legitimately shifts both).
      if (s.routeKey !== n.routeKey) {
        n.routeKey = s.routeKey;
        for (let b = 0; b < N_BANDS; b++) {
          n.rssi[b] = emptyHist(RSSI_NBINS);
          n.rtt[b] = emptyHist(RTT_EDGES.length - 1);
        }
        dirty = true;
      }
      if (s.fresh && s.rssi != null) {
        foldHist(n.rssi[band], rssiBin(s.rssi), s.t);
        dirty = true;
      }
      if (s.fresh && s.rtt != null && s.rtt >= 0) {
        foldHist(n.rtt[band], rttBin(s.rtt), s.t);
        dirty = true;
      }
    },

    timeoutNormal(nodeId, at): RateNormal | null {
      const n = map.get(nodeId);
      if (!n) return null;
      const r = n.timeout[bandOf(at)];
      const ready = r.obs >= MIN_OBS && r.days.length >= MIN_DAYS && r.trials > 0;
      return { rate: r.trials > 0 ? r.events / r.trials : 0, trials: r.trials, ready, days: r.days.length };
    },
    rssiNormal(nodeId, at): ContNormal | null {
      const n = map.get(nodeId);
      if (!n) return null;
      return histStats(n.rssi[bandOf(at)], rssiCenter, RSSI_MAD_FLOOR);
    },
    rttNormal(nodeId, at): ContNormal | null {
      const n = map.get(nodeId);
      if (!n) return null;
      return histStats(n.rtt[bandOf(at)], rttCenter, RTT_MAD_FLOOR);
    },

    resetNode(nodeId): void {
      if (map.delete(nodeId)) dirty = true;
    },
    reset(): void {
      map.clear();
      dirty = true;
      this.save();
    },

    load(): void {
      map.clear();
      try {
        if (!existsSync(path)) return;
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Persisted>;
        if (!parsed || typeof parsed !== 'object' || parsed.v !== SCHEMA_V) {
          if (parsed && parsed.v !== SCHEMA_V) log(`baselines: schema ${String(parsed.v)} unsupported — starting fresh`);
          return;
        }
        const savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : 0;
        // Baselines are age-judgment-free learned state: boot-grace does NOT
        // drop them (a daily power blip must not wipe weeks of learning). Only
        // an explicitly ancient file (or none) is discarded — and even the age
        // check is skipped under boot-grace, when the clock itself is untrusted.
        const grace = bootGraceMs > 0 && uptimeMs() < bootGraceMs;
        if (!grace && maxAgeMs > 0 && savedAt > 0 && now() - savedAt > maxAgeMs) {
          log('baselines: file older than max age — starting fresh');
          return;
        }
        const nodes = parsed.nodes;
        if (!nodes || typeof nodes !== 'object') return;
        for (const [k, v] of Object.entries(nodes)) {
          const id = Number(k);
          if (!Number.isInteger(id) || id <= 0 || !v) continue;
          const restored = coerceNode(v as Partial<NodeBaseline>);
          if (restored) map.set(id, restored);
        }
        log(`baselines: restored ${map.size} node(s) from ${path}`);
      } catch (e) {
        log(`baselines: load failed (${(e as Error).message}) — starting fresh`);
        map.clear();
      }
      dirty = false;
    },

    save(): void {
      if (!dirty) return;
      try {
        const nodes: Persisted['nodes'] = {};
        for (const [id, n] of map) {
          if (!Number.isInteger(id) || id <= 0) continue;
          nodes[String(id)] = n;
        }
        const payload: Persisted = { v: SCHEMA_V, savedAt: now(), nodes };
        writeFileSync(tmp, JSON.stringify(payload), 'utf8');
        renameSync(tmp, path);
        dirty = false;
      } catch (e) {
        log(`baselines: save failed (${(e as Error).message})`);
      }
    },
  };
}

/** Coerce a persisted node structure back into a well-formed NodeBaseline. */
function coerceNode(v: Partial<NodeBaseline>): NodeBaseline | null {
  const n = emptyNode();
  n.routeKey = typeof v.routeKey === 'string' ? v.routeKey : null;
  const okRate = (a: unknown): a is RateBaseline[] => Array.isArray(a) && a.length === N_BANDS;
  const okHist = (a: unknown, nbins: number): a is HistBaseline[] =>
    Array.isArray(a) && a.length === N_BANDS && a.every((h) => h && Array.isArray((h as HistBaseline).bins) && (h as HistBaseline).bins.length === nbins);
  if (okRate(v.timeout)) {
    for (let b = 0; b < N_BANDS; b++) {
      const r = v.timeout[b];
      n.timeout[b] = {
        events: num(r?.events),
        trials: num(r?.trials),
        obs: num(r?.obs),
        days: Array.isArray(r?.days) ? r.days.filter((d) => Number.isFinite(d)).slice(-DAYS_RING) : [],
      };
    }
  }
  if (okHist(v.rssi, RSSI_NBINS)) n.rssi = v.rssi.map((h) => coerceHist(h, RSSI_NBINS));
  if (okHist(v.rtt, RTT_EDGES.length - 1)) n.rtt = v.rtt.map((h) => coerceHist(h, RTT_EDGES.length - 1));
  return n;
}
function coerceHist(h: HistBaseline, nbins: number): HistBaseline {
  return {
    bins: h.bins.slice(0, nbins).map(num),
    obs: num(h.obs),
    days: Array.isArray(h.days) ? h.days.filter((d) => Number.isFinite(d)).slice(-DAYS_RING) : [],
  };
}
function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0;
}
