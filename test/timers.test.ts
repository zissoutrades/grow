import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DURATIONS,
  FAREWELL_IDLE_FALLBACK_MS,
  PLAYBACK_IDLE_FALLBACK_MS,
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
  nudges: number;
  unresponsiveFinalizes: number;
}

interface Harness {
  clock: FakeClock;
  counters: Counters;
  timers: SessionTimers;
  setTutorIdle(idle: boolean): void;
}

function setup(durations: SessionDurations = DEFAULT_DURATIONS): Harness {
  const clock = new FakeClock();
  const counters: Counters = {
    instruction: 0,
    cap: 0,
    silence: 0,
    retries: [],
    farewells: 0,
    finalizes: 0,
    nudges: 0,
    unresponsiveFinalizes: 0,
  };
  let tutorIdle = true;
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
    onChildUnresponsiveNudge: () => {
      counters.nudges += 1;
    },
    onChildUnresponsiveFinalize: () => {
      counters.unresponsiveFinalizes += 1;
    },
    isTutorIdle: () => tutorIdle,
  };
  const timers = new SessionTimers(clock, durations, handlers);
  timers.start();
  return {
    clock,
    counters,
    timers,
    setTutorIdle: (idle) => {
      tutorIdle = idle;
    },
  };
}

/** The tutor's turn ended and its audio stopped playing: the normal settle. */
function settle(timers: SessionTimers): void {
  timers.noteTutorTurnComplete();
  timers.noteTutorPlaybackIdle();
}

const LADDER_DURATIONS: SessionDurations = {
  ...DEFAULT_DURATIONS,
  closeInstructionMs: 1_000_000,
  hardCapMs: 2_000_000,
  silenceMs: 1_000_000,
};

/** Short real-world timings for the child-silence watchdog. */
const WATCHDOG_DURATIONS: SessionDurations = {
  ...LADDER_DURATIONS,
  midSessionNudgeMs: 1_000,
  midSessionCloseMs: 500,
};

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

  test("greeting failsafe uses 8 s grace, 12 s retry gaps, 3 s farewell grace", () => {
    expect(DEFAULT_DURATIONS.greetingGraceMs).toBe(8_000);
    expect(DEFAULT_DURATIONS.greetingRetryMs).toBe(12_000);
    expect(DEFAULT_DURATIONS.farewellGraceMs).toBe(3_000);
    expect(PLAYBACK_IDLE_FALLBACK_MS).toBe(2_000);
    expect(FAREWELL_IDLE_FALLBACK_MS).toBe(3_000);
  });

  test("does not start the ladder before the greeting turn has settled", () => {
    const { clock, counters, timers } = setup(LADDER_DURATIONS);
    timers.armGreetingWatchdog();

    clock.advance(60_000);

    expect(counters.retries).toEqual([]);
    expect(counters.farewells).toBe(0);
  });

  test("playback idle before turn_complete waits for the turn to complete", () => {
    const { clock, counters, timers } = setup(LADDER_DURATIONS);
    timers.armGreetingWatchdog();

    timers.noteTutorPlaybackIdle();
    clock.advance(60_000);
    expect(counters.retries).toEqual([]);

    timers.noteTutorTurnComplete();
    clock.advance(7_999);
    expect(counters.retries).toEqual([]);
    clock.advance(1);
    expect(counters.retries).toEqual([1]);
  });

  test("falls back to turn_complete + 2 s when playback idle never arrives", () => {
    const { clock, counters, timers } = setup(LADDER_DURATIONS);
    timers.armGreetingWatchdog();

    timers.noteTutorTurnComplete();
    clock.advance(PLAYBACK_IDLE_FALLBACK_MS - 1);
    expect(counters.retries).toEqual([]);

    // The fallback only arms the phase; the 8 s grace still runs.
    clock.advance(1);
    expect(counters.retries).toEqual([]);
    clock.advance(7_999);
    expect(counters.retries).toEqual([]);
    clock.advance(1);
    expect(counters.retries).toEqual([1]);
  });

  test("walks the greeting ladder and finalizes after the farewell grace", () => {
    const { clock, counters, timers } = setup(LADDER_DURATIONS);
    timers.armGreetingWatchdog();

    settle(timers);
    clock.advance(7_999);
    expect(counters.retries).toEqual([]);
    clock.advance(1);
    expect(counters.retries).toEqual([1]);

    // The next gap starts only after the retry's own turn has settled.
    clock.advance(60_000);
    expect(counters.retries).toEqual([1]);

    settle(timers);
    clock.advance(11_999);
    expect(counters.retries).toEqual([1]);
    clock.advance(1);
    expect(counters.retries).toEqual([1, 2]);

    clock.advance(60_000);
    expect(counters.farewells).toBe(0);

    settle(timers);
    clock.advance(11_999);
    expect(counters.farewells).toBe(0);
    clock.advance(1);
    expect(counters.farewells).toBe(1);
    expect(counters.finalizes).toBe(0);

    // The farewell grace starts after the farewell's audio ended.
    settle(timers);
    clock.advance(2_999);
    expect(counters.finalizes).toBe(0);
    clock.advance(1);
    expect(counters.finalizes).toBe(1);
  });

  test("the farewell grace falls back to turn_complete + 3 s", () => {
    const { clock, counters, timers } = setup(LADDER_DURATIONS);
    timers.armGreetingWatchdog();
    settle(timers);
    clock.advance(8_000);
    settle(timers);
    clock.advance(12_000);
    settle(timers);
    clock.advance(12_000);
    expect(counters.farewells).toBe(1);

    timers.noteTutorTurnComplete();
    clock.advance(FAREWELL_IDLE_FALLBACK_MS - 1);
    expect(counters.finalizes).toBe(0);
    clock.advance(1);
    // The fallback stands in for the idle timestamp; the normal 3 s grace runs.
    expect(counters.finalizes).toBe(0);
    clock.advance(2_999);
    expect(counters.finalizes).toBe(0);
    clock.advance(1);
    expect(counters.finalizes).toBe(1);
  });

  test("never sends a retry while the tutor is mid-turn", () => {
    const { clock, counters, timers, setTutorIdle } = setup(LADDER_DURATIONS);
    timers.armGreetingWatchdog();
    settle(timers);

    setTutorIdle(false);
    clock.advance(8_000 + 5_000);
    expect(counters.retries).toEqual([]);

    setTutorIdle(true);
    clock.advance(500);
    expect(counters.retries).toEqual([1]);
  });

  test("disarms the greeting failsafe on the first child response", () => {
    const { clock, counters, timers } = setup(LADDER_DURATIONS);
    timers.armGreetingWatchdog();
    settle(timers);
    clock.advance(8_000);
    expect(counters.retries).toEqual([1]);

    timers.disarmGreetingWatchdog();
    clock.advance(60_000);

    expect(counters.retries).toEqual([1]);
    expect(counters.farewells).toBe(0);
    expect(counters.finalizes).toBe(0);
  });

  test("disarms the ladder while it is still waiting for the greeting to settle", () => {
    const { clock, counters, timers } = setup(LADDER_DURATIONS);
    timers.armGreetingWatchdog();
    timers.disarmGreetingWatchdog();

    timers.noteTutorTurnComplete();
    timers.noteTutorPlaybackIdle();
    clock.advance(60_000);

    expect(counters.retries).toEqual([]);
    expect(counters.farewells).toBe(0);
  });

  test("a farewell already issued is final even if the child answers", () => {
    const { clock, counters, timers } = setup(LADDER_DURATIONS);
    timers.armGreetingWatchdog();
    settle(timers);
    clock.advance(8_000);
    settle(timers);
    clock.advance(12_000);
    settle(timers);
    clock.advance(12_000);
    expect(counters.farewells).toBe(1);

    timers.disarmGreetingWatchdog();
    settle(timers);
    clock.advance(3_000);

    expect(counters.finalizes).toBe(1);
  });

  test("the mid-session watchdog defaults to a three-minute nudge and a two-minute close", () => {
    expect(DEFAULT_DURATIONS.midSessionNudgeMs).toBe(3 * 60_000);
    expect(DEFAULT_DURATIONS.midSessionCloseMs).toBe(2 * 60_000);
  });

  test("nudges once after a silence episode, then closes after the close grace", () => {
    const { clock, counters, timers } = setup(WATCHDOG_DURATIONS);
    timers.armChildSilenceWatchdog();

    clock.advance(999);
    expect(counters.nudges).toBe(0);

    clock.advance(1);
    expect(counters.nudges).toBe(1);
    expect(counters.unresponsiveFinalizes).toBe(0);

    clock.advance(499);
    expect(counters.unresponsiveFinalizes).toBe(0);
    clock.advance(1);
    expect(counters.unresponsiveFinalizes).toBe(1);
    expect(counters.nudges).toBe(1);
  });

  test("never nudges while the tutor is mid-turn and resumes after it settles", () => {
    const { clock, counters, timers, setTutorIdle } = setup(WATCHDOG_DURATIONS);
    timers.armChildSilenceWatchdog();

    setTutorIdle(false);
    timers.noteTutorActivity();
    clock.advance(60_000);
    expect(counters.nudges).toBe(0);

    setTutorIdle(true);
    timers.noteTutorTurnComplete();
    timers.noteTutorPlaybackIdle();
    clock.advance(999);
    expect(counters.nudges).toBe(0);
    clock.advance(1);
    expect(counters.nudges).toBe(1);
  });

  test("does not start counting before the first tutor turn has settled", () => {
    const { clock, counters, timers, setTutorIdle } = setup(WATCHDOG_DURATIONS);
    setTutorIdle(false);
    timers.noteTutorActivity();
    timers.armChildSilenceWatchdog();

    clock.advance(60_000);
    expect(counters.nudges).toBe(0);

    setTutorIdle(true);
    timers.noteTutorTurnComplete();
    timers.noteTutorPlaybackIdle();
    clock.advance(999);
    expect(counters.nudges).toBe(0);
    clock.advance(1);
    expect(counters.nudges).toBe(1);
  });

  test("a child input starts a new silence episode that may nudge again", () => {
    const { clock, counters, timers } = setup(WATCHDOG_DURATIONS);
    timers.armChildSilenceWatchdog();

    clock.advance(1_000);
    expect(counters.nudges).toBe(1);

    clock.advance(100);
    timers.noteChildInput();
    clock.advance(999);
    expect(counters.nudges).toBe(1);
    clock.advance(1);
    expect(counters.nudges).toBe(2);

    clock.advance(500);
    expect(counters.unresponsiveFinalizes).toBe(1);
  });

  test("the nudge turn pauses the close countdown until its audio ends", () => {
    const { clock, counters, timers, setTutorIdle } = setup({
      ...WATCHDOG_DURATIONS,
      midSessionCloseMs: 400,
    });
    timers.armChildSilenceWatchdog();

    clock.advance(1_000);
    expect(counters.nudges).toBe(1);

    setTutorIdle(false);
    timers.noteTutorActivity();
    clock.advance(60_000);
    expect(counters.unresponsiveFinalizes).toBe(0);

    setTutorIdle(true);
    timers.noteTutorTurnComplete();
    timers.noteTutorPlaybackIdle();
    clock.advance(399);
    expect(counters.unresponsiveFinalizes).toBe(0);
    clock.advance(1);
    expect(counters.unresponsiveFinalizes).toBe(1);
  });

  test("the close instruction switches to the end-phase timer without double-closing", () => {
    const { clock, counters, timers } = setup({
      ...WATCHDOG_DURATIONS,
      closeInstructionMs: 1_000,
      silenceMs: 500,
      midSessionNudgeMs: 800,
      midSessionCloseMs: 400,
    });
    timers.armChildSilenceWatchdog();

    clock.advance(800);
    expect(counters.nudges).toBe(1);

    clock.advance(200);
    expect(counters.instruction).toBe(1);
    expect(counters.unresponsiveFinalizes).toBe(0);

    clock.advance(499);
    expect(counters.silence).toBe(0);
    clock.advance(1);
    expect(counters.silence).toBe(1);
    expect(counters.unresponsiveFinalizes).toBe(0);

    // Exactly one close, and no late nudge from the abandoned mid phase.
    clock.advance(60_000);
    expect(counters.silence).toBe(1);
    expect(counters.nudges).toBe(1);
  });

  test("the end-phase idle timer starts only after the close-instruction turn settles", () => {
    const { clock, counters, timers, setTutorIdle } = setup({
      ...WATCHDOG_DURATIONS,
      closeInstructionMs: 1_000,
      silenceMs: 500,
    });
    clock.advance(1_000);
    expect(counters.instruction).toBe(1);

    // The injected close turn is active: activity during it must not start the
    // idle timer from `turn_complete`; it restarts the full window on settle.
    setTutorIdle(false);
    timers.noteTutorActivity();
    timers.notifyActivity();
    clock.advance(10_000);
    expect(counters.silence).toBe(0);

    setTutorIdle(true);
    timers.noteTutorTurnComplete();
    timers.noteTutorPlaybackIdle();
    clock.advance(499);
    expect(counters.silence).toBe(0);
    clock.advance(1);
    expect(counters.silence).toBe(1);
  });

  test("dispose clears the mid-session watchdog", () => {
    const { clock, counters, timers } = setup(WATCHDOG_DURATIONS);
    timers.armChildSilenceWatchdog();
    clock.advance(999);

    timers.dispose();
    clock.advance(60_000);

    expect(counters.nudges).toBe(0);
    expect(counters.unresponsiveFinalizes).toBe(0);
  });

  test("dispose clears pending timers including the greeting ladder", () => {
    const { clock, counters, timers } = setup();
    timers.armGreetingWatchdog();
    settle(timers);
    clock.advance(1_000);

    timers.dispose();
    clock.advance(20 * 60 * 1000);

    expect(counters).toEqual({
      instruction: 0,
      cap: 0,
      silence: 0,
      retries: [],
      farewells: 0,
      finalizes: 0,
      nudges: 0,
      unresponsiveFinalizes: 0,
    });
  });
});
