/**
 * An anniversary on screen (docs/INTERACTIONS.md, "Anniversaries"): fireworks with the day's
 * icons falling, or, for a remembrance, a dimmed screen with a white candle and white
 * chrysanthemums beside the pet. Drawn on a canvas over the whole screen (the Tauri app's
 * click-through "celebrate" window, or the browser mock's page).
 */

export interface EffectOptions {
  mode: "fireworks" | "candle";
  /** Fireworks: icons that fall (the anniversary's own first). */
  icons: string[];
  /** How long it plays, fading out at the end. */
  ms: number;
  /** Where the pet stands (CSS px in the canvas), for the candle and flowers. */
  petX: number;
  petY: number;
}

const COLOURS = ["#ffcf4a", "#ff6b9a", "#6be0ff", "#9dff7a", "#ffa24a", "#c99bff", "#ffffff"];
const FADE_MS = 1200;

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  colour: string;
}
interface Rocket {
  x: number;
  y: number;
  vy: number;
  top: number;
  colour: string;
}
interface Falling {
  icon: string;
  x: number;
  y: number;
  vy: number;
  sway: number;
  phase: number;
  size: number;
}

/** Plays the effect on `canvas` (sized to its CSS box); resolves when it's over. */
export function playEffect(canvas: HTMLCanvasElement, o: EffectOptions): Promise<void> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve();
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.scale(dpr, dpr);
  const start = performance.now();
  const draw = o.mode === "candle" ? candleScene(ctx, w, h, o) : fireworksScene(ctx, w, h, o);
  return new Promise((resolve) => {
    const frame = (now: number) => {
      const t = now - start;
      // Fade in quickly, out over the last moments.
      const alpha = Math.min(1, t / 400, Math.max(0, (o.ms - t) / FADE_MS));
      ctx.clearRect(0, 0, w, h);
      if (t >= o.ms) {
        resolve();
        return;
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      draw(t);
      ctx.restore();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

function fireworksScene(ctx: CanvasRenderingContext2D, w: number, h: number, o: EffectOptions) {
  const rockets: Rocket[] = [];
  const sparks: Spark[] = [];
  const falling: Falling[] = [];
  let last = 0;
  let nextRocket = 0;
  let nextIcon = 0;
  const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
  return (t: number) => {
    const dt = Math.min(50, t - last) / 1000;
    last = t;
    const ending = t > o.ms - FADE_MS * 1.5;
    if (t >= nextRocket && !ending) {
      rockets.push({ x: w * (0.15 + Math.random() * 0.7), y: h, vy: -(h * (0.9 + Math.random() * 0.4)), top: h * (0.15 + Math.random() * 0.35), colour: pick(COLOURS) });
      nextRocket = t + 250 + Math.random() * 400;
    }
    if (o.icons.length && t >= nextIcon && !ending) {
      falling.push({ icon: pick(o.icons), x: Math.random() * w, y: -40, vy: 60 + Math.random() * 70, sway: 20 + Math.random() * 30, phase: Math.random() * 6, size: 26 + Math.random() * 14 });
      nextIcon = t + 220 + Math.random() * 260;
    }
    // A faint veil so the colours show on any wallpaper.
    ctx.fillStyle = "rgba(10, 10, 30, 0.18)";
    ctx.fillRect(0, 0, w, h);
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.y += r.vy * dt;
      ctx.fillStyle = r.colour;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (r.y <= r.top) {
        rockets.splice(i, 1);
        const n = 55 + Math.floor(Math.random() * 30);
        const speed = 150 + Math.random() * 130;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          const v = speed * (0.6 + Math.random() * 0.4);
          sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, colour: Math.random() < 0.8 ? r.colour : "#ffffff" });
        }
      }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.vy += 90 * dt;
      s.vx *= 0.985;
      s.vy *= 0.985;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt / 2;
      if (s.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      // A bright head with a trail. (No "lighter" blending: over a transparent window it
      // washes everything out.)
      ctx.save();
      ctx.globalAlpha = Math.min(1, s.life * 1.4) * ctx.globalAlpha;
      ctx.strokeStyle = s.colour;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 0.09, s.y - s.vy * 0.09);
      ctx.stroke();
      ctx.fillStyle = s.colour;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.textAlign = "center";
    for (let i = falling.length - 1; i >= 0; i--) {
      const f = falling[i];
      f.y += f.vy * dt;
      if (f.y > h + 40) {
        falling.splice(i, 1);
        continue;
      }
      ctx.font = `${f.size}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
      ctx.fillText(f.icon, f.x + Math.sin(t / 700 + f.phase) * f.sway, f.y);
    }
  };
}

function candleScene(ctx: CanvasRenderingContext2D, w: number, h: number, o: EffectOptions) {
  const baseY = Math.min(h - 8, o.petY);
  // The candle is about 12% of the screen's height (drawn at 58 px, scaled up).
  const k = Math.min(3, Math.max(1.3, (h * 0.12) / 58));
  // Beside the pet, clear of its bubble (about 220 px wide, centred on it); the scene
  // reaches about 85 px (scaled) either side of the candle.
  const reach = 85 * k;
  const gap = 115 + reach;
  const cx = o.petX - gap > reach ? o.petX - gap : Math.min(w - reach, o.petX + gap);
  return (t: number) => {
    // The screen dims, with warm light around the candle.
    const glow = ctx.createRadialGradient(cx, baseY - 60 * k, 10, cx, baseY - 60 * k, Math.max(w, h) * 0.6);
    glow.addColorStop(0, "rgba(255, 190, 110, 0.30)");
    glow.addColorStop(0.25, "rgba(60, 40, 30, 0.35)");
    glow.addColorStop(1, "rgba(5, 5, 15, 0.55)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(cx, baseY);
    ctx.scale(k, k);
    bouquet(ctx, -54, t, -1, 0);
    bouquet(ctx, 54, t, 1, 1.7);
    candle(ctx, 0, 0, t);
    ctx.restore();
  };
}

/** Three white chrysanthemums fanned out, on the side of the candle `side` says (-1 left, 1 right). */
function bouquet(ctx: CanvasRenderingContext2D, x: number, t: number, side: -1 | 1, phase: number) {
  // Back to front: the tall one in the middle, then the outer, then the inner (lowest).
  chrysanthemum(ctx, x, 0, t, phase, 58, 0);
  chrysanthemum(ctx, x + side * 4, 0, t, phase + 0.8, 46, side * 15);
  chrysanthemum(ctx, x - side * 4, 0, t, phase + 1.9, 36, -side * 12);
}

function candle(ctx: CanvasRenderingContext2D, x: number, base: number, t: number) {
  const bw = 18;
  const bh = 58;
  const body = ctx.createLinearGradient(x - bw / 2, 0, x + bw / 2, 0);
  body.addColorStop(0, "#d9d6cf");
  body.addColorStop(0.5, "#fbfaf6");
  body.addColorStop(1, "#cfccc4");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.roundRect(x - bw / 2, base - bh, bw, bh, 3);
  ctx.fill();
  ctx.strokeStyle = "#3a3330";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, base - bh);
  ctx.lineTo(x, base - bh - 6);
  ctx.stroke();
  // The flame flickers.
  const flick = 1 + Math.sin(t / 90) * 0.06 + Math.sin(t / 37) * 0.04;
  const fy = base - bh - 6;
  const halo = ctx.createRadialGradient(x, fy - 10, 2, x, fy - 10, 46 * flick);
  halo.addColorStop(0, "rgba(255, 220, 140, 0.55)");
  halo.addColorStop(1, "rgba(255, 200, 120, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(x, fy - 10, 46 * flick, 0, Math.PI * 2);
  ctx.fill();
  const lean = Math.sin(t / 260) * 1.5;
  const flame = ctx.createRadialGradient(x, fy - 5, 1, x, fy - 8, 12 * flick);
  flame.addColorStop(0, "#fffbe6");
  flame.addColorStop(0.5, "#ffd36b");
  flame.addColorStop(1, "rgba(255, 140, 40, 0.85)");
  ctx.fillStyle = flame;
  ctx.beginPath();
  ctx.moveTo(x, fy + 1);
  ctx.bezierCurveTo(x - 7, fy - 4, x - 4 + lean, fy - 14 * flick, x + lean, fy - 21 * flick);
  ctx.bezierCurveTo(x + 4 + lean, fy - 14 * flick, x + 7, fy - 4, x, fy + 1);
  ctx.fill();
}

/** A white chrysanthemum on a stem `stem` px tall, its head `lean` px to the side, swaying a little. */
function chrysanthemum(ctx: CanvasRenderingContext2D, x: number, base: number, t: number, phase: number, stem = 46, lean = 0) {
  const sway = Math.sin(t / 900 + phase) * 2;
  const top = base - stem;
  ctx.strokeStyle = "#4f7a3a";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, base);
  ctx.quadraticCurveTo(x - 4 + lean * 0.3, base - stem / 2, x + lean + sway, top);
  ctx.stroke();
  ctx.fillStyle = "#5f8f45";
  ctx.beginPath();
  ctx.ellipse(x - 7 + lean * 0.4, base - stem * 0.4, 8, 3.5, -0.5, 0, Math.PI * 2);
  ctx.fill();
  const cx = x + lean + sway;
  for (const [n, r, len] of [
    [18, 0, 15],
    [14, 0.2, 11],
    [10, 0.5, 7],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r;
      ctx.save();
      ctx.translate(cx, top);
      ctx.rotate(a);
      ctx.fillStyle = len > 12 ? "#f4f3ee" : "#ffffff";
      ctx.strokeStyle = "rgba(170, 170, 160, 0.6)";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.ellipse(len / 2 + 2, 0, len / 2, 2.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.fillStyle = "#f3eac0";
  ctx.beginPath();
  ctx.arc(cx, top, 3.5, 0, Math.PI * 2);
  ctx.fill();
}
