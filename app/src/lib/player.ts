// Plays the cut straight from the source file, skipping removed bits.
//
// Two <video> elements take turns: while one plays a kept range, the other
// has already jumped to the start of the next one and waits, paused. At the
// cut they swap, so the seek happens off screen and joins don't stall.

import { cutDuration, cutToSource, sourceToCut } from "./edl";

export interface PlayerState {
  playing: boolean;
  time: number; // seconds into the cut
  source: number; // seconds into the recording
}

export class CutPlayer {
  private videos: [HTMLVideoElement, HTMLVideoElement];
  private active = 0;
  private index = 0;
  private raf = 0;
  private ranges: [number, number][] = [];
  playing = false;
  private quiet = false;
  onState: (s: PlayerState) => void = () => {};

  constructor(a: HTMLVideoElement, b: HTMLVideoElement) {
    this.videos = [a, b];
    for (const v of this.videos) {
      v.preload = "auto";
      v.playsInline = true;
      v.addEventListener("seeked", () => !this.playing && v === this.front && this.emit());
    }
    this.show();
  }

  private get front() {
    return this.videos[this.active];
  }

  private get back() {
    return this.videos[1 - this.active];
  }

  get duration() {
    return cutDuration(this.ranges);
  }

  get source() {
    return this.front.currentTime;
  }

  get time() {
    return sourceToCut(this.ranges, this.front.currentTime);
  }

  setRanges(ranges: [number, number][]) {
    const t = this.time;
    this.ranges = ranges;
    if (!ranges.length) {
      this.pause();
      return;
    }
    this.seek(Math.min(t, this.duration));
  }

  private show() {
    this.videos.forEach((v, i) => {
      v.style.visibility = i === this.active ? "visible" : "hidden";
      v.muted = i !== this.active || this.quiet;
    });
  }

  /** Silences the recording while one of Claude's clips plays over it. */
  setQuiet(quiet: boolean) {
    if (quiet === this.quiet) return;
    this.quiet = quiet;
    this.show();
  }

  private emit() {
    this.onState({ playing: this.playing, time: this.time, source: this.front.currentTime });
  }

  private cue() {
    const next = this.ranges[this.index + 1];
    if (next && Math.abs(this.back.currentTime - next[0]) > 0.01) this.back.currentTime = next[0];
  }

  /** Jump to a point in the cut. */
  seek(t: number) {
    if (!this.ranges.length) return;
    const { source, index } = cutToSource(this.ranges, Math.max(0, t));
    this.index = index;
    this.front.currentTime = source;
    this.cue();
    if (!this.playing) this.emit();
  }

  /** Jump to a moment in the recording, even one that was cut (to look at it). */
  seekSource(t: number) {
    this.front.currentTime = t;
    const i = this.ranges.findIndex(([, b]) => t < b);
    this.index = i < 0 ? this.ranges.length - 1 : i;
    this.cue();
    if (!this.playing) this.emit();
  }

  play() {
    if (!this.ranges.length || this.playing) return;
    if (this.time >= this.duration - 0.05) this.seek(0);
    const [a, b] = this.ranges[this.index];
    if (this.front.currentTime < a || this.front.currentTime >= b) this.front.currentTime = a;
    this.playing = true;
    void this.front.play();
    this.cue();
    this.tick();
    this.emit();
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.videos.forEach((v) => v.pause());
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  private tick = () => {
    if (!this.playing) return;
    const range = this.ranges[this.index];
    const t = this.front.currentTime;
    if (range && t >= range[1] - 0.012) {
      if (this.index + 1 >= this.ranges.length) {
        this.pause();
        return;
      }
      // Swap to the player that's already waiting at the next range.
      this.index++;
      const old = this.front;
      this.active = 1 - this.active;
      if (Math.abs(this.front.currentTime - this.ranges[this.index][0]) > 0.05) this.front.currentTime = this.ranges[this.index][0];
      void this.front.play();
      this.show();
      old.pause();
      this.cue();
    } else if (range && t < range[0] - 0.05 && !this.front.seeking) {
      this.front.currentTime = range[0];
    }
    this.emit();
    this.raf = requestAnimationFrame(this.tick);
  };

  destroy() {
    this.pause();
  }
}
