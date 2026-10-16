/**
 * The app's few line icons (ⓘ info, ✕ close, ▶ play, ■ stop, ⚠ warning), drawn as SVG so they
 * look the same everywhere: the Unicode characters they replace are drawn by each system's
 * fonts, heavy and round on Windows. 16×16 grid, 1.4 px lines in the text colour
 * (`currentColor`), so CSS colours them like text.
 */
export type IconName = "info" | "close" | "play" | "stop" | "warning";

type Shape = [tag: string, attrs: Record<string, string | number>];

const DOT = { fill: "currentColor", stroke: "none" };

const SHAPES: Record<IconName, Shape[]> = {
  info: [
    ["circle", { cx: 8, cy: 8, r: 6.6 }],
    ["line", { x1: 8, y1: 7.2, x2: 8, y2: 11.4 }],
    ["circle", { cx: 8, cy: 4.9, r: 0.6, ...DOT }],
  ],
  close: [
    ["line", { x1: 4.6, y1: 4.6, x2: 11.4, y2: 11.4 }],
    ["line", { x1: 11.4, y1: 4.6, x2: 4.6, y2: 11.4 }],
  ],
  play: [["path", { d: "M5.6 3.9v8.2l6.4-4.1z", fill: "currentColor", "stroke-linejoin": "round" }]],
  stop: [["rect", { x: 4.4, y: 4.4, width: 7.2, height: 7.2, rx: 1.2, ...DOT }]],
  warning: [
    ["path", { d: "M8 2.4 14.2 13H1.8z", "stroke-linejoin": "round" }],
    ["line", { x1: 8, y1: 6.6, x2: 8, y2: 9.4 }],
    ["circle", { cx: 8, cy: 11.2, r: 0.6, ...DOT }],
  ],
};

const NS = "http://www.w3.org/2000/svg";

/** An icon `size` px square (1em by default: as big as the text around it). */
export function icon(name: IconName, size: number | string = "1em"): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  const attrs: Record<string, string | number> = {
    class: `ic ic-${name}`,
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.4,
    "stroke-linecap": "round",
    "aria-hidden": "true",
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  for (const [tag, a] of SHAPES[name]) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}
