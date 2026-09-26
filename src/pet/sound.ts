/** Tiny synthesized sounds so the MVP needs no audio assets (characters can add their own later). */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, start: number, dur: number, gain = 0.15) {
  const a = audio();
  if (!a) return;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = "triangle";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, a.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, a.currentTime + start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + start + dur);
  osc.connect(g).connect(a.destination);
  osc.start(a.currentTime + start);
  osc.stop(a.currentTime + start + dur + 0.05);
}

export const sounds = {
  chime() {
    tone(880, 0, 0.25);
    tone(1320, 0.12, 0.35);
  },
  alarm() {
    for (let i = 0; i < 3; i++) {
      tone(988, i * 0.3, 0.18, 0.2);
      tone(1319, i * 0.3 + 0.1, 0.15, 0.2);
    }
  },
  pop() {
    tone(660, 0, 0.08, 0.1);
  },
};

/** Repeats the alarm until stopped (or for at most `maxSeconds`). */
export function ringAlarm(maxSeconds = 60): () => void {
  sounds.alarm();
  const id = setInterval(() => sounds.alarm(), 2000);
  const timeout = setTimeout(() => clearInterval(id), maxSeconds * 1000);
  return () => {
    clearInterval(id);
    clearTimeout(timeout);
  };
}
