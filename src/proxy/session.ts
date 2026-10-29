import { join } from "node:path";
import { runAfterLoop, type AfterStatus } from "./after";
import {
  GeminiLive,
  type GeminiFunctionCall,
  type GeminiUsageMetadata,
  type TranscriptRole,
  type TurnEvent,
} from "./gemini";
import { SessionLog } from "./log";
import { buildPackage, type SessionPackage } from "./package";
import type { TextModelFn } from "./text-model";
import {
  executeToolCall,
  formatChildAction,
  ToolValidationError,
  type BeatEvent,
  type CanvasEvent,
  type ChildAction,
} from "./tools";
import { MIC_FORMAT, TUTOR_FORMAT, stampPcmToWav, type WaveStampResult } from "./wav";

export type FinalizeReason =
  | "child_tap"
  | "parent_console"
  | "timeout"
  | "silence"
  | "no_child_response"
  | "child_unresponsive";

export type SessionState = "created" | "starting" | "live" | "finalizing" | "done" | "error";

/** Why a text turn was injected; recorded on the `inject` log line. */
export type SessionInjectPhase = "manual" | "greeting" | "failsafe" | "close";

export interface ClientSink {
  sendJson(payload: unknown): void;
  sendBinary(bytes: Uint8Array): void;
}

export interface SessionDurations {
  closeInstructionMs: number;
  hardCapMs: number;
  silenceMs: number;
  /** Mid-session: no child input while the tutor is idle before one nudge. */
  midSessionNudgeMs: number;
  /** Mid-session: further silence after the nudge before the graceful close. */
  midSessionCloseMs: number;
  /** Wait after the greeting before the first "can you hear me?" retry. */
  greetingGraceMs: number;
  /** Wait between greeting retries and before the farewell. */
  greetingRetryMs: number;
  /** Time allowed for the farewell line to be spoken before finalizing. */
  farewellGraceMs: number;
}

export const DEFAULT_DURATIONS: SessionDurations = {
  closeInstructionMs: 10 * 60 * 1000,
  hardCapMs: 12 * 60 * 1000,
  silenceMs: 3 * 60 * 1000,
  midSessionNudgeMs: 3 * 60 * 1000,
  midSessionCloseMs: 2 * 60 * 1000,
  greetingGraceMs: 8_000,
  greetingRetryMs: 12_000,
  farewellGraceMs: 3_000,
};

/**
 * If the client's playback-idle message is missed, assume the tutor's audio
 * ended this long after `turn_complete`. The client sends the real timestamp;
 * this only keeps the ladder moving after a reconnect or a dropped frame.
 */
export const PLAYBACK_IDLE_FALLBACK_MS = 2_000;

/** The farewell gets a longer fallback: the close must never cut audible speech. */
export const FAREWELL_IDLE_FALLBACK_MS = 3_000;

/** How often a due retry/finalize re-checks while the tutor is still speaking. */
const TUTOR_BUSY_RECHECK_MS = 500;

export const CLOSE_INSTRUCTION = "Приблизься к финальному биту: рефлексия и прощание.";

/**
 * Start failsafe (owner spec U10.1, refined by U13.1). The tutor greets first,
 * but says only hello and waits: the first beat starts only after the child
 * answers (the model's own flow), never immediately after the greeting.
 */
export const GREETING_INSTRUCTION =
  "Поздоровайся коротко по-русски и дождись ответа ребёнка; первый бит начинай только после того, как ребёнок ответит.";

export const GREETING_RETRY_INSTRUCTIONS = [
  "Ребёнок пока не ответил. Коротко спроси по-русски: «Ты меня слышишь?»",
  "Ребёнок всё ещё не отвечает. Ещё раз коротко спроси по-русски: «Ты меня слышишь?»",
] as const;

export const NO_RESPONSE_FAREWELL =
  "Скажи ребёнку по-русски: «Кажется, ты меня не слышишь. Завершаю занятие — перезапусти, когда будешь готов(а).»";

/**
 * Mid-session silence nudge (U14.1). One nudge per silence episode: if the
 * child still does not answer, the session closes gracefully with
 * `child_unresponsive` instead of repeating the prompt.
 */
export const CHILD_UNRESPONSIVE_NUDGE =
  "Ребёнок давно молчит. Коротко спроси по-русски: «Ты здесь? Если тебя нет — я завершу занятие.»";

const GREETING_MAX_RETRIES = GREETING_RETRY_INSTRUCTIONS.length;

const TOKENS_PER_AUDIO_SECOND = 25;
const RATES_USD_PER_MILLION = {
  audioIn: 3.0,
  audioOut: 12.0,
  textIn: 0.75,
  textOut: 4.5,
} as const;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TimerHandlers {
  onCloseInstruction(): void;
  onHardCap(): void;
  /** The end-phase idle timer expired: finalize `silence`. */
  onSilence(): void;
  /** 1-based greeting retry: 1 = first "Ты меня слышишь?", 2 = the second. */
  onGreetingRetry(attempt: number): void;
  /** No child response at all: inject the farewell line. */
  onNoChildResponse(): void;
  /** The farewell has had its grace period: finalize `no_child_response`. */
  onNoChildResponseFinalize(): void;
  /** Mid-session silence: inject the single "are you there?" nudge. */
  onChildUnresponsiveNudge(): void;
  /** Silence persisted after the nudge: finalize `child_unresponsive`. */
  onChildUnresponsiveFinalize(): void;
  /** True when no tutor turn is in flight; timers never fire mid-turn. */
  isTutorIdle(): boolean;
}

/** Which tutor turn the ladder is waiting to finish before its next phase. */
type GreetingSettleStage = "greeting" | "retry" | "farewell";

/** The timer phase that starts once that turn has settled. */
type GreetingPhase = "grace" | "retry-gap" | "farewell-grace";

/** The stage of the single child-silence watchdog. */
type SilenceStage = "nudge" | "close" | "finalize";

/**
 * `mid` counts child silence during the session (one nudge, then a graceful
 * `child_unresponsive` close). `end` is the 10:00 close-instruction phase: it
 * only finalizes (`silence`) and never nudges.
 */
type SilenceMode = "mid" | "end";

/**
 * Session clock: 10:00 close instruction, 12:00 hard cap, the start-failsafe
 * ladder armed once the tutor's greeting has finished (turn complete +
 * playback idle), and one child-silence watchdog.
 *
 * The silence watchdog has two modes so the mid-session and end-phase timers
 * can never fight:
 * - **mid** (session live): no child transcript/canvas action while the tutor
 *   is idle → one nudge at `midSessionNudgeMs`; no child input for another
 *   `midSessionCloseMs` → finalize `child_unresponsive`. A child input starts a
 *   fresh episode; every tutor turn pauses the countdown (silence during tutor
 *   speech is natural) and it resumes only once that turn has completed and
 *   its playback drained.
 * - **end** (after the 10:00 close instruction): any activity restarts the
 *   `silenceMs` idle timer; expiry finalizes `silence`.
 */
export class SessionTimers {
  private readonly clock: Clock;
  private readonly durations: SessionDurations;
  private readonly handlers: TimerHandlers;
  private closeInstructionHandle: unknown = null;
  private hardCapHandle: unknown = null;
  private phaseHandle: unknown = null;
  private phase: GreetingPhase | null = null;
  private settleStage: GreetingSettleStage | null = null;
  private settleTurnComplete = false;
  private settlePlaybackIdle = false;
  private settleFallbackHandle: unknown = null;
  private greetingArmed = false;
  private greetingAttempt = 0;
  private farewellIssued = false;

  private silenceMode: SilenceMode | null = null;
  private silenceStage: SilenceStage = "nudge";
  private silenceTimerHandle: unknown = null;
  private silenceDeadline = 0;
  private silenceRemainingMs = 0;
  private silenceWaiting = false;
  private silenceTurnComplete = false;
  private silencePlaybackIdle = false;
  private silenceFallbackHandle: unknown = null;

  private disposed = false;

  constructor(clock: Clock, durations: SessionDurations, handlers: TimerHandlers) {
    this.clock = clock;
    this.durations = durations;
    this.handlers = handlers;
  }

  start(): void {
    if (this.disposed) {
      return;
    }
    this.hardCapHandle = this.clock.setTimeout(() => {
      this.hardCapHandle = null;
      this.handlers.onHardCap();
    }, this.durations.hardCapMs);

    this.closeInstructionHandle = this.clock.setTimeout(() => {
      this.closeInstructionHandle = null;
      this.switchToEndPhase();
      this.handlers.onCloseInstruction();
    }, this.durations.closeInstructionMs);
  }

  /** Called on meaningful model/child activity; restarts the end-phase timer. */
  notifyActivity(): void {
    if (this.disposed || this.silenceMode !== "end") {
      return;
    }
    if (this.silenceWaiting) {
      // A tutor turn is in flight (or its audio is still draining): the settle
      // hook starts the idle timer. Activity still means "restart the full
      // idle window", never resume the pre-turn remainder.
      this.silenceRemainingMs = this.durations.silenceMs;
      return;
    }
    this.restartSilenceStage(this.durations.silenceMs);
  }

  /**
   * Begin the start failsafe after the greeting was injected. Nothing is
   * scheduled here: the first grace starts only once the greeting turn has
   * completed (see `noteTutorTurnComplete`) and its audio has stopped playing
   * (see `noteTutorPlaybackIdle`), so a retry can never interrupt the tutor.
   */
  armGreetingWatchdog(): void {
    if (this.disposed || this.greetingArmed || this.farewellIssued) {
      return;
    }
    this.greetingArmed = true;
    this.greetingAttempt = 0;
    this.awaitTutorSettle("greeting");
  }

  /**
   * Begin the mid-session child-silence watchdog. It starts counting only once
   * the current tutor turn has settled, so a long greeting/first turn is never
   * mistaken for the child's absence.
   */
  armChildSilenceWatchdog(): void {
    if (this.disposed || this.silenceMode !== null) {
      return;
    }
    this.silenceMode = "mid";
    this.silenceStage = "nudge";
    this.silenceRemainingMs = this.durations.midSessionNudgeMs;
    this.restartSilenceStage(this.silenceRemainingMs);
  }

  /**
   * Any child transcript (partial or final) or canvas action. Mid-session it
   * ends the current silence episode (a new one may nudge once more); in the
   * end phase it restarts the idle timer.
   */
  noteChildInput(): void {
    if (this.disposed || this.silenceMode === null) {
      return;
    }
    if (this.silenceMode === "end") {
      this.restartSilenceStage(this.durations.silenceMs);
      return;
    }
    this.silenceStage = "nudge";
    this.silenceRemainingMs = this.durations.midSessionNudgeMs;
    this.restartSilenceStage(this.silenceRemainingMs);
  }

  /**
   * A tutor turn is starting. Silence during tutor speech is natural, so the
   * mid-session countdown pauses and resumes when that turn has settled. In the
   * end phase any activity restarts the idle timer instead.
   */
  noteTutorActivity(): void {
    if (this.disposed || this.silenceMode === null) {
      return;
    }
    if (this.silenceMode === "end") {
      this.restartSilenceStage(this.durations.silenceMs);
      return;
    }
    if (this.silenceWaiting) {
      return;
    }
    const remaining =
      this.silenceTimerHandle === null
        ? this.silenceRemainingMs
        : Math.max(0, this.silenceDeadline - this.clock.now());
    this.beginSilenceWait(remaining);
  }

  /** The tutor turn was interrupted; its client playback is flushed. */
  noteTutorInterrupted(): void {
    if (this.disposed || !this.silenceWaiting) {
      return;
    }
    this.settleSilenceWatchdog();
  }

  /** The tutor's current turn ended upstream (`turn_complete`). */
  noteTutorTurnComplete(): void {
    if (this.disposed) {
      return;
    }
    this.handleGreetingTurnComplete();
    this.handleSilenceTurnComplete();
  }

  /** The client reported that the tutor's audio queue actually drained. */
  noteTutorPlaybackIdle(): void {
    if (this.disposed) {
      return;
    }
    this.handleGreetingPlaybackIdle();
    this.handleSilencePlaybackIdle();
  }

  /** First child response: stop the ladder. A farewell already spoken is final. */
  disarmGreetingWatchdog(): void {
    if (this.farewellIssued) {
      return;
    }
    this.greetingArmed = false;
    this.phase = null;
    this.settleStage = null;
    this.clearSettleFallback();
    this.clearPhase();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.hardCapHandle !== null) {
      this.clock.clearTimeout(this.hardCapHandle);
      this.hardCapHandle = null;
    }
    if (this.closeInstructionHandle !== null) {
      this.clock.clearTimeout(this.closeInstructionHandle);
      this.closeInstructionHandle = null;
    }
    this.clearSilenceTimer();
    this.clearSilenceFallback();
    this.clearPhase();
    this.clearSettleFallback();
    this.phase = null;
    this.settleStage = null;
    this.greetingArmed = false;
    this.silenceMode = null;
    this.silenceWaiting = false;
    this.silenceRemainingMs = 0;
  }

  private awaitTutorSettle(stage: GreetingSettleStage): void {
    this.clearPhase();
    this.clearSettleFallback();
    this.phase = null;
    this.settleStage = stage;
    this.settleTurnComplete = false;
    this.settlePlaybackIdle = false;
  }

  private handleGreetingTurnComplete(): void {
    if (this.settleStage === null || this.settleTurnComplete) {
      return;
    }
    this.settleTurnComplete = true;
    if (this.settlePlaybackIdle) {
      this.armSettledPhase();
      return;
    }
    // The client's playback-idle message may be lost (reconnect, dropped
    // frame). Fall back to a fixed delay after turn_complete.
    const fallbackMs =
      this.settleStage === "farewell" ? FAREWELL_IDLE_FALLBACK_MS : PLAYBACK_IDLE_FALLBACK_MS;
    this.settleFallbackHandle = this.clock.setTimeout(() => {
      this.settleFallbackHandle = null;
      if (this.settleStage === null) {
        return;
      }
      this.settlePlaybackIdle = true;
      this.armSettledPhase();
    }, fallbackMs);
  }

  private handleGreetingPlaybackIdle(): void {
    if (this.settleStage === null || this.settlePlaybackIdle) {
      return;
    }
    this.settlePlaybackIdle = true;
    this.clearSettleFallback();
    if (this.settleTurnComplete) {
      this.armSettledPhase();
    }
  }

  private handleSilenceTurnComplete(): void {
    if (!this.silenceWaiting || this.silenceTurnComplete) {
      return;
    }
    this.silenceTurnComplete = true;
    if (this.silencePlaybackIdle) {
      this.settleSilenceWatchdog();
      return;
    }
    this.silenceFallbackHandle = this.clock.setTimeout(() => {
      this.silenceFallbackHandle = null;
      if (!this.silenceWaiting) {
        return;
      }
      this.silencePlaybackIdle = true;
      this.settleSilenceWatchdog();
    }, PLAYBACK_IDLE_FALLBACK_MS);
  }

  private handleSilencePlaybackIdle(): void {
    if (!this.silenceWaiting || this.silencePlaybackIdle) {
      return;
    }
    this.silencePlaybackIdle = true;
    this.clearSilenceFallback();
    if (this.silenceTurnComplete) {
      this.settleSilenceWatchdog();
    }
  }

  /** Turn complete and playback idle are both known: start the phase timer. */
  private armSettledPhase(): void {
    const stage = this.settleStage;
    if (stage === null || !this.settleTurnComplete || !this.settlePlaybackIdle) {
      return;
    }
    this.settleStage = null;
    this.clearSettleFallback();
    if (stage === "farewell") {
      this.phase = "farewell-grace";
      this.schedulePhase(this.durations.farewellGraceMs);
      return;
    }
    if (stage === "greeting") {
      this.phase = "grace";
      this.schedulePhase(this.durations.greetingGraceMs);
      return;
    }
    this.phase = "retry-gap";
    this.schedulePhase(this.durations.greetingRetryMs);
  }

  private schedulePhase(delayMs: number): void {
    this.clearPhase();
    this.phaseHandle = this.clock.setTimeout(() => {
      this.phaseHandle = null;
      this.onPhaseTimer();
    }, delayMs);
  }

  private onPhaseTimer(): void {
    const phase = this.phase;
    if (this.disposed || phase === null) {
      return;
    }
    // A retry (or the finalize) must never land inside an active tutor turn.
    // If one started after this phase was armed, check again shortly.
    if (!this.handlers.isTutorIdle()) {
      this.schedulePhase(TUTOR_BUSY_RECHECK_MS);
      return;
    }

    if (phase === "farewell-grace") {
      this.phase = null;
      this.handlers.onNoChildResponseFinalize();
      return;
    }
    if (!this.greetingArmed) {
      this.phase = null;
      return;
    }

    this.greetingAttempt += 1;
    if (this.greetingAttempt <= GREETING_MAX_RETRIES) {
      this.phase = null;
      // Wait for the retry's own turn before counting the next gap.
      this.awaitTutorSettle("retry");
      this.handlers.onGreetingRetry(this.greetingAttempt);
      return;
    }

    // Ladder exhausted: the tutor says goodbye, then the session ends once
    // that farewell has finished playing.
    this.greetingArmed = false;
    this.farewellIssued = true;
    this.phase = null;
    this.awaitTutorSettle("farewell");
    this.handlers.onNoChildResponse();
  }

  /**
   * 10:00: the close instruction turns the mid-session watchdog into the
   * end-phase idle timer. There is exactly one silence timer, so the two can
   * never double-nudge or double-close.
   */
  private switchToEndPhase(): void {
    this.clearSilenceTimer();
    this.clearSilenceFallback();
    this.silenceMode = "end";
    this.silenceStage = "finalize";
    this.silenceWaiting = false;
    this.silenceTurnComplete = false;
    this.silencePlaybackIdle = false;
    this.silenceRemainingMs = this.durations.silenceMs;
    this.restartSilenceStage(this.durations.silenceMs);
  }

  /**
   * Start the stage countdown, or pause it while the tutor is mid-turn. Start
   * only from an observed idle point (see CONVENTIONS rule 19).
   */
  private restartSilenceStage(delayMs: number): void {
    if (this.handlers.isTutorIdle()) {
      this.startSilenceStage(delayMs);
      return;
    }
    this.beginSilenceWait(delayMs);
  }

  private startSilenceStage(delayMs: number): void {
    this.clearSilenceTimer();
    this.clearSilenceFallback();
    this.silenceWaiting = false;
    this.silenceTurnComplete = false;
    this.silencePlaybackIdle = false;
    this.silenceRemainingMs = 0;
    this.silenceDeadline = this.clock.now() + delayMs;
    this.silenceTimerHandle = this.clock.setTimeout(() => {
      this.silenceTimerHandle = null;
      this.onSilenceTimer();
    }, delayMs);
  }

  private beginSilenceWait(remainingMs: number): void {
    this.clearSilenceTimer();
    this.clearSilenceFallback();
    this.silenceWaiting = true;
    this.silenceTurnComplete = false;
    this.silencePlaybackIdle = false;
    this.silenceRemainingMs = remainingMs;
  }

  private settleSilenceWatchdog(): void {
    if (!this.silenceWaiting) {
      return;
    }
    this.clearSilenceFallback();
    this.silenceWaiting = false;
    this.silenceTurnComplete = false;
    this.silencePlaybackIdle = false;
    // Mid-session resumes the paused stage; the end phase restarts on activity.
    const delayMs =
      this.silenceMode === "end"
        ? this.durations.silenceMs
        : Math.max(1, this.silenceRemainingMs);
    this.startSilenceStage(delayMs);
  }

  private onSilenceTimer(): void {
    if (this.disposed || this.silenceMode === null) {
      return;
    }
    // A nudge/finalize must never land inside an active tutor turn.
    if (!this.handlers.isTutorIdle()) {
      this.beginSilenceWait(Math.max(1, this.silenceDeadline - this.clock.now()));
      return;
    }
    if (this.silenceMode === "end") {
      this.silenceMode = null;
      this.silenceStage = "finalize";
      this.handlers.onSilence();
      return;
    }
    if (this.silenceStage === "nudge") {
      // One nudge per silence episode, then the graceful close. The nudge is
      // an injected tutor turn: starting it pauses the close countdown until
      // that turn has settled.
      this.silenceStage = "close";
      this.silenceRemainingMs = this.durations.midSessionCloseMs;
      this.startSilenceStage(this.silenceRemainingMs);
      this.handlers.onChildUnresponsiveNudge();
      return;
    }
    this.silenceMode = null;
    this.silenceStage = "finalize";
    this.handlers.onChildUnresponsiveFinalize();
  }

  private clearPhase(): void {
    if (this.phaseHandle !== null) {
      this.clock.clearTimeout(this.phaseHandle);
      this.phaseHandle = null;
    }
  }

  private clearSettleFallback(): void {
    if (this.settleFallbackHandle !== null) {
      this.clock.clearTimeout(this.settleFallbackHandle);
      this.settleFallbackHandle = null;
    }
  }

  private clearSilenceFallback(): void {
    if (this.silenceFallbackHandle !== null) {
      this.clock.clearTimeout(this.silenceFallbackHandle);
      this.silenceFallbackHandle = null;
    }
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimerHandle !== null) {
      this.clock.clearTimeout(this.silenceTimerHandle);
      this.silenceTimerHandle = null;
    }
  }
}

export interface SessionEstimate {
  readonly usd: number;
  readonly minutes: number;
  readonly micSeconds: number;
  readonly tutorSeconds: number;
  readonly audioInTokens: number;
  readonly audioOutTokens: number;
  readonly textInTokens: number;
  readonly textOutTokens: number;
}

export interface UsageTotals {
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

export interface SessionSnapshot {
  readonly sessionId: string | null;
  readonly state: SessionState;
  readonly sessionFolder: string | null;
  readonly micSeconds: number;
  readonly tutorSeconds: number;
  readonly usageTurns: readonly GeminiUsageMetadata[];
  readonly usageTotals: UsageTotals;
  readonly estimate: SessionEstimate;
  readonly droppedAudioFrames: number;
}

export interface SessionOptions {
  readonly workspacePath: string;
  readonly apiKey: string;
  readonly clock?: Clock;
  readonly durations?: Partial<SessionDurations>;
  readonly model?: string;
  readonly voiceName?: string;
  /** Injectable for tests/tools that do not want to open a real socket. */
  readonly geminiFactory?: (callbacks: SessionGeminiCallbacks) => SessionGemini;
  /** Injectable text model for the after-loop (tests); defaults to §9 route. */
  readonly textModel?: TextModelFn;
}

/** The subset of GeminiLive the session state machine depends on. */
export interface SessionGemini {
  readonly droppedFrames: number;
  connect(): Promise<void>;
  sendAudio(pcm16k: Uint8Array): void;
  sendText(text: string): void;
  sendToolResponses(
    responses: ReadonlyArray<{
      readonly id?: string;
      readonly name: string;
      readonly response: Record<string, unknown>;
    }>,
  ): void;
  close(): void;
}

export interface SessionGeminiCallbacks {
  onAudio(pcm24k: Uint8Array): void;
  onTranscript(role: TranscriptRole, text: string, partial: boolean): void;
  onToolCall(calls: readonly GeminiFunctionCall[]): void;
  onToolCallCancellation(ids: readonly string[]): void;
  onUsage(usage: GeminiUsageMetadata): void;
  onTurnEvent(event: TurnEvent): void;
  onGoAway(timeLeft: string | undefined): void;
  onResumptionUpdate(handle: string, resumable: boolean): void;
  onClose(info: { code: number; reason: string; willReconnect: boolean }): void;
  onReconnected(): void;
  onError(message: string): void;
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

interface FinalizeOutcome {
  readonly folder: string;
  readonly afterStatus: AfterStatus;
  readonly written: readonly string[];
}

/**
 * One child session: package assembly, upstream relay, timers, logging,
 * audio recording, and the finalize sequence.
 */
export class Session {
  readonly workspacePath: string;

  private readonly apiKey: string;
  private readonly clock: Clock;
  private readonly durations: SessionDurations;
  private readonly model: string | undefined;
  private readonly voiceName: string | undefined;
  private readonly geminiFactory: ((callbacks: SessionGeminiCallbacks) => SessionGemini) | null;
  private readonly textModel: TextModelFn | undefined;

  private state: SessionState = "created";
  private pkg: SessionPackage | null = null;
  private log: SessionLog | null = null;
  private gemini: SessionGemini | null = null;
  private timers: SessionTimers | null = null;
  private client: ClientSink | null = null;
  private finalizePromise: Promise<FinalizeOutcome> | null = null;
  private greetingSent = false;
  private endReason: FinalizeReason | null = null;
  /** True from an injected turn / first tutor audio until `turn_complete`. */
  private tutorTurnActive = false;

  private startedAtMs = 0;
  private micBytes = 0;
  private tutorBytes = 0;
  private usageTurns: GeminiUsageMetadata[] = [];
  private usageTotals: UsageTotals = {
    promptTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
  };
  private afterStatus: AfterStatus = "running";
  private written: string[] = [];
  private wavFiles: WaveStampResult[] = [];

  constructor(options: SessionOptions) {
    this.workspacePath = options.workspacePath;
    this.apiKey = options.apiKey;
    this.clock = options.clock ?? systemClock;
    this.durations = { ...DEFAULT_DURATIONS, ...options.durations };
    this.model = options.model;
    this.voiceName = options.voiceName;
    this.geminiFactory = options.geminiFactory ?? null;
    this.textModel = options.textModel;
  }

  get sessionId(): string | null {
    return this.log?.sessionId ?? null;
  }

  get sessionFolder(): string | null {
    return this.log?.folder ?? null;
  }

  get currentState(): SessionState {
    return this.state;
  }

  /** Build the package, create the folder, connect upstream, arm the clock. */
  async start(): Promise<{ sessionId: string; files: SessionPackage["files"] }> {
    if (this.state !== "created") {
      throw new SessionError(`cannot start a session in state ${this.state}`);
    }
    this.state = "starting";
    this.pkg = buildPackage(this.workspacePath);
    this.log = SessionLog.create(this.workspacePath);
    this.log.append("session_start", {
      sessionId: this.log.sessionId,
      files: this.pkg.files.map((file) => file.path),
    });
    this.log.append("package", { files: this.pkg.files });

    const gemini = this.createGemini(this.pkg);
    this.gemini = gemini;

    try {
      await gemini.connect();
    } catch (error) {
      this.state = "error";
      const message = errorMessage(error);
      this.log.append("turn_event", { event: "error", phase: "setup", message });
      this.log.close();
      gemini.close();
      throw error instanceof SessionError ? error : new SessionError(message);
    }

    this.state = "live";
    this.startedAtMs = this.clock.now();
    this.timers = new SessionTimers(this.clock, this.durations, {
      onCloseInstruction: () => this.injectCloseInstruction(),
      onHardCap: () => {
        void this.finalize("timeout");
      },
      onSilence: () => {
        void this.finalize("silence");
      },
      onGreetingRetry: (attempt) => this.injectGreetingRetry(attempt),
      onNoChildResponse: () => this.injectNoResponseFarewell(),
      onNoChildResponseFinalize: () => {
        void this.finalize("no_child_response");
      },
      onChildUnresponsiveNudge: () => this.injectChildUnresponsiveNudge(),
      onChildUnresponsiveFinalize: () => {
        void this.finalize("child_unresponsive");
      },
      isTutorIdle: () => !this.tutorTurnActive,
    });
    this.timers.start();
    // Tests attach a client before start; the proxy attaches the WS right after
    // /api/start resolves. Whichever happens last triggers the greeting.
    this.maybeGreet();

    return { sessionId: this.log.sessionId, files: this.pkg.files };
  }

  attachClient(client: ClientSink): void {
    this.client = client;
    this.maybeGreet();
  }

  detachClient(): void {
    this.client = null;
  }

  handleClientAudio(pcm16k: Uint8Array): void {
    if (this.state !== "live" || this.log === null || this.gemini === null) {
      return;
    }
    this.log.appendMic(pcm16k);
    this.micBytes += pcm16k.byteLength;
    this.gemini.sendAudio(pcm16k);
  }

  handleChildAction(action: ChildAction): void {
    if (this.state !== "live" || this.log === null || this.gemini === null) {
      return;
    }
    // The child tapped the canvas: end the current silence episode even if the
    // action itself turns out to be malformed.
    this.timers?.noteChildInput();
    let text: string;
    try {
      text = formatChildAction(action);
    } catch (error) {
      const message = errorMessage(error);
      this.log.append("child_action", { action: action.kind, value: action.value, error: message });
      this.sendError(message);
      return;
    }
    this.log.append("child_action", { action: action.kind, value: action.value, text });
    try {
      this.gemini.sendText(text);
      this.timers?.disarmGreetingWatchdog();
      this.timers?.notifyActivity();
    } catch (error) {
      const message = errorMessage(error);
      this.log.append("turn_event", { event: "error", phase: "child_action", message });
      this.sendError(message);
    }
  }

  /** Surface a malformed client message without breaking the relay. */
  notifyClientError(message: string): void {
    if (this.log !== null && this.state !== "done") {
      this.log.append("turn_event", { event: "error", phase: "client", message });
    }
    this.client?.sendJson({ type: "error", message });
  }

  /** Inject one text turn upstream (also used by scripts/probe-file.ts). */
  sendTextTurn(text: string, phase: SessionInjectPhase = "manual"): void {
    if (this.state !== "live" || this.log === null || this.gemini === null) {
      throw new SessionError(`cannot inject text in state ${this.state}`);
    }
    this.gemini.sendText(text);
    this.tutorTurnActive = true;
    this.log.append("inject", { text, phase });
    this.timers?.notifyActivity();
    this.timers?.noteTutorActivity();
  }

  /**
   * The client's playback queue drained after the current tutor turn
   * (PROTOCOL §2 `tutor_playback_idle`). Recorded as the audio-end timestamp
   * and used to arm the start-failsafe / farewell grace.
   */
  handleTutorPlaybackIdle(): void {
    if (this.state !== "live" || this.log === null) {
      return;
    }
    this.log.append("turn_event", { event: "tutor_playback_idle" });
    // A drain mid-turn is just a gap in the stream: it must not settle the
    // ladder, or a retry could still land inside the tutor's own speech.
    if (!this.tutorTurnActive) {
      this.timers?.noteTutorPlaybackIdle();
    }
  }

  /** Idempotent finalize; every path runs the same end sequence. */
  finalize(reason: FinalizeReason): Promise<string> {
    if (this.finalizePromise === null) {
      this.endReason = reason;
      this.finalizePromise = this.doFinalize(reason).then((outcome) => outcome.folder);
    }
    return this.finalizePromise;
  }

  getStatus(): {
    afterStatus: AfterStatus;
    written: readonly string[];
    reason: FinalizeReason | null;
  } {
    return { afterStatus: this.afterStatus, written: this.written, reason: this.endReason };
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      state: this.state,
      sessionFolder: this.sessionFolder,
      micSeconds: this.micBytes / (MIC_FORMAT.sampleRate * 2),
      tutorSeconds: this.tutorBytes / (TUTOR_FORMAT.sampleRate * 2),
      usageTurns: this.usageTurns,
      usageTotals: { ...this.usageTotals },
      estimate: this.estimate(),
      droppedAudioFrames: this.gemini?.droppedFrames ?? 0,
    };
  }

  estimate(): SessionEstimate {
    const micSeconds = this.micBytes / (MIC_FORMAT.sampleRate * 2);
    const tutorSeconds = this.tutorBytes / (TUTOR_FORMAT.sampleRate * 2);
    const audioInTokens = micSeconds * TOKENS_PER_AUDIO_SECOND;
    const audioOutTokens = tutorSeconds * TOKENS_PER_AUDIO_SECOND;
    const textInTokens = Math.max(0, this.usageTotals.promptTokens - audioInTokens);
    const textOutTokens = Math.max(0, this.usageTotals.responseTokens - audioOutTokens);
    const usd =
      (audioInTokens * RATES_USD_PER_MILLION.audioIn +
        audioOutTokens * RATES_USD_PER_MILLION.audioOut +
        textInTokens * RATES_USD_PER_MILLION.textIn +
        textOutTokens * RATES_USD_PER_MILLION.textOut) /
      1_000_000;
    const minutes =
      this.startedAtMs === 0 ? 0 : Math.max(0, this.clock.now() - this.startedAtMs) / 60_000;
    return {
      usd,
      minutes,
      micSeconds,
      tutorSeconds,
      audioInTokens,
      audioOutTokens,
      textInTokens,
      textOutTokens,
    };
  }

  private createGemini(pkg: SessionPackage): SessionGemini {
    const callbacks: SessionGeminiCallbacks = {
      onAudio: (pcm24k) => this.onAudio(pcm24k),
      onTranscript: (role, text, partial) => this.onTranscript(role, text, partial),
      onToolCall: (calls) => this.onToolCall(calls),
      onToolCallCancellation: (ids) => this.onToolCallCancellation(ids),
      onUsage: (usage) => this.onUsage(usage),
      onTurnEvent: (event) => this.onTurnEvent(event),
      onGoAway: (timeLeft) => this.onGoAway(timeLeft),
      onResumptionUpdate: (handle, resumable) => this.onResumptionUpdate(handle, resumable),
      onClose: (info) => this.onUpstreamClose(info),
      onReconnected: () => this.onReconnected(),
      onError: (message) => this.onUpstreamError(message),
    };

    if (this.geminiFactory !== null) {
      return this.geminiFactory(callbacks);
    }

    return new GeminiLive({
      apiKey: this.apiKey,
      model: this.model ?? "models/gemini-3.8-live",
      voiceName: this.voiceName ?? "Kore",
      systemInstruction: pkg.systemInstruction,
      callbacks,
    });
  }

  private onAudio(pcm24k: Uint8Array): void {
    if (this.state !== "live" || this.log === null) {
      return;
    }
    this.tutorTurnActive = true;
    this.log.appendTutor(pcm24k);
    this.tutorBytes += pcm24k.byteLength;
    this.client?.sendBinary(pcm24k);
    this.timers?.notifyActivity();
    this.timers?.noteTutorActivity();
  }

  private onTranscript(role: TranscriptRole, text: string, partial: boolean): void {
    if (this.state !== "live" || this.log === null) {
      return;
    }
    this.log.append("transcript", { role, text, partial });
    this.client?.sendJson({ type: "transcript", role, text, partial });
    if (role === "child") {
      // The child is there: stop the start-failsafe ladder on the first sign of
      // speech (interim or final). Raw mic frames are continuous and do not count.
      this.timers?.disarmGreetingWatchdog();
      this.timers?.noteChildInput();
    } else {
      // Tutor speech means the child is (naturally) quiet: pause the
      // mid-session silence countdown until this turn settles.
      this.timers?.noteTutorActivity();
    }
    if (!partial) {
      this.timers?.notifyActivity();
    }
  }

  private onToolCall(calls: readonly GeminiFunctionCall[]): void {
    if (this.state !== "live" || this.log === null || this.gemini === null) {
      return;
    }
    const responses: Array<{
      id?: string;
      name: string;
      response: Record<string, unknown>;
    }> = [];

    for (const call of calls) {
      this.log.append("tool_call", {
        id: call.id,
        name: call.name,
        args: call.args ?? {},
      });
      try {
        const execution = executeToolCall(call);
        if (execution.beat !== undefined && execution.beat !== null) {
          this.emitBeat(execution.beat);
        }
        if (execution.canvas !== undefined && execution.canvas !== null) {
          this.emitCanvas(execution.canvas);
        }
        this.log.append("tool_result", {
          id: call.id,
          name: call.name,
          response: execution.response,
        });
        responses.push({ id: call.id, name: call.name, response: execution.response });
      } catch (error) {
        const message = errorMessage(error);
        const response = { ok: false, error: message };
        this.log.append("tool_result", { id: call.id, name: call.name, response });
        responses.push({ id: call.id, name: call.name, response });
        if (!(error instanceof ToolValidationError)) {
          this.sendError(message);
        }
      }
    }

    try {
      this.gemini.sendToolResponses(responses);
      // The model continues speaking after the tool response: a new turn.
      this.tutorTurnActive = true;
      this.timers?.notifyActivity();
      this.timers?.noteTutorActivity();
    } catch (error) {
      const message = errorMessage(error);
      this.log.append("turn_event", { event: "error", phase: "tool_response", message });
      this.sendError(message);
    }
  }

  private onToolCallCancellation(ids: readonly string[]): void {
    if (this.state !== "live" || this.log === null) {
      return;
    }
    this.log.append("turn_event", { event: "tool_call_cancelled", ids });
    this.client?.sendJson({ type: "turn", event: "interrupted" });
  }

  private onUsage(usage: GeminiUsageMetadata): void {
    if (this.state !== "live" || this.log === null) {
      return;
    }
    this.usageTurns.push(usage);
    this.usageTotals.promptTokens += usage.promptTokenCount ?? 0;
    this.usageTotals.responseTokens += usage.responseTokenCount ?? 0;
    this.usageTotals.totalTokens += usage.totalTokenCount ?? 0;
    this.usageTotals.cachedTokens += usage.cachedContentTokenCount ?? 0;
    this.log.append("usage", {
      ...usage,
      running: { ...this.usageTotals },
      estimateUsd: this.estimate().usd,
    });
    this.timers?.notifyActivity();
  }

  private onTurnEvent(event: TurnEvent): void {
    if (this.state !== "live" || this.log === null) {
      return;
    }
    this.log.append("turn_event", { event });
    this.client?.sendJson({ type: "turn", event });
    if (event === "turn_complete") {
      this.tutorTurnActive = false;
      this.timers?.notifyActivity();
      this.timers?.noteTutorTurnComplete();
    } else if (event === "interrupted") {
      this.tutorTurnActive = false;
      this.timers?.noteTutorInterrupted();
    }
  }

  private onGoAway(timeLeft: string | undefined): void {
    if (this.log === null || this.state === "done" || this.state === "error") {
      return;
    }
    this.log.append("turn_event", { event: "go_away", timeLeft });
  }

  private onResumptionUpdate(handle: string, resumable: boolean): void {
    if (this.log === null || this.state !== "live") {
      return;
    }
    // Handles are long-lived secrets for the session; record only that one arrived.
    this.log.append("turn_event", {
      event: "resumption_update",
      resumable,
      handleLength: handle.length,
    });
  }

  private onUpstreamClose(info: { code: number; reason: string; willReconnect: boolean }): void {
    if (this.log === null || this.state === "done" || this.state === "error") {
      return;
    }
    this.log.append("turn_event", {
      event: "upstream_close",
      code: info.code,
      reason: info.reason,
      willReconnect: info.willReconnect,
    });
    if (!info.willReconnect && this.state === "live") {
      void this.finalize("timeout");
    }
  }

  private onReconnected(): void {
    if (this.log === null || this.state !== "live") {
      return;
    }
    this.log.append("turn_event", { event: "upstream_reconnected" });
  }

  private onUpstreamError(message: string): void {
    if (this.log === null || this.state === "done" || this.state === "error") {
      return;
    }
    this.log.append("turn_event", { event: "error", phase: "upstream", message });
    this.sendError(message);
  }

  private injectCloseInstruction(): void {
    if (this.state !== "live" || this.log === null || this.gemini === null) {
      return;
    }
    try {
      this.sendTextTurn(CLOSE_INSTRUCTION, "close");
      this.client?.sendJson({ type: "inject", text: CLOSE_INSTRUCTION });
    } catch (error) {
      const message = errorMessage(error);
      this.log.append("turn_event", { event: "error", phase: "inject", message });
      this.sendError(message);
    }
  }

  /** Once, right after setup and once a client can actually hear the audio. */
  private maybeGreet(): void {
    if (
      this.greetingSent ||
      this.state !== "live" ||
      this.client === null ||
      this.log === null ||
      this.gemini === null
    ) {
      return;
    }
    this.greetingSent = true;
    try {
      this.sendTextTurn(GREETING_INSTRUCTION, "greeting");
      this.timers?.armGreetingWatchdog();
      // The mid-session watchdog starts counting only once this greeting turn
      // has settled; the greeting failsafe still owns the no-response case.
      this.timers?.armChildSilenceWatchdog();
    } catch (error) {
      const message = errorMessage(error);
      this.log.append("turn_event", { event: "error", phase: "greeting", message });
      this.sendError(message);
    }
  }

  private injectGreetingRetry(attempt: number): void {
    const text =
      GREETING_RETRY_INSTRUCTIONS[attempt - 1] ?? GREETING_RETRY_INSTRUCTIONS[0];
    this.injectFailsafe(text);
  }

  private injectNoResponseFarewell(): void {
    this.injectFailsafe(NO_RESPONSE_FAREWELL);
  }

  /** One mid-session "are you there?" nudge per silence episode (U14.1). */
  private injectChildUnresponsiveNudge(): void {
    this.injectFailsafe(CHILD_UNRESPONSIVE_NUDGE);
  }

  private injectFailsafe(text: string): void {
    if (this.state !== "live" || this.log === null || this.gemini === null) {
      return;
    }
    try {
      this.sendTextTurn(text, "failsafe");
    } catch (error) {
      const message = errorMessage(error);
      this.log.append("turn_event", { event: "error", phase: "failsafe", message });
      this.sendError(message);
    }
  }

  private emitBeat(beat: BeatEvent): void {
    this.log?.append("beat", beat);
    this.client?.sendJson({ type: "beat", beatId: beat.beatId, outcome: beat.outcome });
  }

  private emitCanvas(canvas: CanvasEvent): void {
    this.client?.sendJson({ type: "canvas", tool: canvas.tool, args: canvas.args });
  }

  private sendError(message: string): void {
    this.client?.sendJson({ type: "error", message });
  }

  private async doFinalize(reason: FinalizeReason): Promise<FinalizeOutcome> {
    if (this.state === "created" || this.state === "starting") {
      throw new SessionError(`cannot finalize a session in state ${this.state}`);
    }
    if (this.state === "done" || this.state === "error") {
      return {
        folder: this.log?.folder ?? "",
        afterStatus: this.afterStatus,
        written: this.written,
      };
    }
    if (this.log === null) {
      throw new SessionError("session log is missing");
    }

    this.state = "finalizing";
    this.timers?.dispose();
    this.timers = null;
    this.gemini?.close();

    const log = this.log;
    log.closeAudio();

    let audioError: string | null = null;
    try {
      this.wavFiles = [
        stampPcmToWav(log.micPath, join(log.folder, "mic.wav"), MIC_FORMAT),
        stampPcmToWav(log.tutorPath, join(log.folder, "tutor.wav"), TUTOR_FORMAT),
      ];
    } catch (error) {
      audioError = errorMessage(error);
    }

    const estimate = this.estimate();
    log.append("session_end", {
      reason,
      estimate,
      audio: {
        micSeconds: estimate.micSeconds,
        tutorSeconds: estimate.tutorSeconds,
        files: this.wavFiles.map((file) => file.wavPath),
        error: audioError,
      },
      droppedAudioFrames: this.gemini?.droppedFrames ?? 0,
    });

    this.state = "done";
    this.client?.sendJson({ type: "session_saved", reason, sessionId: log.sessionId });

    if (reason === "no_child_response") {
      // Nothing to reflect on: a session that never got going produces no
      // diary, report or plan revision. Record the skip and finish.
      this.afterStatus = "skipped";
      this.written = [];
      log.append("after", { status: "skipped", written: [], reason });
      log.close();
      this.client?.sendJson({ type: "after", status: "skipped", written: [] });
      return {
        folder: log.folder,
        afterStatus: this.afterStatus,
        written: this.written,
      };
    }

    this.client?.sendJson({ type: "after", status: "running", written: [] });

    try {
      const result = await runAfterLoop({
        sessionId: log.sessionId,
        sessionFolder: log.folder,
        workspacePath: this.workspacePath,
        reason,
        generateText: this.textModel,
      });
      this.afterStatus = result.status;
      this.written = [...result.written];
      // after.ts owns the `after` record; session.ts only mirrors the state so
      // GET /api/session/:id works even if the client socket is gone.
    } catch (error) {
      // The after-loop is designed not to throw; this is a last-resort guard so
      // finalize still completes and the client sees a terminal status.
      this.afterStatus = "error";
      this.written = [];
      log.append("after", { status: "error", written: [], error: errorMessage(error) });
    }

    log.close();
    this.client?.sendJson({
      type: "after",
      status: this.afterStatus,
      written: this.written,
    });

    return {
      folder: log.folder,
      afterStatus: this.afterStatus,
      written: this.written,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
