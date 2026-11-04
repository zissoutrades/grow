import { sttLanguageCode, type Locale } from "./locale";
import { toolDeclarations } from "./tools";

export interface GeminiFunctionCall {
  readonly id?: string;
  readonly name: string;
  readonly args?: unknown;
}

export interface GeminiUsageMetadata {
  readonly promptTokenCount?: number;
  readonly cachedContentTokenCount?: number;
  readonly responseTokenCount?: number;
  readonly toolUsePromptTokenCount?: number;
  readonly thoughtsTokenCount?: number;
  readonly totalTokenCount?: number;
  readonly promptTokensDetails?: ReadonlyArray<{ modality?: string; tokenCount?: number }>;
  readonly responseTokensDetails?: ReadonlyArray<{ modality?: string; tokenCount?: number }>;
}

export type TranscriptRole = "tutor" | "child";
export type TurnEvent = "turn_complete" | "interrupted";

export interface GeminiCallbacks {
  readonly onAudio: (pcm24k: Uint8Array) => void;
  readonly onTranscript: (role: TranscriptRole, text: string, partial: boolean) => void;
  readonly onToolCall: (calls: readonly GeminiFunctionCall[]) => void;
  readonly onToolCallCancellation: (ids: readonly string[]) => void;
  readonly onUsage: (usage: GeminiUsageMetadata) => void;
  readonly onTurnEvent: (event: TurnEvent) => void;
  readonly onGoAway: (timeLeft: string | undefined) => void;
  readonly onResumptionUpdate: (handle: string, resumable: boolean) => void;
  readonly onClose: (info: { code: number; reason: string; willReconnect: boolean }) => void;
  readonly onReconnected: () => void;
  readonly onError: (message: string) => void;
}

export interface GeminiConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly voiceName: string;
  readonly systemInstruction: string;
  /** Demo locale; controls the STT language pin and tool descriptions. */
  readonly locale?: Locale;
  readonly handle?: string;
  readonly callbacks: GeminiCallbacks;
}

export const DEFAULT_MODEL = "models/gemini-3.8-live";
const DEFAULT_VOICE = "Kore";
const ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export class GeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiError";
  }
}

interface SetupWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export interface SetupMessageInput {
  readonly model: string;
  readonly voiceName: string;
  readonly systemInstruction: string;
  readonly locale: Locale;
  readonly handle?: string;
}

/**
 * The Live setup envelope (pure, so tests can assert the STT pin and the
 * locale-dependent tool descriptions without opening a socket).
 */
export function createSetupMessage(input: SetupMessageInput): Record<string, unknown> {
  const setup: Record<string, unknown> = {
    model: input.model,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: input.voiceName || DEFAULT_VOICE },
        },
      },
    },
    systemInstruction: {
      parts: [{ text: input.systemInstruction }],
    },
    tools: [{ functionDeclarations: toolDeclarations(input.locale) }],
    sessionResumption: input.handle === undefined ? {} : { handle: input.handle },
    contextWindowCompression: { slidingWindow: {} },
    inputAudioTranscription: { languageCodes: [sttLanguageCode(input.locale)] },
    outputAudioTranscription: {},
  };
  return { setup };
}

/**
 * Upstream Gemini Live WebSocket. Envelope field names follow the Live API
 * reference verified 2026-10-28.
 *
 * The class owns resumption: the latest `sessionResumptionUpdate.newHandle`
 * is stored, and an unexpected close after setup is retried with that handle.
 */
export class GeminiLive {
  private readonly config: GeminiConfig;
  private socket: WebSocket | null = null;
  private active = false;
  private setupComplete = false;
  private resumptionHandle: string | undefined;
  private setupWaiter: SetupWaiter | null = null;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private droppedAudioFrames = 0;

  constructor(config: GeminiConfig) {
    this.config = config;
    this.resumptionHandle = config.handle;
  }

  get ready(): boolean {
    return this.setupComplete && this.socket?.readyState === WebSocket.OPEN;
  }

  get droppedFrames(): number {
    return this.droppedAudioFrames;
  }

  /** Connect and resolve once Gemini sends `setupComplete`. */
  async connect(): Promise<void> {
    this.active = true;
    await this.openSocket();
  }

  sendAudio(pcm16k: Uint8Array): void {
    if (!this.ready || this.socket === null) {
      this.droppedAudioFrames += 1;
      return;
    }
    this.socket.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            mimeType: "audio/pcm;rate=16000",
            data: Buffer.from(pcm16k).toString("base64"),
          },
        },
      }),
    );
  }

  sendText(text: string): void {
    if (!this.ready || this.socket === null) {
      throw new GeminiError("upstream is not ready");
    }
    this.socket.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete: true,
        },
      }),
    );
  }

  sendToolResponses(
    responses: ReadonlyArray<{
      readonly id?: string;
      readonly name: string;
      readonly response: Record<string, unknown>;
    }>,
  ): void {
    if (!this.ready || this.socket === null) {
      throw new GeminiError("upstream is not ready");
    }
    this.socket.send(
      JSON.stringify({
        toolResponse: { functionResponses: responses },
      }),
    );
  }

  /** Stop the relay and close the socket; disables resumption. */
  close(): void {
    this.active = false;
    this.setupComplete = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearSetupTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null && socket.readyState <= WebSocket.OPEN) {
      socket.close(1000, "session closed");
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const url = `${ENDPOINT}?key=${encodeURIComponent(this.config.apiKey)}`;
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        reject(asGeminiError(error));
        return;
      }
      this.socket = socket;

      const finishReject = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearSetupTimer();
        this.setupWaiter = null;
        reject(error);
      };

      const finishResolve = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearSetupTimer();
        this.setupWaiter = null;
        resolve();
      };

      this.setupWaiter = { resolve: finishResolve, reject: finishReject };
      this.setupTimer = setTimeout(() => {
        finishReject(new GeminiError("upstream setup timed out"));
        if (
          socket.readyState === WebSocket.CONNECTING ||
          socket.readyState === WebSocket.OPEN
        ) {
          socket.close(1000, "setup timeout");
        }
      }, 20_000);

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify(this.buildSetupMessage()));
      });

      socket.addEventListener("message", (event) => {
        void this.handleMessage(event.data);
      });

      socket.addEventListener("error", () => {
        if (!settled) {
          finishReject(new GeminiError("upstream websocket error"));
          return;
        }
        this.config.callbacks.onError("upstream websocket error");
      });

      socket.addEventListener("close", (event) => {
        const wasSetup = this.setupComplete;
        this.setupComplete = false;
        if (this.socket === socket) {
          this.socket = null;
        }
        if (!settled) {
          finishReject(
            new GeminiError(`upstream closed before setup (code ${event.code})`),
          );
          return;
        }
        if (!this.active) {
          this.config.callbacks.onClose({
            code: event.code,
            reason: event.reason,
            willReconnect: false,
          });
          return;
        }
        if (!wasSetup) {
          this.config.callbacks.onClose({
            code: event.code,
            reason: event.reason,
            willReconnect: false,
          });
          return;
        }
        this.scheduleReconnect(event.code, event.reason);
      });
    });
  }

  private scheduleReconnect(code: number, reason: string): void {
    if (this.resumptionHandle === undefined) {
      this.config.callbacks.onError("upstream closed without a resumption handle");
      this.config.callbacks.onClose({ code, reason, willReconnect: false });
      this.active = false;
      return;
    }
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 5) {
      this.config.callbacks.onError("upstream reconnect attempts exhausted");
      this.config.callbacks.onClose({ code, reason, willReconnect: false });
      this.active = false;
      return;
    }
    this.config.callbacks.onClose({ code, reason, willReconnect: true });
    const delayMs = Math.min(500 * this.reconnectAttempts, 4_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.active) {
        return;
      }
      void this.openSocket()
        .then(() => {
          this.reconnectAttempts = 0;
          this.config.callbacks.onReconnected();
        })
        .catch(() => {
          if (this.active) {
            this.scheduleReconnect(code, reason);
          }
        });
    }, delayMs);
  }

  private buildSetupMessage(): Record<string, unknown> {
    return createSetupMessage({
      model: this.config.model,
      voiceName: this.config.voiceName,
      systemInstruction: this.config.systemInstruction,
      locale: this.config.locale ?? "ru",
      handle: this.resumptionHandle,
    });
  }

  private async handleMessage(data: unknown): Promise<void> {
    let text: string;
    try {
      text = await messageToText(data);
    } catch (error) {
      this.config.callbacks.onError(asGeminiError(error).message);
      return;
    }

    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) {
        throw new GeminiError("upstream message is not an object");
      }
      message = parsed;
    } catch (error) {
      this.config.callbacks.onError(asGeminiError(error).message);
      return;
    }

    if (isRecord(message.setupComplete)) {
      this.setupComplete = true;
      this.setupWaiter?.resolve();
      return;
    }

    if (isRecord(message.serverContent)) {
      this.handleServerContent(message.serverContent);
    }

    if (isRecord(message.toolCall) && Array.isArray(message.toolCall.functionCalls)) {
      const calls: GeminiFunctionCall[] = message.toolCall.functionCalls.map(
        (raw: unknown): GeminiFunctionCall => {
          const call = isRecord(raw) ? raw : {};
          return {
            id: typeof call.id === "string" ? call.id : undefined,
            name: typeof call.name === "string" ? call.name : "",
            args: call.args,
          };
        },
      );
      this.config.callbacks.onToolCall(calls);
    }

    if (
      isRecord(message.toolCallCancellation) &&
      Array.isArray(message.toolCallCancellation.ids)
    ) {
      this.config.callbacks.onToolCallCancellation(
        message.toolCallCancellation.ids.filter(
          (id: unknown): id is string => typeof id === "string",
        ),
      );
    }

    if (isRecord(message.usageMetadata)) {
      this.config.callbacks.onUsage(toUsageMetadata(message.usageMetadata));
    }

    if (isRecord(message.goAway)) {
      const timeLeft =
        typeof message.goAway.timeLeft === "string" ? message.goAway.timeLeft : undefined;
      this.config.callbacks.onGoAway(timeLeft);
    }

    if (isRecord(message.sessionResumptionUpdate)) {
      const update = message.sessionResumptionUpdate;
      const newHandle = typeof update.newHandle === "string" ? update.newHandle : "";
      const resumable = update.resumable === true;
      if (resumable && newHandle.length > 0) {
        this.resumptionHandle = newHandle;
      }
      this.config.callbacks.onResumptionUpdate(newHandle, resumable);
    }
  }

  private handleServerContent(content: Record<string, unknown>): void {
    if (isRecord(content.modelTurn) && Array.isArray(content.modelTurn.parts)) {
      for (const rawPart of content.modelTurn.parts) {
        if (!isRecord(rawPart)) {
          continue;
        }
        if (isRecord(rawPart.inlineData)) {
          const data = rawPart.inlineData.data;
          const mimeType = rawPart.inlineData.mimeType;
          if (typeof data === "string" && data.length > 0) {
            this.config.callbacks.onAudio(Buffer.from(data, "base64"));
          }
          if (typeof mimeType === "string" && !mimeType.includes("audio")) {
            this.config.callbacks.onError(`unexpected inline media type: ${mimeType}`);
          }
        }
        if (typeof rawPart.text === "string" && rawPart.text.length > 0) {
          this.config.callbacks.onTranscript("tutor", rawPart.text, false);
        }
      }
    }

    const output = content.outputTranscription;
    if (isRecord(output) && typeof output.text === "string" && output.text.length > 0) {
      this.config.callbacks.onTranscript("tutor", output.text, false);
    }

    const input = content.inputTranscription;
    if (isRecord(input) && typeof input.text === "string" && input.text.length > 0) {
      this.config.callbacks.onTranscript("child", input.text, false);
    }

    const interim = content.interimInputTranscription;
    if (isRecord(interim) && typeof interim.text === "string" && interim.text.length > 0) {
      this.config.callbacks.onTranscript("child", interim.text, true);
    }

    if (content.interrupted === true) {
      this.config.callbacks.onTurnEvent("interrupted");
    }
    if (content.turnComplete === true) {
      this.config.callbacks.onTurnEvent("turn_complete");
    }
  }

  private clearSetupTimer(): void {
    if (this.setupTimer !== null) {
      clearTimeout(this.setupTimer);
      this.setupTimer = null;
    }
  }
}

async function messageToText(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text();
  }
  throw new GeminiError("unsupported upstream message type");
}

function toUsageMetadata(raw: Record<string, unknown>): GeminiUsageMetadata {
  const number = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const details = (value: unknown): ReadonlyArray<{ modality?: string; tokenCount?: number }> =>
    Array.isArray(value)
      ? value.filter(isRecord).map((entry) => ({
          modality: typeof entry.modality === "string" ? entry.modality : undefined,
          tokenCount: number(entry.tokenCount),
        }))
      : [];
  return {
    promptTokenCount: number(raw.promptTokenCount),
    cachedContentTokenCount: number(raw.cachedContentTokenCount),
    responseTokenCount: number(raw.responseTokenCount),
    toolUsePromptTokenCount: number(raw.toolUsePromptTokenCount),
    thoughtsTokenCount: number(raw.thoughtsTokenCount),
    totalTokenCount: number(raw.totalTokenCount),
    promptTokensDetails: details(raw.promptTokensDetails),
    responseTokensDetails: details(raw.responseTokensDetails),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asGeminiError(error: unknown): GeminiError {
  return error instanceof GeminiError ? error : new GeminiError(String(error));
}
