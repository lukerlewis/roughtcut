// Copies a curated set of HyperFrames catalogue graphics (Apache-2.0) and the
// HyperFrames runtime and GSAP into app/graphics (one folder per graphic, plus lib/), which ships inside the app.
//
//   node scripts/vendor-hyperframes.mjs <hyperframes checkout> <@hyperframes/core package dir> <gsap package dir>
//
// Each graphic's GSAP script tag is pointed at the local copy so graphics
// work offline and render without reaching a CDN.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const [repo, core, gsap] = process.argv.slice(2);
if (!repo || !core || !gsap) throw new Error("usage: vendor-hyperframes.mjs <repo> <core pkg> <gsap pkg>");
const out = join(dirname(new URL(import.meta.url).pathname), "..", "graphics");

// [name, group] in the order the Library shows them.
const PICKS = [
  ["lt-clean-bar", "Lower thirds"], ["lt-dark-card", "Lower thirds"], ["lt-soft-pill", "Lower thirds"], ["lt-mask-reveal", "Lower thirds"],
  ["lt-accent-underline", "Lower thirds"], ["lt-kicker-name", "Lower thirds"], ["lt-side-rule", "Lower thirds"], ["lt-bold-block", "Lower thirds"],
  ["lt-color-block", "Lower thirds"], ["lt-stack-bars", "Lower thirds"], ["lower-third-bild", "Lower thirds"], ["yt-lower-third", "Lower thirds"], ["news-ticker", "Lower thirds"],
  ["yt-prism-title", "Titles"], ["yt-logo-intro", "Titles"], ["hw-title", "Titles"], ["hw-write-title", "Titles"], ["weight-wave", "Titles"], ["logo-outro", "Titles"],
  ["mk-progress-stat", "Numbers and charts"], ["mk-line-graph", "Numbers and charts"], ["data-chart", "Numbers and charts"], ["bar-chart-race", "Numbers and charts"], ["split-flap-board", "Numbers and charts"],
  ["mk-specs-list", "Lists and diagrams"], ["mk-callout-highlight", "Lists and diagrams"], ["flowchart", "Lists and diagrams"], ["hw-pipeline", "Lists and diagrams"], ["hw-text-cloud", "Lists and diagrams"],
  ["code-typing", "Code"], ["code-diff", "Code"], ["code-highlight", "Code"], ["code-scroll", "Code"],
  ["x-post", "Social and apps"], ["reddit-post", "Social and apps"], ["yt-comment-card", "Social and apps"], ["macos-notification", "Social and apps"], ["notification-cascade", "Social and apps"],
  ["instagram-follow", "Social and apps"], ["tiktok-follow", "Social and apps"], ["spotify-card", "Social and apps"], ["claude-exchange", "Social and apps"], ["chatgpt-exchange", "Social and apps"], ["ai-chat-reveal", "Social and apps"],
  ["snow", "Overlays"], ["starfield", "Overlays"], ["camcorder-hud", "Overlays"], ["editorial-flash-overlay", "Overlays"], ["organic-light-leak-overlay", "Overlays"],
];

// GUIDE.md is Roughcut's own (written by hand from HyperFrames' agent rules): keep it.
const guide = existsSync(join(out, "GUIDE.md")) ? readFileSync(join(out, "GUIDE.md")) : null;
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "lib"), { recursive: true });
if (guide) writeFileSync(join(out, "GUIDE.md"), guide);
cpSync(join(gsap, "dist", "gsap.min.js"), join(out, "lib", "gsap.min.js"));
cpSync(join(core, "dist", "hyperframe.runtime.iife.js"), join(out, "lib", "hyperframes-runtime.js"));
cpSync(join(repo, "LICENSE"), join(out, "LICENSE-hyperframes.txt"));


const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
const catalog = [];
for (const [name, group] of PICKS) {
  const dir = join(repo, "registry", "blocks", name);
  const item = JSON.parse(readFileSync(join(dir, "registry-item.json"), "utf8"));
  const entry = item.files.find((f) => f.type === "hyperframes:composition");
  for (const f of item.files) {
    if (/\.(md|mjs)$/.test(f.path) || f.path.startsWith("demo")) continue;
    // Keep each file where the graphic's html expects it, relative to the html.
    const dest = join(out, name, f.path === entry.path ? "index.html" : f.path);
    mkdirSync(dirname(dest), { recursive: true });
    if (f === entry) {
      const html = readFileSync(join(dir, f.path), "utf8").replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@[^"]*\/dist\/gsap\.min\.js"><\/script>/g, '<script src="../lib/gsap.min.js"></script>');
      writeFileSync(dest, html);
    } else cpSync(join(dir, f.path), dest);
  }
  if (!existsSync(join(out, name, "index.html"))) throw new Error(`${name}: no composition`);
  catalog.push({
    name,
    title: item.title,
    description: item.description,
    group,
    duration: item.duration,
    width: item.dimensions?.width ?? 1920,
    height: item.dimensions?.height ?? 1080,
    params: item.params ?? [],
    poster: item.preview?.poster,
  });
}
writeFileSync(join(out, "catalog.json"), JSON.stringify({ source: `https://github.com/heygen-com/hyperframes/tree/${commit}/registry/blocks`, graphics: catalog }, null, 1));
writeFileSync(
  join(out, "NOTICE.txt"),
  `The graphics in this folder and lib/hyperframes-runtime.js are from HyperFrames (https://github.com/heygen-com/hyperframes, commit ${commit}),\n` +
    `Copyright HeyGen, licensed under the Apache License 2.0 (LICENSE-hyperframes.txt). Changed only to load GSAP from lib/.\n` +
    `lib/gsap.min.js is GSAP (https://gsap.com), under its standard no-charge licence (https://gsap.com/standard-license).\n` +
    `Fonts in */assets/fonts keep their own licences (OFL), included beside them.\n`,
);
console.log(`${catalog.length} graphics`);
