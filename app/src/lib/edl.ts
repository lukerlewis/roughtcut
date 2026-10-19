// The edit: which words are kept, who cut what, and the source ranges that
// make up the cut. Pure functions, so the transcript, timeline and player all
// read the same state and it can be tested without a window.

export interface Word {
  text: string;
  start: number;
  end: number;
  prob?: number;
}

export type AgentStatus = "pending" | "accepted" | "restored";

export interface AgentCut {
  first: number;
  last: number;
  reason: string;
  status: AgentStatus;
}

export interface Span {
  first: number;
  last: number;
}

export interface Op {
  at: string;
  by: "you" | "agent";
  op: string;
  first?: number;
  last?: number;
  note?: string;
}

export interface Edits {
  version: 1;
  agent: AgentCut[];
  user: Span[]; // words Luke cut himself, sorted, never overlapping
  log: Op[];
}

export interface Decisions {
  by?: string;
  summary?: string;
  cuts: { from: number; to: number; reason: string }[];
}

export interface Params {
  padIn: number;
  padOut: number;
  maxPause: number;
  minClip: number;
}

// Same defaults as the command-line rough cut (roughcut/timeline.py).
export const PARAMS: Params = { padIn: 0.08, padOut: 0.15, maxPause: 0.35, minClip: 0.25 };

export function fromDecisions(d: Decisions): Edits {
  return {
    version: 1,
    agent: d.cuts.map((c) => ({ first: c.from, last: c.to, reason: c.reason, status: "pending" as const })),
    user: [],
    log: [],
  };
}

export type CutKind = "agent-pending" | "agent-accepted" | "user" | null;

/** For every word, who cut it (if anyone). Luke's own cuts win. */
export function cutKinds(n: number, e: Edits): CutKind[] {
  const kinds: CutKind[] = new Array(n).fill(null);
  for (const c of e.agent) {
    if (c.status === "restored") continue;
    for (let i = c.first; i <= c.last && i < n; i++) kinds[i] = c.status === "pending" ? "agent-pending" : "agent-accepted";
  }
  for (const s of e.user) for (let i = s.first; i <= s.last && i < n; i++) kinds[i] = "user";
  return kinds;
}

export function keptSet(n: number, e: Edits): Set<number> {
  const kinds = cutKinds(n, e);
  const keep = new Set<number>();
  kinds.forEach((k, i) => k === null && keep.add(i));
  return keep;
}

/** Source ranges to play, in order. Mirrors kept_ranges in roughcut/timeline.py. */
export function keptRanges(words: Word[], keep: Set<number>, duration: number, p: Params = PARAMS): [number, number][] {
  const ranges: [number, number][] = [];
  let prev = -2;
  words.forEach((w, i) => {
    if (!keep.has(i)) return;
    const lo = i > 0 && !keep.has(i - 1) ? words[i - 1].end : 0;
    const hi = i + 1 < words.length && !keep.has(i + 1) ? words[i + 1].start : duration;
    const a = Math.max(lo, w.start - p.padIn, 0);
    const b = Math.min(hi, w.end + p.padOut, duration);
    const last = ranges[ranges.length - 1];
    if (prev === i - 1 && last && w.start - words[prev].end <= p.maxPause) last[1] = Math.max(last[1], b);
    else if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else ranges.push([a, b]);
    prev = i;
  });
  return ranges.filter(([a, b]) => b - a >= p.minClip);
}

export function cutDuration(ranges: [number, number][]): number {
  return ranges.reduce((s, [a, b]) => s + (b - a), 0);
}

/** Where a source time lands in the cut; a removed moment maps to the next kept frame. */
export function sourceToCut(ranges: [number, number][], t: number): number {
  let acc = 0;
  for (const [a, b] of ranges) {
    if (t < a) return acc;
    if (t <= b) return acc + (t - a);
    acc += b - a;
  }
  return acc;
}

/** The source time shown at a point in the cut, plus which range it's in. */
export function cutToSource(ranges: [number, number][], t: number): { source: number; index: number } {
  let acc = 0;
  for (let i = 0; i < ranges.length; i++) {
    const [a, b] = ranges[i];
    if (t < acc + (b - a) || i === ranges.length - 1) return { source: Math.min(b, a + Math.max(0, t - acc)), index: i };
    acc += b - a;
  }
  return { source: 0, index: 0 };
}

function now(): string {
  return new Date().toISOString();
}

function normalise(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((x, y) => x.first - y.first)) {
    const last = out[out.length - 1];
    if (last && s.first <= last.last + 1) last.last = Math.max(last.last, s.last);
    else out.push({ ...s });
  }
  return out;
}

/** Luke cuts words first..last. Words Claude already cut stay Claude's. */
export function cutWords(e: Edits, first: number, last: number): Edits {
  return {
    ...e,
    user: normalise([...e.user, { first, last }]),
    log: [...e.log, { at: now(), by: "you", op: "cut", first, last }],
  };
}

/** Bring words back: Luke's cuts in the range are lifted, and any of Claude's
 *  cuts touching it are restored whole. */
export function restoreWords(e: Edits, first: number, last: number): Edits {
  const user: Span[] = [];
  for (const s of e.user) {
    if (s.last < first || s.first > last) user.push(s);
    else {
      if (s.first < first) user.push({ first: s.first, last: first - 1 });
      if (s.last > last) user.push({ first: last + 1, last: s.last });
    }
  }
  const agent = e.agent.map((c) =>
    c.status !== "restored" && c.first <= last && c.last >= first ? { ...c, status: "restored" as const } : c,
  );
  return { ...e, user, agent, log: [...e.log, { at: now(), by: "you", op: "restore", first, last }] };
}

export function setAgentStatus(e: Edits, index: number, status: AgentStatus): Edits {
  const c = e.agent[index];
  if (!c || c.status === status) return e;
  const agent = e.agent.map((x, i) => (i === index ? { ...x, status } : x));
  const op = status === "accepted" ? "accept" : status === "restored" ? "restore" : "unreview";
  return { ...e, agent, log: [...e.log, { at: now(), by: "you", op, first: c.first, last: c.last, note: c.reason }] };
}

export function acceptAll(e: Edits): Edits {
  if (!e.agent.some((c) => c.status === "pending")) return e;
  return {
    ...e,
    agent: e.agent.map((c) => (c.status === "pending" ? { ...c, status: "accepted" as const } : c)),
    log: [...e.log, { at: now(), by: "you", op: "accept-all" }],
  };
}

export function pendingCount(e: Edits): number {
  return e.agent.filter((c) => c.status === "pending").length;
}

/** The agent cut containing word i that isn't restored, if any. */
export function agentCutAt(e: Edits, i: number): number {
  return e.agent.findIndex((c) => c.status !== "restored" && c.first <= i && i <= c.last);
}

/** Index of the word playing at source time t (or the last one before it). */
export function wordAt(words: Word[], t: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export function timecode(t: number, fps = 30, frames = false): string {
  const sign = t < 0 ? "-" : "";
  t = Math.abs(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return sign + (frames ? `${base}:${pad(Math.floor((t % 1) * fps))}` : base);
}
