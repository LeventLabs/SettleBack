export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock that only moves when told to, so simulations and their retry schedules are reproducible. */
export class ManualClock implements Clock {
  private current: number;

  constructor(startIso: string) {
    const start = Date.parse(startIso);
    if (Number.isNaN(start)) throw new Error(`Invalid start time "${startIso}"`);
    this.current = start;
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("A clock can only move forward");
    this.current += milliseconds;
  }
}
