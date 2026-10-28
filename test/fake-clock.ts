import type { Clock } from "../src/proxy/session";

interface FakeTimer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

/** Deterministic clock: only `advance()` moves time and fires due timers. */
export class FakeClock implements Clock {
  private current = 0;
  private nextId = 1;
  private timers: FakeTimer[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ id, at: this.current + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  advance(delayMs: number): void {
    const target = this.current + delayMs;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (due === undefined) {
        break;
      }
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.current = due.at;
      due.callback();
    }
    this.current = target;
  }

  get pendingTimers(): number {
    return this.timers.length;
  }
}
