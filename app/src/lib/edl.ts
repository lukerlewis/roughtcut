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

/** A punch-in on the words first..last: scale about the point (x, y), 0..1 of the frame. */
export interface Zoom {
  first: number;
  last: number;
  scale: number;
  x: number;
  y: number;
  by: "you" | "agent";
  status?: AgentStatus; // Claude's zooms: unreviewed until Luke keeps or removes ("restored") them
  reason?: string;
}

export type CaptionStyle = "bold" | "clean";

export interface Captions {
  on: boolean;
  style: CaptionStyle;
}

export interface Edits {
  version: 1;
  agent: AgentCut[];
  user: Span[]; // words Luke cut himself, sorted, never overlapping
  log: Op[];
  zooms?: Zoom[];
  captions?: Captions;
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
  if (pendingCount(e) === 0) return e;
  return {
    ...e,
    agent: e.agent.map((c) => (c.status === "pending" ? { ...c, status: "accepted" as const } : c)),
    zooms: e.zooms?.map((z) => (z.status === "pending" ? { ...z, status: "accepted" as const } : z)),
    log: [...e.log, { at: now(), by: "you", op: "accept-all" }],
  };
}

export function pendingCount(e: Edits): number {
  return e.agent.filter((c) => c.status === "pending").length + (e.zooms ?? []).filter((z) => z.status === "pending").length;
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

// --- Zooms ---------------------------------------------------------------

export const ZOOM = { scale: 1.3, x: 0.5, y: 0.4 }; // a punch-in centred a little above the middle, on the face

/** Zooms that are on screen: everything except Claude's that Luke removed. */
export function liveZooms(e: Edits): Zoom[] {
  return (e.zooms ?? []).filter((z) => z.status !== "restored");
}

/** Luke zooms in on first..last, replacing any zoom it overlaps. */
export function addZoom(e: Edits, first: number, last: number): Edits {
  const zooms = (e.zooms ?? []).filter((z) => z.status === "restored" || z.last < first || z.first > last);
  zooms.push({ first, last, ...ZOOM, by: "you" });
  zooms.sort((a, b) => a.first - b.first);
  return { ...e, zooms, log: [...e.log, { at: now(), by: "you", op: "zoom", first, last }] };
}

/** Takes away zooms overlapping first..last. Claude's are kept as removed, so it won't re-add them. */
export function removeZooms(e: Edits, first: number, last: number): Edits {
  const hit = (z: Zoom) => z.status !== "restored" && z.first <= last && z.last >= first;
  if (!(e.zooms ?? []).some(hit)) return e;
  const zooms = (e.zooms ?? []).flatMap((z) => (!hit(z) ? [z] : z.by === "agent" ? [{ ...z, status: "restored" as const }] : []));
  return { ...e, zooms, log: [...e.log, { at: now(), by: "you", op: "unzoom", first, last }] };
}

export function setZoomStatus(e: Edits, index: number, status: AgentStatus): Edits {
  const z = e.zooms?.[index];
  if (!z || z.status === status) return e;
  const zooms = e.zooms!.map((x, i) => (i === index ? { ...x, status } : x));
  const op = status === "accepted" ? "accept-zoom" : status === "restored" ? "remove-zoom" : "unreview-zoom";
  return { ...e, zooms, log: [...e.log, { at: now(), by: "you", op, first: z.first, last: z.last }] };
}

/** Luke drags a zoom's edges or moves it on the timeline. A zoom of Claude's
 *  he adjusts counts as reviewed. */
export function moveZoom(e: Edits, index: number, first: number, last: number): Edits {
  const z = e.zooms?.[index];
  if (!z || (z.first === first && z.last === last) || first > last) return e;
  const status = z.by === "agent" ? ("accepted" as const) : z.status;
  const zooms = e.zooms!.map((x, i) => (i === index ? { ...x, first, last, status } : x));
  return { ...e, zooms, log: [...e.log, { at: now(), by: "you", op: "move-zoom", first, last }] };
}

/** The source time a zoom covers: its words, padded like a kept range. */
export function zoomSpan(words: Word[], z: Zoom, p: Params = PARAMS): [number, number] {
  return [words[z.first].start - p.padIn, words[z.last].end + p.padOut];
}

export interface Segment {
  start: number; // source seconds
  end: number;
  zoom: { scale: number; x: number; y: number } | null;
}

/** The kept ranges split wherever a zoom starts or ends, for export. */
export function segments(ranges: [number, number][], words: Word[], zooms: Zoom[]): Segment[] {
  const spans = zooms.map((z) => ({ span: zoomSpan(words, z), zoom: { scale: z.scale, x: z.x, y: z.y } }));
  const out: Segment[] = [];
  for (const [a, b] of ranges) {
    const cuts = new Set([a, b]);
    for (const { span } of spans) for (const t of span) if (t > a && t < b) cuts.add(t);
    const points = [...cuts].sort((x, y) => x - y);
    for (let i = 0; i + 1 < points.length; i++) {
      const [s, t] = [points[i], points[i + 1]];
      const mid = (s + t) / 2;
      const z = spans.find(({ span }) => span[0] <= mid && mid <= span[1]);
      const last = out[out.length - 1];
      // Merge with the previous piece if nothing changes between them.
      if (last && last.end === s && JSON.stringify(last.zoom) === JSON.stringify(z?.zoom ?? null)) last.end = t;
      else out.push({ start: s, end: t, zoom: z?.zoom ?? null });
    }
  }
  return out;
}

/** The zoom showing at source time t, if any. */
export function zoomAt(words: Word[], zooms: Zoom[], t: number): Zoom | null {
  return zooms.find((z) => {
    const [a, b] = zoomSpan(words, z);
    return a <= t && t <= b;
  }) ?? null;
}

// --- Captions --------------------------------------------------------------

export interface Cue {
  start: number; // seconds into the cut
  end: number;
  words: string[];
  active: number; // the word being said, highlighted in the bold style
}

const MAX_WORDS = 5;
const MAX_CHARS = 28;

/** Kept words grouped into short lines, one cue per word so the spoken word
 *  can be highlighted. Lines break at sentence ends, pauses, cuts and length. */
export function captionCues(words: Word[], keep: Set<number>, ranges: [number, number][]): Cue[] {
  const spoken = [...keep].sort((a, b) => a - b).filter((i) => !words[i].text.startsWith("["));
  const lines: number[][] = [];
  spoken.forEach((i, k) => {
    const line = lines[lines.length - 1];
    const prev = spoken[k - 1];
    const chars = line ? line.reduce((n, j) => n + words[j].text.length + 1, 0) + words[i].text.length : 0;
    const breaks =
      !line ||
      prev !== i - 1 || // a cut in between
      words[i].start - words[prev].end > 0.6 ||
      /[.?!,;:]$/.test(words[prev].text) ||
      line.length >= MAX_WORDS ||
      chars > MAX_CHARS;
    if (breaks) lines.push([i]);
    else line.push(i);
  });
  const total = cutDuration(ranges);
  const at = (t: number) => sourceToCut(ranges, t);
  const cues: Cue[] = [];
  lines.forEach((line, l) => {
    const nextLine = lines[l + 1];
    const lineEnd = Math.min(at(words[line[line.length - 1]].end) + 0.4, nextLine ? at(words[nextLine[0]].start) : total);
    line.forEach((i, k) => {
      const start = at(words[i].start);
      const end = k + 1 < line.length ? at(words[line[k + 1]].start) : lineEnd;
      if (end > start) cues.push({ start, end, words: line.map((j) => words[j].text), active: k });
    });
  });
  return cues;
}

export function cueAt(cues: Cue[], t: number): Cue | null {
  return cues.find((c) => c.start <= t && t < c.end) ?? null;
}

export function setCaptions(e: Edits, captions: Captions): Edits {
  return { ...e, captions, log: [...e.log, { at: now(), by: "you", op: captions.on ? `captions-${captions.style}` : "captions-off" }] };
}
