import { msg } from "../../../i18n";
import { COLS, itemXs, rowKind, ROWS, type Lane, type State, type ThemeChoice, type ThemeId } from "./logic";

/**
 * What Pet Crossing's lanes look like. A theme is only looks (the rules are the same in all),
 * so a game can change theme from level to level; a new one is an entry here and in THEMES.
 */
export interface Theme {
  name: string;
  /** Where the pet is going, and its sign at the top. */
  goal: string;
  goalGlyph: string;
  colors: { goal: string; river: string; road: [string, string]; safe: string; mark: string };
  /** What moves along the road (emoji). */
  road: string[];
  /** Emoji that face left as drawn: turned round when moving right. */
  faces: boolean;
  /** What slides along the river, to stand on. */
  platform: (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, look: number) => void;
}

const EMOJI = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", system-ui, sans-serif';

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

function emoji(ctx: CanvasRenderingContext2D, glyph: string, x: number, y: number, size: number, flip = false): void {
  ctx.save();
  ctx.font = `${size}px ${EMOJI}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.translate(x, y);
  if (flip) ctx.scale(-1, 1);
  ctx.fillStyle = "#000";
  ctx.fillText(glyph, 0, size * 0.04);
  ctx.restore();
}

const CUSHIONS = ["#ffc9d9", "#ffe39a", "#c6f0d4", "#d9ccff"];

export const THEME: Record<ThemeId, Theme> = {
  // Toys rolling across the playroom floor; cushions floating on the pond.
  cute: {
    name: msg("Cute"),
    goal: msg("Fish nest"),
    goalGlyph: "🐟",
    colors: { goal: "#ffe39a", river: "#a6ddf2", road: ["#f1e6f3", "#e9dcee"], safe: "#c3ebab", mark: "rgba(120, 90, 140, 0.16)" },
    road: ["⚽", "🏀", "🎈", "🎁"],
    faces: false,
    platform(ctx, x, y, w, h, look) {
      ctx.fillStyle = CUSHIONS[look % CUSHIONS.length];
      rounded(ctx, x, y, w, h, h * 0.42);
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      rounded(ctx, x + 4, y + 4, w - 8, h - 8, h * 0.32);
      ctx.stroke();
      ctx.setLineDash([]);
    },
  },
  // The classic: cars on the road, logs on the river.
  traffic: {
    name: msg("Traffic"),
    goal: msg("Other side"),
    goalGlyph: "🏁",
    colors: { goal: "#ffd8a8", river: "#8fd0ee", road: ["#a3acbd", "#99a2b4"], safe: "#b7e29c", mark: "rgba(255, 255, 255, 0.75)" },
    road: ["🚗", "🚙", "🚕", "🚚"],
    faces: true,
    platform(ctx, x, y, w, h) {
      ctx.fillStyle = "#b98452";
      rounded(ctx, x, y, w, h, h * 0.45);
      ctx.fill();
      ctx.strokeStyle = "rgba(90, 55, 25, 0.45)";
      ctx.lineWidth = 2;
      for (const ex of [x + h * 0.42, x + w - h * 0.42]) {
        ctx.beginPath();
        ctx.ellipse(ex, y + h / 2, h * 0.16, h * 0.3, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(x + h * 0.9, y + h * 0.36);
      ctx.lineTo(x + w - h * 0.9, y + h * 0.36);
      ctx.stroke();
    },
  },
  // Work flying across the open-plan floor; chairs and carts sliding down the corridor.
  office: {
    name: msg("Office"),
    goal: msg("Slacking spot"),
    goalGlyph: "🎣",
    colors: { goal: "#cdeffb", river: "#e8dfcd", road: ["#eef1f6", "#e3e8f0"], safe: "#c9d6e6", mark: "rgba(60, 80, 120, 0.14)" },
    road: ["📊", "📋", "📈", "📑"],
    faces: false,
    platform(ctx, x, y, w, h, look) {
      ctx.fillStyle = "#bcc7d6";
      rounded(ctx, x, y + h * 0.12, w, h * 0.76, 8);
      ctx.fill();
      const n = Math.max(1, Math.round(w / (h / 0.8)));
      for (let i = 0; i < n; i++) emoji(ctx, (look + i) % 2 ? "🛒" : "🪑", x + ((i + 0.5) * w) / n, y + h / 2, h * 0.78);
    },
  },
};

export function themeName(choice: ThemeChoice): string {
  return choice === "random" ? msg("Random") : THEME[choice].name;
}

/** Draws the board (not the pet): `cell` px a cell, `label` the goal's name as shown. */
export function drawBoard(ctx: CanvasRenderingContext2D, s: State, cell: number, label: string, font: string): void {
  const th = THEME[s.theme];
  const w = COLS * cell;
  for (let row = 0; row < ROWS; row++) {
    const kind = rowKind(row);
    ctx.fillStyle = kind === "goal" ? th.colors.goal : kind === "river" ? th.colors.river : kind === "road" ? th.colors.road[row % 2] : th.colors.safe;
    ctx.fillRect(0, row * cell, w, cell);
    if (kind === "road" || kind === "river") {
      // The lane's middle line (road), or ripples / floor marks (river).
      ctx.strokeStyle = th.colors.mark;
      ctx.lineWidth = 2;
      ctx.setLineDash(kind === "road" ? [cell * 0.3, cell * 0.3] : [cell * 0.12, cell * 0.5]);
      ctx.beginPath();
      ctx.moveTo(0, row * cell + cell / 2);
      ctx.lineTo(w, row * cell + cell / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // One sign for where it's going.
  ctx.font = `700 ${Math.round(cell * 0.34)}px ${font}`;
  const text = ctx.measureText(label).width;
  const sign = cell * 0.9 + text + cell * 0.5;
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  rounded(ctx, (w - sign) / 2, cell * 0.12, sign, cell * 0.76, cell * 0.3);
  ctx.fill();
  emoji(ctx, th.goalGlyph, (w - sign) / 2 + cell * 0.55, cell / 2, cell * 0.56);
  ctx.fillStyle = "#3a2f14";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, (w - sign) / 2 + cell * 0.95, cell / 2 + 1);

  s.lanes.forEach((lane, row) => {
    if (lane) drawLane(ctx, th, lane, row, cell);
  });
}

function drawLane(ctx: CanvasRenderingContext2D, th: Theme, lane: Lane, row: number, cell: number): void {
  const y = row * cell;
  for (let i = 0; i < lane.count; i++) {
    const look = lane.looks[i] ?? 0;
    for (const cx of itemXs(lane, i)) {
      const x = cx * cell;
      const w = lane.width * cell;
      if (lane.kind === "river") {
        th.platform(ctx, x + 3, y + cell * 0.12, w - 6, cell * 0.76, look);
        continue;
      }
      // One picture a cell, on its shadow.
      for (let k = 0; k < lane.width; k++) {
        const mx = x + (k + 0.5) * cell;
        ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
        ctx.beginPath();
        ctx.ellipse(mx, y + cell * 0.84, cell * 0.3, cell * 0.08, 0, 0, Math.PI * 2);
        ctx.fill();
        emoji(ctx, th.road[look % th.road.length], mx, y + cell * 0.48, cell * 0.68, th.faces && lane.dir > 0);
      }
    }
  }
}
