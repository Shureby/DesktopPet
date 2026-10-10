/**
 * A tiny finite state machine. States are plain objects so abilities can
 * contribute new states to a character without subclassing anything.
 */
export interface StateDef<C> {
  /** Animation to play while in this state (a function lets states pick per context). */
  anim: string | ((ctx: C) => string);
  /** Kinematic states move the body themselves; physics is skipped while they run. */
  kinematic?: boolean;
  /** Airborne states keep running while the body has no support (others switch to falling). */
  airborne?: boolean;
  enter?(ctx: C): void;
  /** Return a state name to transition, or nothing to stay. */
  update?(ctx: C, dt: number): string | void;
  exit?(ctx: C): void;
}

export class StateMachine<C> {
  private name: string;
  private elapsed = 0;

  constructor(
    private readonly states: Record<string, StateDef<C>>,
    private readonly ctx: C,
    initial: string,
    private readonly onChange?: (from: string, to: string) => void,
  ) {
    if (!states[initial]) throw new Error(`Unknown initial state "${initial}"`);
    this.name = initial;
    states[initial].enter?.(ctx);
  }

  get current(): string {
    return this.name;
  }

  get def(): StateDef<C> {
    return this.states[this.name];
  }

  /** Seconds spent in the current state. */
  get time(): number {
    return this.elapsed;
  }

  has(name: string): boolean {
    return name in this.states;
  }

  stateDef(name: string): StateDef<C> | undefined {
    return this.states[name];
  }

  /** Switch state. Re-entering the current state restarts it only when `restart` is set. */
  set(name: string, restart = false): void {
    const next = this.states[name];
    if (!next) throw new Error(`Unknown state "${name}"`);
    if (name === this.name && !restart) return;
    const prev = this.name;
    this.states[prev].exit?.(this.ctx);
    this.name = name;
    this.elapsed = 0;
    next.enter?.(this.ctx);
    this.onChange?.(prev, name);
  }

  update(dt: number): void {
    this.elapsed += dt;
    const next = this.def.update?.(this.ctx, dt);
    if (next) this.set(next, next === this.name);
  }
}
