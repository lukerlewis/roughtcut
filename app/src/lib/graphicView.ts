// A motion graphic's page as it plays and renders: the composition as made
// (source.html) with Luke's settings applied. Kept as a pure string function
// so the viewer and the export always agree.

import type { Brand } from "./backend";
import type { Graphic } from "./edl";

function hsl(hex: string): [number, number, number] {
  const h = hex.length === 4 ? hex.replace(/^#(.)(.)(.)$/, "#$1$1$2$2$3$3") : hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d) hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hue * 60 + 360) % 360, s, l];
}

/** Luke's brand on a graphic made by someone else: its colourful colours
 *  become his accents (the most used one his main accent), and its words his
 *  font and weights. Greys, blacks and whites stay, so contrast holds. */
export function restyle(source: string, brand: Brand): string {
  let html = source;
  if (brand.accent) {
    const counts = new Map<string, number>();
    for (const m of html.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
      const [, s, l] = hsl(m[0]);
      if (s > 0.35 && l > 0.2 && l < 0.85) counts.set(m[0].toLowerCase(), (counts.get(m[0].toLowerCase()) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const second = brand.accent2 ?? brand.accent;
    html = html.replace(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g, (c) => {
      const i = ranked.indexOf(c.toLowerCase());
      return i < 0 ? c : i === 0 ? brand.accent! : second;
    });
  }
  return html;
}

function brandCss(brand: Brand): string {
  const vars = [
    brand.font && `--brand-font: "${brand.font.replace(/["<;{}]/g, "")}";`,
    brand.bold && `--brand-bold: ${brand.bold};`,
    brand.regular && `--brand-regular: ${brand.regular};`,
    brand.ink && `--brand-ink: ${brand.ink};`,
    brand.paper && `--brand-paper: ${brand.paper};`,
    brand.accent && `--brand-accent: ${brand.accent};`,
    brand.accent2 && `--brand-accent-2: ${brand.accent2};`,
    brand.radius !== undefined && `--brand-radius: ${brand.radius}px;`,
  ].filter(Boolean);
  let css = `:root, [data-composition-id] { ${vars.join(" ")} }`;
  // Words in Luke's font; code keeps its monospace.
  if (brand.font) {
    const words = `[data-composition-id] :not(code):not(pre):not(kbd):not(samp):not([class*="code"]):not([class*="mono"]):not([class*="terminal"])`;
    css += ` ${words} { font-family: var(--brand-font), -apple-system, sans-serif !important; }`;
    if (brand.bold) css += ` [data-composition-id] :is(h1, h2, h3, strong, b, [class*="title"], [class*="name"], [class*="headline"]) { font-weight: var(--brand-bold) !important; }`;
  }
  return css;
}

const SKIP = new Set(["SCRIPT", "STYLE", "TITLE", "NOSCRIPT", "TEMPLATE", "svg"]);

/** The pieces of text written in the page, in order: the words Luke can change
 *  without asking Claude. (Text a graphic makes in its script isn't here.) */
export function textSlots(doc: Document): { node: Text; text: string }[] {
  const out: { node: Text; text: string }[] = [];
  const root = doc.querySelector("[data-composition-id]") ?? doc.body;
  if (!root) return out;
  const walk = (el: Element) => {
    if (SKIP.has(el.tagName)) return;
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        const text = (child as Text).data.replace(/\s+/g, " ").trim();
        if (text) out.push({ node: child as Text, text });
      } else if (child.nodeType === 1) walk(child as Element);
    }
  };
  walk(root);
  return out;
}

export function textsOf(html: string): string[] {
  return textSlots(new DOMParser().parseFromString(html, "text/html")).map((s) => s.text);
}

/** One setting Luke can change: a colour, a number or some text. */
export interface Setting {
  key: string; // "--accent" (a CSS custom property) or a declared variable's id
  label: string;
  type: "color" | "number" | "text";
  default: string | number;
  min?: number;
  max?: number;
  step?: number;
}

type Declared = Setting & { raw: Record<string, unknown> };

function declaredSettings(root: Element): Declared[] {
  try {
    const list = JSON.parse(root.getAttribute("data-composition-variables") ?? "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter((d) => d && typeof d.id === "string")
      .map((d) => ({
        key: d.id,
        label: d.label ?? d.id,
        type: d.type === "color" ? "color" : d.type === "number" ? "number" : "text",
        default: d.default ?? "",
        min: d.min,
        max: d.max,
        step: d.step,
        raw: d,
      }));
  } catch {
    return [];
  }
}

/** A graphic's settings: those it declares, and the catalogue's CSS ones. */
export function settingsOf(source: string, catalog: { key?: string; label: string; type: string; default: string | number; min?: number; max?: number; step?: number }[] = []): Setting[] {
  const root = new DOMParser().parseFromString(source, "text/html").querySelector("[data-composition-id]");
  const own: Setting[] = (root ? declaredSettings(root) : []).map(({ raw: _, ...d }) => d);
  const css: Setting[] = catalog
    .filter((p) => p.key?.startsWith("--") && !own.some((o) => o.key === p.key))
    .map((p) => ({ key: p.key!, label: p.label, type: p.type === "color" ? "color" : p.type === "number" ? "number" : "text", default: p.default, min: p.min, max: p.max, step: p.step }));
  return [...own, ...css];
}

/** source.html with the graphic's words, settings and length applied. */
export function viewHtml(source: string, g: Pick<Graphic, "params" | "texts" | "brand">, length: number | null, brand?: Brand): string {
  const branded = brand && g.brand !== false;
  const doc = new DOMParser().parseFromString(branded ? restyle(source, brand) : source, "text/html");
  const slots = textSlots(doc);
  for (const [k, text] of Object.entries(g.texts ?? {})) {
    const slot = slots[Number(k)];
    if (slot) slot.node.data = slot.node.data.replace(/\S[\s\S]*\S|\S/, text);
  }
  const root = doc.querySelector("[data-composition-id]");
  // It runs as long as its block on the timeline (holding its last frame if that's longer).
  if (root && length && length > 0) root.setAttribute("data-duration", String(Math.round(length * 1000) / 1000));
  // Settings are CSS custom properties ("--accent") or the composition's own
  // declared variables, whose defaults the graphic reads.
  const declared = root ? declaredSettings(root) : [];
  if (root && declared.length) {
    const next = declared.map((d) => (d.key in (g.params ?? {}) ? { ...d.raw, default: d.type === "number" ? Number(g.params![d.key]) : g.params![d.key] } : d.raw));
    root.setAttribute("data-composition-variables", JSON.stringify(next));
  }
  const vars = Object.entries(g.params ?? {}).filter(([k]) => /^--[\w-]+$/.test(k));
  if (vars.length) {
    const style = doc.createElement("style");
    style.setAttribute("data-roughcut", "settings");
    const body = vars.map(([k, v]) => `${k}: ${String(v).replace(/[;{}<]/g, "")} !important;`).join(" ");
    style.textContent = `:root, [data-composition-id] { ${body} }`;
    doc.head.appendChild(style);
  }
  if (branded) {
    const style = doc.createElement("style");
    style.setAttribute("data-roughcut", "brand");
    style.textContent = brandCss(brand);
    doc.head.appendChild(style);
  }
  return "<!doctype html>\n" + doc.documentElement.outerHTML;
}
