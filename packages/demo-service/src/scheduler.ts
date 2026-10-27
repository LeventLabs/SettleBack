import type { ManualClock } from "@settleback/adapters";

interface Task {
  at: number;
  order: number;
  run: () => void;
}

/**
 * A minimal discrete-event loop. Components schedule work at simulated times; `run` executes it
 * in time order and moves the clock, so concurrent behavior is reproducible without real waiting.
 */
export class Scheduler {
  readonly clock: ManualClock;
  private readonly tasks: Task[] = [];
  private sequence = 0;

  constructor(clock: ManualClock) {
    this.clock = clock;
  }

  now(): number {
    return this.clock.now().getTime();
  }

  after(delayMs: number, run: () => void): void {
    if (!(delayMs >= 0)) throw new Error("Cannot schedule in the past");
    this.tasks.push({ at: this.now() + delayMs, order: this.sequence++, run });
  }

  /** Runs due work in order until nothing is left or the horizon is reached. */
  run(horizonMs: number): void {
    const end = this.now() + horizonMs;
    for (;;) {
      this.tasks.sort((a, b) => a.at - b.at || a.order - b.order);
      const next = this.tasks[0];
      if (next === undefined || next.at > end) break;
      this.tasks.shift();
      if (next.at > this.now()) this.clock.advance(next.at - this.now());
      next.run();
    }
    if (end > this.now()) this.clock.advance(end - this.now());
  }
}
