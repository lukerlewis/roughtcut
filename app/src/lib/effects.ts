// Every effect kind in one place: how it shows on the timeline, and how
// moving, keeping or removing one changes the edit. A new kind of effect
// adds a case here and appears on its own track.

import type { Effect, FxItem, FxMode, FxTrack } from "../components/Timeline";
import {
  removeClip,
  removeNote,
  removeTimed,
  setTimed,
  setTimedStatus,
  removeText,
  removeZoom,
  setClipStatus,
  setClipTimes,
  setText,
  setTextStatus,
  setZoomStatus,
  setZoomTimes,
  zoomSpan,
  type AgentStatus,
  type Edits,
  type Word,
} from "./edl";

export const LAYOUT_NAMES = { camera: "Camera", screen: "Screen", side: "Side by side" } as const;

const TEXT_NAMES = { title: "Title", "lower-third": "Lower third", callout: "Callout" } as const;

/** The effect tracks, top to bottom: Claude's clips, text, zooms. Empty ones are left out, except zooms. */
export function effectTracks(e: Edits, words: Word[]): FxTrack[] {
  const tracks: FxTrack[] = [];
  const clips: FxItem[] = (e.clips ?? []).flatMap((c, index) =>
    c.status === "restored"
      ? []
      : [{
          effect: { kind: "clip", index },
          start: c.start,
          end: c.end,
          label: c.layout
            ? `Layout: ${LAYOUT_NAMES[c.layout.mode]}`
            : c.background
              ? `Background: ${c.background.mode === "blur" ? "blurred" : c.background.mode === "color" ? "colour" : "picture"}`
              : c.reason || c.file.split("/").pop() || "Clip",
          pending: c.status === "pending",
          icon: c.layout || c.background ? ("layout" as const) : ("film" as const),
          bounds: [c.start - c.offset, c.start - c.offset + c.length] as [number, number],
        }],
  );
  if (clips.length) tracks.push({ name: "Clips", items: clips });
  const texts: FxItem[] = (e.texts ?? []).flatMap((t, index) =>
    t.status === "restored"
      ? []
      : [{ effect: { kind: "text", index }, start: t.start, end: t.end, label: `${TEXT_NAMES[t.style]}: ${t.text}`, pending: t.status === "pending", icon: "text" as const }],
  );
  if (texts.length) tracks.push({ name: "Text", items: texts });
  const speeds: FxItem[] = (e.speeds ?? []).flatMap((x, index) =>
    x.status === "restored"
      ? []
      : [{ effect: { kind: "speed", index }, start: x.start, end: x.end, label: `${x.rate}x`, pending: x.status === "pending", icon: "speed" as const }],
  );
  if (speeds.length) tracks.push({ name: "Speed", items: speeds });
  const blurs: FxItem[] = (e.blurs ?? []).flatMap((x, index) =>
    x.status === "restored"
      ? []
      : [{ effect: { kind: "blur", index }, start: x.start, end: x.end, label: x.reason || "Blur", pending: x.status === "pending", icon: "blur" as const }],
  );
  if (blurs.length) tracks.push({ name: "Blur", items: blurs });
  const zooms: FxItem[] = (e.zooms ?? []).flatMap((z, index) => {
    if (z.status === "restored") return [];
    const [start, end] = zoomSpan(words, z);
    return [{ effect: { kind: "zoom", index }, start, end, label: `Zoom ${Math.round(z.scale * 100)}%`, pending: z.status === "pending", icon: "zoom" as const }];
  });
  tracks.push({ name: "Zooms", items: zooms });
  return tracks;
}

/** Luke dragged an effect on the timeline to start..end (source seconds). */
export function moveEffect(e: Edits, words: Word[], fx: Effect, start: number, end: number, mode: FxMode): Edits {
  switch (fx.kind) {
    case "zoom":
      return setZoomTimes(e, words, fx.index, start, end);
    case "clip": {
      const c = e.clips?.[fx.index];
      if (!c) return e;
      // Trimming the left end moves where in its file the clip plays from.
      const offset = mode === "left" ? c.offset + (start - c.start) : c.offset;
      return setClipTimes(e, fx.index, start, end, offset);
    }
    case "text":
      return setText(e, fx.index, { start, end });
    case "speed":
      return setTimed(e, "speeds", fx.index, { start, end });
    case "blur":
      return setTimed(e, "blurs", fx.index, { start, end });
  }
  return e;
}

export function setEffectStatus(e: Edits, fx: Effect, status: AgentStatus): Edits {
  switch (fx.kind) {
    case "zoom":
      return setZoomStatus(e, fx.index, status);
    case "clip":
      return setClipStatus(e, fx.index, status);
    case "text":
      return setTextStatus(e, fx.index, status);
    case "speed":
      return setTimedStatus(e, "speeds", fx.index, status);
    case "blur":
      return setTimedStatus(e, "blurs", fx.index, status);
  }
  return e;
}

export function removeEffect(e: Edits, fx: Effect): Edits {
  switch (fx.kind) {
    case "zoom":
      return removeZoom(e, fx.index);
    case "clip":
      return removeClip(e, fx.index);
    case "text":
      return removeText(e, fx.index);
    case "note":
      return removeNote(e, fx.index);
    case "speed":
      return removeTimed(e, "speeds", fx.index);
    case "blur":
      return removeTimed(e, "blurs", fx.index);
  }
  return e;
}

/** Where the playhead should go to show an effect: just inside its start. */
export function effectStart(e: Edits, words: Word[], fx: Effect): number | null {
  if (fx.kind === "zoom") {
    const z = e.zooms?.[fx.index];
    return z ? zoomSpan(words, z)[0] + 0.05 : null;
  }
  if (fx.kind === "note") {
    const n = e.notes?.[fx.index];
    return n ? n.at : null;
  }
  const lists: Record<string, { start: number }[] | undefined> = { clip: e.clips, text: e.texts, speed: e.speeds, blur: e.blurs };
  const list = lists[fx.kind];
  const item = list?.[fx.index];
  return item ? item.start + 0.05 : null;
}
