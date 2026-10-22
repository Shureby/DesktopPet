import { describe, expect, it } from "vitest";
import { AnimationPlayer } from "./animation";
import { StateMachine } from "./fsm";
import { createRng, weightedPick } from "./random";

describe("StateMachine", () => {
  it("runs enter/update/exit and transitions on returned names", () => {
    const log: string[] = [];
    const fsm = new StateMachine(
      {
        a: { anim: "a", enter: () => log.push("enter a"), update: (_c, _dt) => "b", exit: () => log.push("exit a") },
        b: { anim: "b", enter: () => log.push("enter b") },
      },
      {},
      "a",
    );
    fsm.update(0.1);
    expect(fsm.current).toBe("b");
    expect(fsm.time).toBe(0);
    expect(log).toEqual(["enter a", "exit a", "enter b"]);
  });

  it("rejects unknown states", () => {
    const fsm = new StateMachine({ a: { anim: "a" } }, {}, "a");
    expect(() => fsm.set("nope")).toThrow(/Unknown state/);
  });
});

describe("AnimationPlayer", () => {
  const player = () =>
    new AnimationPlayer({
      loop: { frames: ["1", "2"], fps: 10, loop: true },
      once: { frames: ["x", "y"], fps: 10, loop: false, next: "loop" },
    });

  it("loops frames at the given fps", () => {
    const p = player();
    p.play("loop");
    p.update(0.15);
    expect(p.frame).toBe("2");
    p.update(0.1);
    expect(p.frame).toBe("1");
  });

  it("continues with `next` after a one-shot animation", () => {
    const p = player();
    p.play("once");
    p.update(0.25);
    expect(p.current).toBe("loop");
  });
});

describe("random", () => {
  it("is deterministic per seed and respects weights", () => {
    const a = createRng(42);
    const b = createRng(42);
    expect(a()).toBe(b());
    const rng = createRng(1);
    const counts: Record<string, number> = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 3000; i++) counts[weightedPick(rng, { x: 1, y: 3, z: 0 })!]++;
    expect(counts.z).toBe(0);
    expect(counts.y).toBeGreaterThan(counts.x * 2);
  });
});
