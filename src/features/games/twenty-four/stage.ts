import type { BoardPose } from "../../../characters/board";

export type Pose = BoardPose;

/**
 * The pet sitting on the board is the desktop pet itself (characters/board.ts): the game
 * tells it what to do there and what to say ("board-pet"), and remembers the last of each
 * for the end-to-end tests.
 */
export class PetStage {
  private pose: Pose = "rest";
  private line = "";
  private lineUntil = 0;

  constructor(private readonly send: (b: { pose?: Pose; say?: string; ms?: number }) => void) {}

  get current(): Pose {
    return this.pose;
  }

  set(pose: Pose): void {
    if (pose === this.pose) return;
    this.pose = pose;
    this.send({ pose });
  }

  /** A line in its bubble, for `ms` (0: a while). */
  say(text: string, ms = 0): void {
    if (!text) {
      this.line = "";
      return;
    }
    this.line = text;
    this.lineUntil = Date.now() + (ms || 8000);
    this.send({ say: text, ms });
  }

  /** The last line it was given, while it's showing. */
  get saying(): string {
    return Date.now() < this.lineUntil ? this.line : "";
  }
}
