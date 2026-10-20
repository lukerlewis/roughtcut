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

/** A punch-in on the words first..last: scale about the point (x, y), 0..1 of the frame.
 *  Once Luke drags it on the timeline it also has exact source times. */
export interface Zoom {
  first: number;
  last: number;
  start?: number;
  end?: number;
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

/** Source seconds Luke trimmed on the timeline: cut out, or kept (a pause or
 *  cut brought back). Applied after the word cuts, in order. */
export interface Trim {
  start: number;
  end: number;
  keep: boolean;
}

/** A video Claude made (with FFmpeg or Python) that plays instead of the
 *  recording over source seconds start..end, from `offset` seconds into its
 *  file. `file` is relative to the project folder, e.g. clips/paris.mp4. */
export interface Clip {
  file: string;
  start: number;
  end: number;
  offset: number;
  length: number; // the file's duration
  by: "you" | "agent";
  status?: AgentStatus; // Claude's clips: unreviewed until Luke keeps or removes ("restored") them
  reason?: string;
  background?: Background; // a swapped background, re-rendered when its settings change
  layout?: { mode: LayoutMode }; // another screen layout, for recordings made in Roughcut
}

export type LayoutMode = "camera" | "screen" | "side";

export interface Background {
  mode: "blur" | "color" | "image";
  strength?: number; // blur
  color?: string; // #rrggbb
  image?: string; // a picture's full path
}

/** The settings a rendered clip (background or layout) is made from. */
export type Rendered = Pick<Clip, "background" | "layout">;

/** Luke adds a rendered clip over source seconds start..end; `file` is what was rendered.
 *  Claude's clips under it are taken off, and Luke's own clips there are replaced. */
export function addRendered(e: Edits, file: string, start: number, end: number, settings: Rendered): Edits {
  const clips = (e.clips ?? [])
    .filter((c) => !(c.by === "you" && c.start < end && c.end > start))
    .map((c) => (c.status !== "restored" && c.start < end && c.end > start ? { ...c, status: "restored" as const } : c));
  const clip: Clip = { file, start, end, offset: 0, length: end - start, by: "you", ...settings };
  const note = settings.background?.mode ?? settings.layout?.mode ?? "";
  return { ...e, clips: [...clips, clip], log: [...e.log, { at: now(), by: "you", op: settings.layout ? "layout" : "background", note }] };
}

/** A rendered clip made again with new settings, over its current times. */
export function rerender(e: Edits, index: number, file: string, settings: Rendered): Edits {
  const c = e.clips?.[index];
  if (!c) return e;
  const next: Clip = { ...c, file, offset: 0, length: c.end - c.start, ...settings, status: c.by === "agent" ? "accepted" : c.status };
  return { ...e, clips: e.clips!.map((x, i) => (i === index ? next : x)), log: [...e.log, { at: now(), by: "you", op: "rerender", note: c.file }] };
}

export interface Click {
  t: number; // seconds into the recording
  x: number; // fractions of the screen
  y: number;
}

/** Zooms that follow Luke's clicks (as the Rust side's click_zooms): one per
 *  burst, centred on its clicks, left out where a zoom already is. */
export function addClickZooms(e: Edits, words: Word[], clicks: Click[], scale = 1.6): Edits {
  const bursts: { start: number; end: number; x: number; y: number; n: number }[] = [];
  for (const c of clicks) {
    const last = bursts[bursts.length - 1];
    if (last && c.t - last.end + 2 < 3) Object.assign(last, { end: c.t + 2, x: (last.x * last.n + c.x) / (last.n + 1), y: (last.y * last.n + c.y) / (last.n + 1), n: last.n + 1 });
    else bursts.push({ start: Math.max(0, c.t - 0.4), end: c.t + 2, x: c.x, y: c.y, n: 1 });
  }
  const zooms = [...(e.zooms ?? [])];
  let added = 0;
  for (const b of bursts) {
    const first = words.findIndex((w) => w.end > b.start);
    if (first < 0) continue;
    let last = first;
    while (last + 1 < words.length && words[last + 1].start < b.end) last++;
    if (zooms.some((z) => z.status !== "restored" && z.first <= last && z.last >= first)) continue;
    zooms.push({ first, last, start: b.start, end: b.end, scale, x: b.x, y: b.y, by: "you" });
    added++;
  }
  if (!added) return e;
  zooms.sort((a, b) => a.first - b.first);
  return { ...e, zooms, log: [...e.log, { at: now(), by: "you", op: "zoom-clicks", note: `${added}` }] };
}

export interface Edits {
  version: 1;
  agent: AgentCut[];
  user: Span[]; // words Luke cut himself, sorted, never overlapping
  log: Op[];
  trims?: Trim[];
  zooms?: Zoom[];
  captions?: Captions;
  clips?: Clip[];
  texts?: TextFx[];
  notes?: Note[];
  speeds?: SpeedFx[];
  blurs?: BlurFx[];
  voice?: Voice;
  /** Play every pause, start to end, as recorded. True until a rough cut tightens them. */
  keepPauses?: boolean;
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
    ...(d.by === "none" ? { keepPauses: true } : {}),
  };
}

/** Luke asks for a rough cut: Claude's new cuts replace its unreviewed ones,
 *  skipping words he already kept or restored, and pauses get tightened. */
export function applyRoughCut(e: Edits, d: Decisions): Edits {
  const reviewed = e.agent.filter((c) => c.status !== "pending");
  const fresh = d.cuts
    .filter((c) => !reviewed.some((r) => r.first <= c.to && r.last >= c.from))
    .map((c) => ({ first: c.from, last: c.to, reason: c.reason, status: "pending" as const }));
  const agent = [...reviewed, ...fresh].sort((a, b) => a.first - b.first);
  return { ...e, agent, keepPauses: false, log: [...e.log, { at: now(), by: "agent", op: "rough-cut", note: d.summary }] };
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
export function keptRanges(words: Word[], keep: Set<number>, duration: number, p: Params = PARAMS): Range[] {
  const ranges: Range[] = [];
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

/** The ranges with Luke's timeline trims applied. */
export function applyTrims(ranges: Range[], trims: Trim[], duration: number): Range[] {
  let out: Range[] = ranges.map(([a, b]) => [a, b]);
  for (const t of trims) {
    const [s, e] = [Math.max(0, t.start), Math.min(duration, t.end)];
    if (e <= s) continue;
    if (t.keep) {
      out.push([s, e]);
      out.sort((x, y) => x[0] - y[0]);
      const merged: Range[] = [];
      for (const r of out) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], r[1]);
        else merged.push([r[0], r[1]]);
      }
      out = merged;
    } else
      out = out.flatMap(([a, b]): Range[] =>
        e <= a || s >= b ? [[a, b]] : ([[a, s], [e, b]] as Range[]).filter(([x, y]) => y - x > 0.001),
      );
  }
  return out.filter(([a, b]) => b - a >= 0.04);
}

/** What plays: the kept words' ranges with Luke's trims applied. */
export function editRanges(words: Word[], e: Edits, duration: number): Range[] {
  const keep = keptSet(words.length, e);
  let ranges = keptRanges(words, keep, duration, e.keepPauses ? { ...PARAMS, maxPause: Infinity } : PARAMS);
  if (e.keepPauses && ranges.length) {
    // Nothing tightened yet: the silence before the first word and after the last one plays too.
    if (keep.has(0)) ranges[0][0] = 0;
    if (keep.has(words.length - 1)) ranges[ranges.length - 1][1] = duration;
  }
  return applySpeeds(applyTrims(ranges, e.trims ?? [], duration), liveSpeeds(e));
}

/** Splits the ranges where a speed-up starts or ends, so each piece has one rate. */
export function applySpeeds(ranges: Range[], speeds: SpeedFx[]): Range[] {
  if (!speeds.length) return ranges;
  const out: Range[] = [];
  for (const [a, b] of ranges) {
    const points = new Set([a, b]);
    for (const s of speeds) for (const t of [s.start, s.end]) if (t > a && t < b) points.add(t);
    const sorted = [...points].sort((x, y) => x - y);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const [s, t] = [sorted[i], sorted[i + 1]];
      if (t - s < 0.001) continue;
      const mid = (s + t) / 2;
      const rate = speeds.find((x) => x.start <= mid && mid <= x.end)?.rate;
      out.push(rate && rate !== 1 ? [s, t, rate] : [s, t]);
    }
  }
  return out;
}

/** Who cut each word, as the transcript shows it: a word a trim took out reads
 *  as Luke's cut, and one a trim brought back reads as kept. */
export function shownKinds(words: Word[], e: Edits, ranges: Range[]): CutKind[] {
  const kinds = cutKinds(words.length, e);
  if (!e.trims?.length) return kinds;
  let r = 0;
  return kinds.map((k, i) => {
    const mid = (words[i].start + words[i].end) / 2;
    while (r < ranges.length && ranges[r][1] < mid) r++;
    const plays = r < ranges.length && ranges[r][0] <= mid;
    return plays ? null : (k ?? "user");
  });
}

/** Luke drags a clip's edges on the timeline: clip `index` of `ranges` now
 *  runs from start to end (source seconds). */
export function trimClip(e: Edits, ranges: Range[], index: number, start: number, end: number): Edits {
  const [a, b] = ranges[index];
  const trims: Trim[] = [];
  if (start > a + 1e-4) trims.push({ start: a, end: start, keep: false });
  if (start < a - 1e-4) trims.push({ start, end: a, keep: true });
  if (end < b - 1e-4) trims.push({ start: end, end: b, keep: false });
  if (end > b + 1e-4) trims.push({ start: b, end, keep: true });
  if (!trims.length) return e;
  return { ...e, trims: [...(e.trims ?? []), ...trims], log: [...e.log, { at: now(), by: "you", op: "trim", note: `${start.toFixed(2)}-${end.toFixed(2)}` }] };
}

/** Luke selects a clip on the timeline and deletes it. */
export function deleteClip(e: Edits, ranges: Range[], index: number): Edits {
  const [a, b] = ranges[index];
  return {
    ...e,
    trims: [...(e.trims ?? []), { start: a, end: b, keep: false }],
    log: [...e.log, { at: now(), by: "you", op: "delete-clip", note: `${a.toFixed(2)}-${b.toFixed(2)}` }],
  };
}

/** Luke deletes a pause (or any span) on the timeline: source seconds start..end. */
export function cutSpan(e: Edits, start: number, end: number): Edits {
  return {
    ...e,
    trims: [...(e.trims ?? []), { start, end, keep: false }],
    log: [...e.log, { at: now(), by: "you", op: "cut-pause", note: `${start.toFixed(2)}-${end.toFixed(2)}` }],
  };
}

/** Drops timeline trims over start..end, so cutting or restoring those words
 *  in the transcript does what it says. */
export function clearTrims(e: Edits, start: number, end: number): Edits {
  if (!e.trims?.length) return e;
  const trims = e.trims.flatMap((t): Trim[] =>
    t.end <= start || t.start >= end
      ? [t]
      : [
          ...(t.start < start ? [{ ...t, end: start }] : []),
          ...(t.end > end ? [{ ...t, start: end }] : []),
        ],
  );
  return { ...e, trims };
}

/** A kept stretch of the recording, source seconds a..b, played at `rate` (1 if left out). */
export type Range = [number, number, number?];

const len = ([a, b, r]: Range) => (b - a) / (r || 1);

export function cutDuration(ranges: Range[]): number {
  return ranges.reduce((s, r) => s + len(r), 0);
}

/** Where a source time lands in the cut; a removed moment maps to the next kept frame. */
export function sourceToCut(ranges: Range[], t: number): number {
  let acc = 0;
  for (const r of ranges) {
    const [a, b, rate] = r;
    if (t < a) return acc;
    if (t <= b) return acc + (t - a) / (rate || 1);
    acc += len(r);
  }
  return acc;
}

/** The source time shown at a point in the cut, plus which range it's in. */
export function cutToSource(ranges: Range[], t: number): { source: number; index: number } {
  let acc = 0;
  for (let i = 0; i < ranges.length; i++) {
    const [a, b, rate] = ranges[i];
    if (t < acc + len(ranges[i]) || i === ranges.length - 1) return { source: Math.min(b, a + Math.max(0, t - acc) * (rate || 1)), index: i };
    acc += len(ranges[i]);
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

/** The lists of effects Claude can add, each reviewed like its cuts. */
export const EFFECT_LISTS = ["zooms", "clips", "texts", "speeds", "blurs"] as const;
export type EffectList = (typeof EFFECT_LISTS)[number];

export function acceptAll(e: Edits): Edits {
  if (pendingCount(e) === 0) return e;
  const keep = <T extends { status?: AgentStatus }>(xs?: T[]) => xs?.map((x) => (x.status === "pending" ? { ...x, status: "accepted" as const } : x));
  const next: Edits = { ...e, agent: keep(e.agent)!, log: [...e.log, { at: now(), by: "you", op: "accept-all" }] };
  for (const k of EFFECT_LISTS) if (e[k]) (next as any)[k] = keep(e[k] as { status?: AgentStatus }[]);
  return next;
}

export function pendingCount(e: Edits): number {
  const pending = (x: { status?: AgentStatus }) => x.status === "pending";
  return e.agent.filter(pending).length + EFFECT_LISTS.reduce((n, k) => n + ((e[k] ?? []) as { status?: AgentStatus }[]).filter(pending).length, 0);
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

/** The source time a zoom covers: where Luke put it, or its words padded like a kept range. */
export function zoomSpan(words: Word[], z: Zoom, p: Params = PARAMS): [number, number] {
  if (z.start !== undefined && z.end !== undefined) return [z.start, z.end];
  return [words[z.first].start - p.padIn, words[z.last].end + p.padOut];
}

/** Luke drags a zoom on the timeline to exact source times. Its words become
 *  the ones it now covers. A zoom of Claude's he adjusts counts as reviewed. */
export function setZoomTimes(e: Edits, words: Word[], index: number, start: number, end: number): Edits {
  const z = e.zooms?.[index];
  if (!z || end - start < 0.05) return e;
  const [a, b] = zoomSpan(words, z);
  if (Math.abs(a - start) < 1e-4 && Math.abs(b - end) < 1e-4) return e;
  const inside = words.flatMap((w, i) => (w.end > start && w.start < end ? [i] : []));
  const first = inside[0] ?? Math.max(0, wordAt(words, start));
  const last = inside[inside.length - 1] ?? first;
  const status = z.by === "agent" ? ("accepted" as const) : z.status;
  const zooms = e.zooms!.map((x, i) => (i === index ? { ...x, first, last, start, end, status } : x));
  return { ...e, zooms, log: [...e.log, { at: now(), by: "you", op: "move-zoom", first, last }] };
}

export interface Segment {
  start: number; // seconds into the recording, or into `file` when set
  end: number;
  zoom: { scale: number; x: number; y: number } | null;
  file?: string; // one of Claude's clips playing instead of the recording
  speed?: number; // played faster, pitch kept
  blur?: Rect[]; // boxes blurred out
}

/** The kept ranges split wherever a zoom or clip starts or ends, for export.
 *  Pieces under a clip play from the clip's file. */
export function segments(ranges: Range[], words: Word[], zooms: Zoom[], clips: Clip[] = [], folder = "", blurs: BlurFx[] = []): Segment[] {
  const spans = zooms.map((z) => ({ span: zoomSpan(words, z), zoom: { scale: z.scale, x: z.x, y: z.y } }));
  const pieces: (Segment & { clip: number })[] = [];
  const live = blurs.filter((x) => x.status !== "restored");
  for (const [a, b, rate] of ranges) {
    const cuts = new Set([a, b]);
    for (const { span } of spans) for (const t of span) if (t > a && t < b) cuts.add(t);
    for (const c of clips) for (const t of [c.start, c.end]) if (t > a && t < b) cuts.add(t);
    for (const x of live) for (const t of [x.start, x.end]) if (t > a && t < b) cuts.add(t);
    const points = [...cuts].sort((x, y) => x - y);
    for (let i = 0; i + 1 < points.length; i++) {
      const [s, t] = [points[i], points[i + 1]];
      const mid = (s + t) / 2;
      const z = spans.find(({ span }) => span[0] <= mid && mid <= span[1]);
      const clip = clips.findIndex((c) => c.start <= mid && mid <= c.end);
      const blur = live.filter((x) => x.start <= mid && mid <= x.end).map(({ x, y, w, h }) => ({ x, y, w, h }));
      const piece: Segment & { clip: number } = { start: s, end: t, zoom: z?.zoom ?? null, clip };
      if (rate && rate !== 1) piece.speed = rate;
      if (blur.length) piece.blur = blur;
      const last = pieces[pieces.length - 1];
      // Merge with the previous piece if nothing changes between them.
      const same = (p: Segment & { clip: number }) => JSON.stringify({ ...p, start: 0, end: 0 });
      if (last && last.end === s && same(last) === same(piece)) last.end = t;
      else pieces.push(piece);
    }
  }
  return pieces.map(({ clip, ...p }) => {
    if (clip < 0) return p;
    const c = clips[clip];
    const at = (t: number) => Math.min(c.length, c.offset + (t - c.start));
    return { ...p, start: at(p.start), end: at(p.end), file: `${folder}/${c.file}` };
  });
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
export function captionCues(words: Word[], keep: Set<number>, ranges: Range[]): Cue[] {
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

// --- Claude's clips --------------------------------------------------------

/** Clips that are on screen: everything except Claude's that Luke removed. */
export function liveClips(e: Edits): Clip[] {
  return (e.clips ?? []).filter((c) => c.status !== "restored");
}

/** The clip playing at source time t, if any. */
export function clipAt(clips: Clip[], t: number): Clip | null {
  return clips.find((c) => c.start <= t && t < c.end) ?? null;
}

export function setClipStatus(e: Edits, index: number, status: AgentStatus): Edits {
  const c = e.clips?.[index];
  if (!c || c.status === status) return e;
  const clips = e.clips!.map((x, i) => (i === index ? { ...x, status } : x));
  const op = status === "accepted" ? "accept-clip" : status === "restored" ? "remove-clip" : "unreview-clip";
  return { ...e, clips, log: [...e.log, { at: now(), by: "you", op, note: c.file }] };
}

/** Luke drags a clip on the timeline: it now covers source start..end and
 *  plays from `offset` into its file. Moving it keeps the offset; trimming its
 *  left edge moves the offset with it. A clip of Claude's he adjusts counts as kept. */
export function setClipTimes(e: Edits, index: number, start: number, end: number, offset: number): Edits {
  const c = e.clips?.[index];
  if (!c || end - start < 0.05 || offset < -1e-6 || offset + (end - start) > c.length + 1e-3) return e;
  if (Math.abs(c.start - start) < 1e-4 && Math.abs(c.end - end) < 1e-4 && Math.abs(c.offset - offset) < 1e-4) return e;
  const status = c.by === "agent" ? ("accepted" as const) : c.status;
  const clips = e.clips!.map((x, i) => (i === index ? { ...x, start, end, offset: Math.max(0, offset), status } : x));
  return { ...e, clips, log: [...e.log, { at: now(), by: "you", op: "move-clip", note: `${c.file} ${start.toFixed(2)}-${end.toFixed(2)}` }] };
}

/** Luke deletes a clip: Claude's are kept as removed so it won't add them back. */
export function removeClip(e: Edits, index: number): Edits {
  const c = e.clips?.[index];
  if (!c) return e;
  const clips = c.by === "agent" ? e.clips!.map((x, i) => (i === index ? { ...x, status: "restored" as const } : x)) : e.clips!.filter((_, i) => i !== index);
  return { ...e, clips, log: [...e.log, { at: now(), by: "you", op: "remove-clip", note: c.file }] };
}

// --- Word blocks on the timeline -------------------------------------------

/** A piece of a kept range: one word, or a pause long enough to be worth its own block. */
export type Block = { word: number; start: number; end: number } | { word: null; start: number; end: number };

export const PAUSE_BLOCK = 0.3; // seconds of quiet that get their own block

/** Each kept range split into one block per word, with longer pauses as
 *  blocks of their own. Blocks tile the range exactly (source seconds). */
export function blocks(ranges: Range[], words: Word[]): Block[][] {
  return ranges.map(([a, b]) => {
    const inside = words.flatMap((w, i) => {
      const mid = (w.start + w.end) / 2;
      return mid >= a && mid <= b ? [i] : [];
    });
    if (!inside.length) return [{ word: null, start: a, end: b }];
    const out: Block[] = [];
    let at = a;
    const pause = (to: number) => {
      if (to - at >= PAUSE_BLOCK) {
        out.push({ word: null, start: at, end: to - 0.04 });
        at = to - 0.04;
      }
    };
    inside.forEach((i, k) => {
      const w = words[i];
      const next = inside[k + 1];
      pause(Math.max(at, w.start));
      let end: number;
      if (next === undefined) end = b - w.end >= PAUSE_BLOCK ? Math.min(b, w.end + 0.04) : b;
      else {
        const gap = words[next].start - w.end;
        end = gap >= PAUSE_BLOCK ? w.end + 0.04 : w.end + Math.max(0, gap) / 2;
      }
      end = Math.min(b, Math.max(end, at + 0.01));
      out.push({ word: i, start: at, end });
      at = end;
    });
    if (b - at > 1e-6) out.push({ word: null, start: at, end: b });
    return out;
  });
}

// --- Effect settings -------------------------------------------------------

/** Luke changes a zoom's amount or where it points (x, y: 0..1 of the frame).
 *  A zoom of Claude's he adjusts counts as kept. */
export function setZoomLook(e: Edits, index: number, look: { scale?: number; x?: number; y?: number }): Edits {
  const z = e.zooms?.[index];
  if (!z) return e;
  const next = {
    ...z,
    scale: Math.min(3, Math.max(1.05, look.scale ?? z.scale)),
    x: Math.min(1, Math.max(0, look.x ?? z.x)),
    y: Math.min(1, Math.max(0, look.y ?? z.y)),
    status: z.by === "agent" ? ("accepted" as const) : z.status,
  };
  if (next.scale === z.scale && next.x === z.x && next.y === z.y) return e;
  const zooms = e.zooms!.map((x, i) => (i === index ? next : x));
  return { ...e, zooms, log: [...e.log, { at: now(), by: "you", op: "zoom-look", first: z.first, last: z.last, note: `${Math.round(next.scale * 100)}% at ${next.x.toFixed(2)},${next.y.toFixed(2)}` }] };
}

/** Luke deletes one zoom. Claude's is kept as removed so it won't add it back. */
export function removeZoom(e: Edits, index: number): Edits {
  const z = e.zooms?.[index];
  if (!z) return e;
  const zooms = z.by === "agent" ? e.zooms!.map((x, i) => (i === index ? { ...x, status: "restored" as const } : x)) : e.zooms!.filter((_, i) => i !== index);
  return { ...e, zooms, log: [...e.log, { at: now(), by: "you", op: "unzoom", first: z.first, last: z.last }] };
}

/** The part of the frame a zoom shows, as fractions: scale s about the point
 *  (x, y) shows a box 1/s wide whose left edge is x(1 - 1/s). */
export function zoomBox(z: { scale: number; x: number; y: number }) {
  const size = 1 / z.scale;
  return { left: z.x * (1 - size), top: z.y * (1 - size), size };
}

/** The point to zoom about so the box's top-left corner lands at (left, top). */
export function zoomPointFor(scale: number, left: number, top: number) {
  const room = 1 - 1 / scale;
  return { x: room > 0 ? Math.min(1, Math.max(0, left / room)) : 0.5, y: room > 0 ? Math.min(1, Math.max(0, top / room)) : 0.5 };
}

// --- Text: titles, lower thirds and callouts ---------------------------------

export type TextStyle = "title" | "lower-third" | "callout";

/** Words on screen over source seconds start..end. x, y place it (0..1 of the
 *  frame): a title's centre, a lower third's left edge and baseline, the
 *  point a callout marks. size is its text height as a fraction of the frame. */
export interface TextFx {
  style: TextStyle;
  text: string;
  sub?: string; // second line: a lower third's role, a title's subtitle
  start: number;
  end: number;
  x: number;
  y: number;
  size: number;
  look?: "plain" | "box"; // white text with a shadow, or dark text on a white box
  by: "you" | "agent";
  status?: AgentStatus;
  reason?: string;
}

export const TEXT_DEFAULTS: Record<TextStyle, Pick<TextFx, "x" | "y" | "size" | "look">> = {
  title: { x: 0.5, y: 0.45, size: 0.08, look: "plain" },
  "lower-third": { x: 0.06, y: 0.8, size: 0.045, look: "box" },
  callout: { x: 0.6, y: 0.4, size: 0.035, look: "box" },
};

export function liveTexts(e: Edits): TextFx[] {
  return (e.texts ?? []).filter((t) => t.status !== "restored");
}

/** Luke adds text at source seconds start..end. */
export function addText(e: Edits, style: TextStyle, text: string, start: number, end: number): Edits {
  const t: TextFx = { style, text, start, end, ...TEXT_DEFAULTS[style], by: "you" };
  return { ...e, texts: [...(e.texts ?? []), t], log: [...e.log, { at: now(), by: "you", op: "text", note: `${style}: ${text}` }] };
}

/** Luke changes a text's words, place, size, look or times. Claude's counts as kept once he does. */
export function setText(e: Edits, index: number, patch: Partial<Omit<TextFx, "by">>): Edits {
  const t = e.texts?.[index];
  if (!t) return e;
  const next = { ...t, ...patch, status: t.by === "agent" ? ("accepted" as const) : t.status };
  if (next.end - next.start < 0.05) return e;
  if (JSON.stringify(next) === JSON.stringify(t)) return e;
  const texts = e.texts!.map((x, i) => (i === index ? next : x));
  return { ...e, texts, log: [...e.log, { at: now(), by: "you", op: "edit-text", note: next.text }] };
}

export function setTextStatus(e: Edits, index: number, status: AgentStatus): Edits {
  const t = e.texts?.[index];
  if (!t || t.status === status) return e;
  const texts = e.texts!.map((x, i) => (i === index ? { ...x, status } : x));
  return { ...e, texts, log: [...e.log, { at: now(), by: "you", op: `${status}-text`, note: t.text }] };
}

/** Luke deletes a text. Claude's is kept as removed so it won't add it back. */
export function removeText(e: Edits, index: number): Edits {
  const t = e.texts?.[index];
  if (!t) return e;
  const texts = t.by === "agent" ? e.texts!.map((x, i) => (i === index ? { ...x, status: "restored" as const } : x)) : e.texts!.filter((_, i) => i !== index);
  return { ...e, texts, log: [...e.log, { at: now(), by: "you", op: "remove-text", note: t.text }] };
}

// --- Notes -----------------------------------------------------------------
// Luke's notes pinned to moments, for himself or for Claude to work through.
// Claude marks one done with a short reply; it can also leave one for Luke.

export interface Note {
  at: number; // source seconds
  text: string;
  by: "you" | "agent";
  done?: boolean;
  reply?: string; // Claude's answer when it dealt with it
}

export function addNote(e: Edits, at: number, text = ""): Edits {
  return { ...e, notes: [...(e.notes ?? []), { at, text, by: "you" }], log: [...e.log, { at: now(), by: "you", op: "note", note: text }] };
}

export function setNote(e: Edits, index: number, patch: Partial<Omit<Note, "by">>): Edits {
  const n = e.notes?.[index];
  if (!n) return e;
  const next = { ...n, ...patch };
  if (JSON.stringify(next) === JSON.stringify(n)) return e;
  const notes = e.notes!.map((x, i) => (i === index ? next : x));
  return { ...e, notes, log: [...e.log, { at: now(), by: "you", op: "edit-note", note: next.text }] };
}

export function removeNote(e: Edits, index: number): Edits {
  const n = e.notes?.[index];
  if (!n) return e;
  return { ...e, notes: e.notes!.filter((_, i) => i !== index), log: [...e.log, { at: now(), by: "you", op: "remove-note", note: n.text }] };
}

/** Notes still to deal with: Luke's that have words and aren't done. */
export function openNotes(e: Edits): { note: Note; index: number }[] {
  return (e.notes ?? []).flatMap((note, index) => (note.by === "you" && !note.done && note.text.trim() ? [{ note, index }] : []));
}

// --- Speed-ups, blurs and voice ----------------------------------------------

export interface Rect {
  x: number; // fractions of the frame
  y: number;
  w: number;
  h: number;
}

/** Source seconds start..end played faster. */
export interface SpeedFx {
  start: number;
  end: number;
  rate: number;
  by: "you" | "agent";
  status?: AgentStatus;
  reason?: string;
}

/** A box of the frame blurred out over source seconds start..end. */
export interface BlurFx extends Rect {
  start: number;
  end: number;
  by: "you" | "agent";
  status?: AgentStatus;
  reason?: string;
}

/** Polish for the whole voice track, applied on export. */
export interface Voice {
  level?: boolean; // even loudness
  clean?: boolean; // less hiss and rumble
}

type Timed = { start: number; end: number; by: "you" | "agent"; status?: AgentStatus };
type TimedList = "speeds" | "blurs";

export function liveSpeeds(e: Edits): SpeedFx[] {
  return (e.speeds ?? []).filter((s) => s.status !== "restored");
}

export function liveBlurs(e: Edits): BlurFx[] {
  return (e.blurs ?? []).filter((s) => s.status !== "restored");
}

export function addSpeed(e: Edits, start: number, end: number, rate = 1.5): Edits {
  const speeds = (e.speeds ?? []).filter((s) => s.status === "restored" || s.end <= start || s.start >= end);
  return { ...e, speeds: [...speeds, { start, end, rate, by: "you" }], log: [...e.log, { at: now(), by: "you", op: "speed", note: `${rate}x` }] };
}

export function addBlur(e: Edits, start: number, end: number, box: Rect = { x: 0.35, y: 0.3, w: 0.3, h: 0.3 }): Edits {
  return { ...e, blurs: [...(e.blurs ?? []), { start, end, ...box, by: "you" }], log: [...e.log, { at: now(), by: "you", op: "blur", note: "" }] };
}

/** Luke changes a speed-up or blur (times, rate, box). Claude's counts as kept once he does. */
export function setTimed<K extends TimedList>(e: Edits, list: K, index: number, patch: Partial<NonNullable<Edits[K]>[number]>): Edits {
  const items = (e[list] ?? []) as Timed[];
  const item = items[index];
  if (!item) return e;
  const next = { ...item, ...patch, status: item.by === "agent" ? ("accepted" as const) : item.status };
  if (next.end - next.start < 0.05) return e;
  if (JSON.stringify(next) === JSON.stringify(item)) return e;
  return { ...e, [list]: items.map((x, i) => (i === index ? next : x)), log: [...e.log, { at: now(), by: "you", op: `edit-${list}`, note: "" }] };
}

export function setTimedStatus(e: Edits, list: TimedList, index: number, status: AgentStatus): Edits {
  const items = (e[list] ?? []) as Timed[];
  const item = items[index];
  if (!item || item.status === status) return e;
  return { ...e, [list]: items.map((x, i) => (i === index ? { ...x, status } : x)), log: [...e.log, { at: now(), by: "you", op: `${status}-${list}`, note: "" }] };
}

/** Removes one. Claude's is kept as removed so it won't add it back. */
export function removeTimed(e: Edits, list: TimedList, index: number): Edits {
  const items = (e[list] ?? []) as Timed[];
  const item = items[index];
  if (!item) return e;
  const next = item.by === "agent" ? items.map((x, i) => (i === index ? { ...x, status: "restored" as const } : x)) : items.filter((_, i) => i !== index);
  return { ...e, [list]: next, log: [...e.log, { at: now(), by: "you", op: `remove-${list}`, note: "" }] };
}

export function setVoice(e: Edits, voice: Voice): Edits {
  if (JSON.stringify(voice) === JSON.stringify(e.voice ?? {})) return e;
  return { ...e, voice, log: [...e.log, { at: now(), by: "you", op: "voice", note: JSON.stringify(voice) }] };
}
