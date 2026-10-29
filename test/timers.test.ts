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
  retries: number[];
  farewells: number;
  finalizes: number;
}

function setup(durations: SessionDurations = DEFAULT_DURATIONS): {
  clock: FakeClock;
  counters: Counters;
  timers: SessionTimers;
} {
  const clock = new FakeClock();
  const counters: Counters = {
    instruction: 0,
    cap: 0,
    silence: 0,
    retries: [],
    farewells: 0,
    finalizes: 0,
  };
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
    onGreetingRetry: (attempt) => {
      counters.retries.push(attempt);
    },
    onNoChildResponse: () => {
      counters.farewells += 1;
    },
    onNoChildResponseFinalize: () => {
      counters.finalizes += 1;
    },
  };
  const timers = new SessionTimers(clock, durations, handlers);
  timers.start();
  return { clock, counters, timers };
}

describe("SessionTimers", () => {
  test("injects the close instruction at ten minutes", () => {
    const { clock, counters } = setup();

    clock.advance(10 * 60 * 1000 - 1);
    expect(counters.instruction).toBe(0);

    clock.advance(1);
    expect(counters.instruction).toBe(1);
    expect(counters.cap).toBe(0);
  });

  test("hard-caps the session at twelve minutes", () => {
    const { clock, counters } = setup();

    clock.advance(12 * 60 * 1000);

    expect(counters.instruction).toBe(1);
    expect(counters.cap).toBe(1);
  });

  test("finalizes after silence once the instruction has been sent", () => {
    const { clock, counters } = setup({
      ...DEFAULT_DURATIONS,
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
      ...DEFAULT_DURATIONS,
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
      ...DEFAULT_DURATIONS,
      closeInstructionMs: 1_000,
      hardCapMs: 100_000,
      silenceMs: 500,
    });

    clock.advance(999);
    expect(counters.silence).toBe(0);
    expect(counters.instruction).toBe(0);
  });

  test("greeting failsafe uses 5 s grace and two 10 s retry intervals", () => {
    expect(DEFAULT_DURATIONS.greetingGraceMs).toBe(5_000);
    expect(DEFAULT_DURATIONS.greetingRetryMs).toBe(10_000);
    expect(DEFAULT_DURATIONS.farewellGraceMs).toBe(5_000);
  });

  test("walks the greeting ladder and finalizes after the farewell grace", () => {
    const { clock, counters, timers } = setup({
      ...DEFAULT_DURATIONS,
      closeInstructionMs: 1_000_000,
      hardCapMs: 2_000_000,
      silenceMs: 1_000_000,
    });
    timers.armGreetingWatchdog();

    clock.advance(4_999);
    expect(counters.retries).toEqual([]);

    clock.advance(1);
    expect(counters.retries).toEqual([1]);

    clock.advance(9_999);
    expect(counters.retries).toEqual([1]);

    clock.advance(1);
    expect(counters.retries).toEqual([1, 2]);

    clock.advance(9_999);
    expect(counters.farewells).toBe(0);

    clock.advance(1);
    expect(counters.farewells).toBe(1);
    expect(counters.finalizes).toBe(0);

    clock.advance(4_999);
    expect(counters.finalizes).toBe(0);

    clock.advance(1);
    expect(counters.finalizes).toBe(1);
  });

  test("disarms the greeting failsafe on the first child response", () => {
    const { clock, counters, timers } = setup({
      ...DEFAULT_DURATIONS,
      closeInstructionMs: 1_000_000,
      hardCapMs: 2_000_000,
      silenceMs: 1_000_000,
    });
    timers.armGreetingWatchdog();
    clock.advance(5_000);
    expect(counters.retries).toEqual([1]);

    timers.disarmGreetingWatchdog();
    clock.advance(60_000);

    expect(counters.retries).toEqual([1]);
    expect(counters.farewells).toBe(0);
    expect(counters.finalizes).toBe(0);
  });

  test("a farewell already issued is final even if the child answers", () => {
    const { clock, counters, timers } = setup({
      ...DEFAULT_DURATIONS,
      closeInstructionMs: 1_000_000,
      hardCapMs: 2_000_000,
      silenceMs: 1_000_000,
    });
    timers.armGreetingWatchdog();
    clock.advance(5_000 + 10_000 + 10_000);
    expect(counters.farewells).toBe(1);

    timers.disarmGreetingWatchdog();
    clock.advance(5_000);

    expect(counters.finalizes).toBe(1);
  });

  test("dispose clears pending timers including the greeting ladder", () => {
    const { clock, counters, timers } = setup();
    timers.armGreetingWatchdog();

    timers.dispose();
    clock.advance(20 * 60 * 1000);

    expect(counters).toEqual({
      instruction: 0,
      cap: 0,
      silence: 0,
      retries: [],
      farewells: 0,
      finalizes: 0,
    });
  });
});
