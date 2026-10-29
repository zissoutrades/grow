import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOSE_INSTRUCTION,
  GREETING_INSTRUCTION,
  GREETING_RETRY_INSTRUCTIONS,
  NO_RESPONSE_FAREWELL,
  Session,
  type ClientSink,
  type SessionGemini,
  type SessionGeminiCallbacks,
} from "../src/proxy/session";
import { FakeClock } from "./fake-clock";

const folders: string[] = [];

function workspace(): string {
  const folder = mkdtempSync(join(tmpdir(), "grow-session-"));
  folders.push(folder);
  for (const relative of ["config", "plans", "memory"]) {
    mkdirSync(join(folder, relative), { recursive: true });
  }
  writeFileSync(join(folder, "config/tutor.md"), "Тьютор.\n");
  writeFileSync(join(folder, "config/curriculum.md"), "Программа.\n");
  writeFileSync(join(folder, "memory/child.md"), "Память.\n");
  writeFileSync(join(folder, "plans/lesson-2026-10-30.md"), "Урок.\n");
  return folder;
}

class FakeGemini implements SessionGemini {
  droppedFrames = 0;
  readonly sentTexts: string[] = [];
  readonly toolResponses: Array<ReadonlyArray<{ name: string }>> = [];
  closed = false;

  constructor(readonly callbacks: SessionGeminiCallbacks) {}

  async connect(): Promise<void> {}

  sendAudio(_pcm16k: Uint8Array): void {}

  sendText(text: string): void {
    this.sentTexts.push(text);
  }

  sendToolResponses(
    responses: ReadonlyArray<{
      readonly id?: string;
      readonly name: string;
      readonly response: Record<string, unknown>;
    }>,
  ): void {
    this.toolResponses.push(responses);
  }

  close(): void {
    this.closed = true;
  }
}

interface Harness {
  session: Session;
  gemini: FakeGemini;
  sink: {
    binary: Uint8Array[];
    json: Array<Record<string, unknown>>;
  };
  clock: FakeClock;
  workspacePath: string;
}

async function startSession(
  durations: Partial<{
    closeInstructionMs: number;
    hardCapMs: number;
    silenceMs: number;
    greetingGraceMs: number;
    greetingRetryMs: number;
    farewellGraceMs: number;
  }> = {},
): Promise<Harness> {
  const clock = new FakeClock();
  let gemini: FakeGemini | null = null;
  const workspacePath = workspace();
  const session = new Session({
    workspacePath,
    apiKey: "test-key",
    clock,
    durations,
    geminiFactory: (callbacks) => {
      gemini = new FakeGemini(callbacks);
      return gemini;
    },
    textModel: async () =>
      JSON.stringify({
        diary: "Сегодня считали до десяти.",
        report: "Ребёнок уверенно дополнил тен-фрейм.",
        planRevision: "# Урок\n\n1. Повторить состав десяти.",
      }),
  });
  const sink = { binary: [] as Uint8Array[], json: [] as Array<Record<string, unknown>> };
  const client: ClientSink = {
    sendBinary: (bytes) => {
      sink.binary.push(bytes);
    },
    sendJson: (payload) => {
      if (isRecord(payload)) {
        sink.json.push(payload);
      }
    },
  };
  session.attachClient(client);
  await session.start();
  if (gemini === null) {
    throw new Error("fake gemini was not created");
  }
  return { session, gemini, sink, clock, workspacePath };
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("Session", () => {
  test("greets first after setup instead of waiting for the child", async () => {
    const { session, gemini } = await startSession();

    expect(gemini.sentTexts[0]).toBe(GREETING_INSTRUCTION);

    const folder = await session.finalize("child_tap");
    const records = readJournal(join(folder, "session.jsonl"));
    const greeting = records.find(
      (record) => record.kind === "inject" && record.phase === "greeting",
    );
    expect(greeting?.text).toBe(GREETING_INSTRUCTION);
  });

  test("greets only once when the client attaches again", async () => {
    const { session, gemini } = await startSession();
    const client: ClientSink = { sendBinary: () => {}, sendJson: () => {} };

    session.attachClient(client);

    expect(gemini.sentTexts).toEqual([GREETING_INSTRUCTION]);
    await session.finalize("child_tap");
  });

  test("walks the no-response failsafe and skips the after-loop", async () => {
    const { session, gemini, clock, sink, workspacePath } = await startSession({
      closeInstructionMs: 100_000,
      hardCapMs: 100_000,
      silenceMs: 100_000,
      greetingGraceMs: 1_000,
      greetingRetryMs: 1_000,
      farewellGraceMs: 500,
    });
    expect(gemini.sentTexts).toEqual([GREETING_INSTRUCTION]);

    clock.advance(1_000);
    expect(gemini.sentTexts).toContain(GREETING_RETRY_INSTRUCTIONS[0]);

    clock.advance(1_000);
    expect(gemini.sentTexts).toContain(GREETING_RETRY_INSTRUCTIONS[1]);

    clock.advance(1_000);
    expect(gemini.sentTexts).toContain(NO_RESPONSE_FAREWELL);
    expect(session.currentState).toBe("live");

    clock.advance(500);
    const folder = await session.finalize("no_child_response");

    expect(session.currentState).toBe("done");
    expect(session.getStatus()).toEqual({
      afterStatus: "skipped",
      written: [],
      reason: "no_child_response",
    });

    const records = readJournal(join(folder, "session.jsonl"));
    const end = records.find((record) => record.kind === "session_end");
    expect(end?.reason).toBe("no_child_response");
    const after = records.find((record) => record.kind === "after");
    expect(after?.status).toBe("skipped");
    expect(after?.written).toEqual([]);

    expect(existsSync(join(folder, "mic.wav"))).toBe(true);
    expect(existsSync(join(folder, "tutor.wav"))).toBe(true);
    expect(sink.json.some((message) => message.type === "session_saved")).toBe(true);
    expect(
      sink.json.some((message) => message.type === "after" && message.status === "skipped"),
    ).toBe(true);

    // Nothing to reflect on: no diary, report or revised plan.
    expect(readdirSync(join(workspacePath, "plans"))).toEqual(["lesson-2026-10-30.md"]);
    expect(existsSync(join(workspacePath, "reports"))).toBe(false);
    expect(existsSync(join(workspacePath, "memory/diary"))).toBe(false);
  });

  test("the first child transcript disarms the start failsafe", async () => {
    const { session, gemini, clock } = await startSession({
      closeInstructionMs: 100_000,
      hardCapMs: 100_000,
      silenceMs: 100_000,
      greetingGraceMs: 1_000,
      greetingRetryMs: 1_000,
      farewellGraceMs: 500,
    });

    gemini.callbacks.onTranscript("child", "Привет", false);
    clock.advance(60_000);

    expect(gemini.sentTexts).toEqual([GREETING_INSTRUCTION]);
    expect(session.currentState).toBe("live");
    await session.finalize("child_tap");
  });

  test("relays audio, logs records, and stamps WAVs at finalize", async () => {
    const { session, gemini, sink } = await startSession();
    const sessionId = session.sessionId;
    if (sessionId === null) {
      throw new Error("session id missing");
    }

    session.handleClientAudio(new Uint8Array(3_200));
    gemini.callbacks.onAudio(new Uint8Array(4_800));
    gemini.callbacks.onTranscript("child", "пять", false);
    gemini.callbacks.onTranscript("tutor", "Молодец", false);
    gemini.callbacks.onUsage({
      promptTokenCount: 100,
      responseTokenCount: 50,
      totalTokenCount: 150,
    });
    gemini.callbacks.onToolCall([
      { id: "call-1", name: "show_ten_frame", args: { filled: 3 } },
    ]);
    gemini.callbacks.onTurnEvent("turn_complete");

    const folder = await session.finalize("child_tap");

    expect(gemini.closed).toBe(true);
    expect(sink.binary).toHaveLength(1);
    expect(sink.json.some((message) => message.type === "canvas")).toBe(true);
    expect(sink.json.some((message) => message.type === "session_saved")).toBe(true);
    expect(sink.json.some((message) => message.type === "after")).toBe(true);
    expect(existsSync(join(folder, "mic.wav"))).toBe(true);
    expect(existsSync(join(folder, "tutor.wav"))).toBe(true);
    expect(existsSync(join(folder, "mic.pcm"))).toBe(false);
    expect(existsSync(join(folder, "tutor.pcm"))).toBe(false);

    const records = readJournal(join(folder, "session.jsonl"));
    const kinds = records.map((record) => record.kind);
    expect(kinds).toContain("session_start");
    expect(kinds).toContain("package");
    expect(kinds).toContain("transcript");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("turn_event");
    expect(kinds).toContain("session_end");
    expect(kinds).toContain("after");
    expect(gemini.toolResponses).toHaveLength(1);
    expect(gemini.toolResponses[0][0].name).toBe("show_ten_frame");

    const end = records.find((record) => record.kind === "session_end");
    expect(end?.reason).toBe("child_tap");
    const estimate = end?.estimate as Record<string, unknown>;
    expect(estimate.usd as number).toBeGreaterThan(0);
    expect(session.getStatus().afterStatus).toBe("done");
    expect(session.currentState).toBe("done");
  });

  test("logs a child action as kind child_action with the action details", async () => {
    const { session, gemini } = await startSession();

    session.handleChildAction({ kind: "choice", value: { id: "7", label: "7" } });
    const folder = await session.finalize("child_tap");

    const records = readJournal(join(folder, "session.jsonl"));
    const action = records.find((record) => record.kind === "child_action");
    expect(action).toBeDefined();
    expect(action?.action).toBe("choice");
    expect(action?.value).toEqual({ id: "7", label: "7" });
    expect(action?.text).toBe("[canvas] ребёнок нажал: карточка 7");
    expect(gemini.sentTexts).toContain("[canvas] ребёнок нажал: карточка 7");
  });

  test("finalize is idempotent", async () => {
    const { session } = await startSession();

    const first = await session.finalize("child_tap");
    const second = await session.finalize("timeout");

    expect(second).toBe(first);
    const records = readJournal(join(first, "session.jsonl"));
    expect(records.filter((record) => record.kind === "session_end")).toHaveLength(1);
  });

  test("injects the close instruction at the configured time", async () => {
    const { session, gemini, clock } = await startSession({
      closeInstructionMs: 1_000,
      hardCapMs: 100_000,
      silenceMs: 50_000,
    });

    clock.advance(1_000);

    expect(gemini.sentTexts).toContain(CLOSE_INSTRUCTION);
    await session.finalize("child_tap");
  });

  test("finalizes with reason silence after the idle timer", async () => {
    const { session, clock } = await startSession({
      closeInstructionMs: 1_000,
      hardCapMs: 100_000,
      silenceMs: 500,
    });

    clock.advance(1_000);
    clock.advance(500);
    const folder = await session.finalize("silence");

    const records = readJournal(join(folder, "session.jsonl"));
    const end = records.find((record) => record.kind === "session_end");
    expect(end?.reason).toBe("silence");
  });

  test("finalizes with reason timeout at the hard cap", async () => {
    const { session, clock } = await startSession({
      closeInstructionMs: 1_000,
      hardCapMs: 2_000,
      silenceMs: 50_000,
    });

    clock.advance(2_000);
    const folder = await session.finalize("timeout");

    const records = readJournal(join(folder, "session.jsonl"));
    const end = records.find((record) => record.kind === "session_end");
    expect(end?.reason).toBe("timeout");
  });
});

function readJournal(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
