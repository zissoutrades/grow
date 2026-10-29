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
  | "no_child_response";

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
  greetingGraceMs: 5_000,
  greetingRetryMs: 10_000,
  farewellGraceMs: 5_000,
};

export const CLOSE_INSTRUCTION = "Приблизься к финальному биту: рефлексия и прощание.";

/**
 * Start failsafe (owner spec U10.1). The tutor greets first; if the child never
 * answers, two retries lead to a graceful `no_child_response` close.
 */
export const GREETING_INSTRUCTION =
  "Начни занятие сам, не жди, пока ребёнок заговорит: коротко поздоровайся по-русски и сразу переходи к первому биту урока.";

export const GREETING_RETRY_INSTRUCTIONS = [
  "Ребёнок пока не ответил. Коротко спроси по-русски: «Ты меня слышишь?»",
  "Ребёнок всё ещё не отвечает. Ещё раз коротко спроси по-русски: «Ты меня слышишь?»",
] as const;

export const NO_RESPONSE_FAREWELL =
  "Скажи ребёнку по-русски: «Кажется, ты меня не слышишь. Завершаю занятие — перезапусти, когда будешь готов(а).»";

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
  onSilence(): void;
  /** 1-based greeting retry: 1 = first "Ты меня слышишь?", 2 = the second. */
  onGreetingRetry(attempt: number): void;
  /** No child response at all: inject the farewell line. */
  onNoChildResponse(): void;
  /** The farewell has had its grace period: finalize `no_child_response`. */
  onNoChildResponseFinalize(): void;
}

/**
 * Session clock: 10:00 close instruction, 12:00 hard cap, an idle timer
 * (3 min with no model/child activity) armed after the close instruction, and
 * the start failsafe ladder armed after the tutor's opening greeting.
 */
export class SessionTimers {
  private readonly clock: Clock;
  private readonly durations: SessionDurations;
  private readonly handlers: TimerHandlers;
  private closeInstructionHandle: unknown = null;
  private hardCapHandle: unknown = null;
  private silenceHandle: unknown = null;
  private greetingHandle: unknown = null;
  private greetingArmed = false;
  private greetingAttempt = 0;
  private farewellIssued = false;
  private instructionSent = false;
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
      this.instructionSent = true;
      this.handlers.onCloseInstruction();
      this.armSilence();
    }, this.durations.closeInstructionMs);
  }

  /** Called on meaningful model/child activity; restarts the idle timer. */
  notifyActivity(): void {
    if (this.disposed || !this.instructionSent) {
      return;
    }
    this.clearSilence();
    this.armSilence();
  }

  /**
   * Arm the start failsafe after the tutor's greeting: 5 s of child silence →
   * "Ты меня слышишь?", 10 s more → one more retry, 10 s more → farewell, and
   * after the farewell grace period the session finalizes.
   */
  armGreetingWatchdog(): void {
    if (this.disposed || this.greetingArmed || this.farewellIssued) {
      return;
    }
    this.greetingArmed = true;
    this.greetingAttempt = 0;
    this.scheduleGreeting(this.durations.greetingGraceMs);
  }

  /** First child response: stop the ladder. A farewell already spoken is final. */
  disarmGreetingWatchdog(): void {
    if (this.farewellIssued) {
      return;
    }
    this.greetingArmed = false;
    this.clearGreeting();
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
    this.clearSilence();
    this.clearGreeting();
    this.greetingArmed = false;
  }

  private scheduleGreeting(delayMs: number): void {
    this.clearGreeting();
    this.greetingHandle = this.clock.setTimeout(() => {
      this.greetingHandle = null;
      this.onGreetingTimer();
    }, delayMs);
  }

  private onGreetingTimer(): void {
    if (this.disposed || !this.greetingArmed || this.farewellIssued) {
      return;
    }
    this.greetingAttempt += 1;
    if (this.greetingAttempt <= GREETING_MAX_RETRIES) {
      this.handlers.onGreetingRetry(this.greetingAttempt);
      this.scheduleGreeting(this.durations.greetingRetryMs);
      return;
    }

    // Ladder exhausted: the tutor says goodbye, then the session ends.
    this.greetingArmed = false;
    this.farewellIssued = true;
    this.handlers.onNoChildResponse();
    this.scheduleFarewellFinalize();
  }

  private scheduleFarewellFinalize(): void {
    this.clearGreeting();
    this.greetingHandle = this.clock.setTimeout(() => {
      this.greetingHandle = null;
      if (!this.disposed) {
        this.handlers.onNoChildResponseFinalize();
      }
    }, this.durations.farewellGraceMs);
  }

  private clearGreeting(): void {
    if (this.greetingHandle !== null) {
      this.clock.clearTimeout(this.greetingHandle);
      this.greetingHandle = null;
    }
  }

  private armSilence(): void {
    this.clearSilence();
    this.silenceHandle = this.clock.setTimeout(() => {
      this.silenceHandle = null;
      this.handlers.onSilence();
    }, this.durations.silenceMs);
  }

  private clearSilence(): void {
    if (this.silenceHandle !== null) {
      this.clock.clearTimeout(this.silenceHandle);
      this.silenceHandle = null;
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
    this.log.append("inject", { text, phase });
    this.timers?.notifyActivity();
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
    this.log.appendTutor(pcm24k);
    this.tutorBytes += pcm24k.byteLength;
    this.client?.sendBinary(pcm24k);
    this.timers?.notifyActivity();
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
      this.timers?.notifyActivity();
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
      this.timers?.notifyActivity();
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
