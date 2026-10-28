import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DURATIONS,
  SessionTimers,
  type SessionDurations,
  type TimerHandlers,
} from "../src/proxy/session";
import { FakeClock } from "./fake-clock";

interface Counters {
  instruction: number;
  cap: number;
  silence: number;
}

function setup(durations: SessionDurations): {
  clock: FakeClock;
  counters: Counters;
  timers: SessionTimers;
} {
  const clock = new FakeClock();
  const counters: Counters = { instruction: 0, cap: 0, silence: 0 };
  const handlers: TimerHandlers = {
    onCloseInstruction: () => {
      counters.instruction += 1;
    },
    onHardCap: () => {
      counters.cap += 1;
    },
    onSilence: () => {
      counters.silence += 1;
    },
  };
  const timers = new SessionTimers(clock, durations, handlers);
  timers.start();
  return { clock, counters, timers };
}

describe("SessionTimers", () => {
  test("injects the close instruction at ten minutes", () => {
    const { clock, counters } = setup(DEFAULT_DURATIONS);

    clock.advance(10 * 60 * 1000 - 1);
    expect(counters.instruction).toBe(0);

    clock.advance(1);
    expect(counters.instruction).toBe(1);
    expect(counters.cap).toBe(0);
  });

  test("hard-caps the session at twelve minutes", () => {
    const { clock, counters } = setup(DEFAULT_DURATIONS);

    clock.advance(12 * 60 * 1000);

    expect(counters.instruction).toBe(1);
    expect(counters.cap).toBe(1);
  });

  test("finalizes after silence once the instruction has been sent", () => {
    const { clock, counters } = setup({
      closeInstructionMs: 1_000,
      hardCapMs: 100_000,
      silenceMs: 500,
    });

    clock.advance(1_000);
    expect(counters.instruction).toBe(1);
    expect(counters.silence).toBe(0);

    clock.advance(500);
    expect(counters.silence).toBe(1);
  });

  test("activity after the instruction restarts the silence timer", () => {
    const { clock, counters, timers } = setup({
      closeInstructionMs: 1_000,
      hardCapMs: 100_000,
      silenceMs: 500,
    });
    clock.advance(1_000);

    clock.advance(400);
    timers.notifyActivity();

    clock.advance(400);
    expect(counters.silence).toBe(0);
    clock.advance(100);
    expect(counters.silence).toBe(1);
  });

  test("does not arm the silence timer before the instruction", () => {
    const { clock, counters } = setup({
      closeInstructionMs: 1_000,
      hardCapMs: 100_000,
      silenceMs: 500,
    });

    clock.advance(999);
    expect(counters.silence).toBe(0);
    expect(counters.instruction).toBe(0);
  });

  test("dispose clears pending timers", () => {
    const clock = new FakeClock();
    const counters: Counters = { instruction: 0, cap: 0, silence: 0 };
    const timers = new SessionTimers(clock, DEFAULT_DURATIONS, {
      onCloseInstruction: () => {
        counters.instruction += 1;
      },
      onHardCap: () => {
        counters.cap += 1;
      },
      onSilence: () => {
        counters.silence += 1;
      },
    });
    timers.start();

    timers.dispose();
    clock.advance(20 * 60 * 1000);

    expect(counters).toEqual({ instruction: 0, cap: 0, silence: 0 });
  });
});
