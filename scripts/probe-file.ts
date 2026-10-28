/**
 * Synthetic end-to-end probe: stream a 16 kHz mono PCM file (or silence) into
 * a real Gemini Live session through the proxy core, then print the received
 * audio duration, transcripts, tool calls, usage, estimate, and session folder.
 *
 *   GEMINI_API_KEY=... bun run scripts/probe-file.ts [--file mic.pcm]
 *                                                    [--workspace path]
 *                                                    [--text "…"]
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Session, type ClientSink } from "../src/proxy/session";
import type { RecordKind } from "../src/proxy/log";

interface ProbeArgs {
  readonly file: string | null;
  readonly workspace: string | null;
  readonly text: string | null;
  readonly help: boolean;
}

interface TranscriptLine {
  readonly role: string;
  readonly text: string;
  readonly partial: boolean;
}

interface JournalRecord {
  readonly kind: RecordKind;
  readonly [key: string]: unknown;
}

const FRAME_BYTES = 3200;
const FRAME_MS = 100;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    console.error(
      "GEMINI_API_KEY is not set.\n" +
        "Export it first, e.g.:\n" +
        "  export GEMINI_API_KEY='…'\n" +
        "  bun run scripts/probe-file.ts",
    );
    process.exitCode = 1;
    return;
  }

  const workspacePath = resolve(
    args.workspace ?? process.env.WORKSPACE_PATH ?? "sessions/.probe-workspace",
  );
  seedWorkspace(workspacePath);

  const pcm = args.file === null ? silence(3) : readPcmFile(resolve(args.file));
  console.log(`workspace: ${workspacePath}`);
  console.log(
    args.file === null
      ? "input: 3 s of synthetic silence, plus one text turn to elicit a reply"
      : `input: ${(pcm.byteLength / 32000).toFixed(2)} s from ${args.file}`,
  );

  const transcripts: TranscriptLine[] = [];
  const liveEvents: string[] = [];
  let turnCount = 0;
  let turnWaiter: (() => void) | null = null;

  const waitForTurn = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolvePromise) => {
      const timeout = setTimeout(() => {
        turnWaiter = null;
        resolvePromise(false);
      }, timeoutMs);
      turnWaiter = () => {
        clearTimeout(timeout);
        resolvePromise(true);
      };
    });

  const sink: ClientSink = {
    sendBinary: () => {
      // Session already writes tutor.pcm; the probe only needs the duration.
    },
    sendJson: (payload: unknown) => {
      if (!isRecord(payload)) {
        return;
      }
      if (payload.type === "transcript") {
        const role = payload.role === "child" ? "child" : "tutor";
        const text = typeof payload.text === "string" ? payload.text : "";
        const partial = payload.partial === true;
        transcripts.push({ role, text, partial });
        return;
      }
      if (payload.type === "turn" && payload.event === "turn_complete") {
        turnCount += 1;
        const waiter = turnWaiter;
        turnWaiter = null;
        waiter?.();
        return;
      }
      if (payload.type === "canvas" || payload.type === "beat") {
        liveEvents.push(JSON.stringify(payload));
        return;
      }
      if (payload.type === "error") {
        liveEvents.push(`error: ${String(payload.message)}`);
      }
    },
  };

  const session = new Session({ workspacePath, apiKey });
  session.attachClient(sink);

  try {
    const started = await session.start();
    console.log(`session: ${started.sessionId}`);
    console.log(`package: ${started.files.map((file) => file.path).join(", ")}`);
  } catch (error) {
    console.error(`start failed: ${messageOf(error)}`);
    process.exitCode = 1;
    return;
  }

  const baselineTurns = turnCount;
  await streamPcm(session, pcm);

  if (args.file === null) {
    const prompt =
      args.text ?? "Поздоровайся с ребёнком по-русски и предложи посчитать до десяти.";
    session.sendTextTurn(prompt);
  }

  if (turnCount === baselineTurns) {
    let completed = await waitForTurn(45_000);
    if (!completed && args.file !== null) {
      session.sendTextTurn(
        args.text ?? "Ответь ребёнку, пожалуйста, коротко и по-русски.",
      );
      completed = await waitForTurn(30_000);
    }
    if (!completed) {
      console.warn("warning: no turn_complete within the timeout");
    }
  }

  const folder = await session.finalize("child_tap");
  const snapshot = session.snapshot();

  console.log("\n=== session summary ===");
  console.log(`tutor audio received: ${snapshot.tutorSeconds.toFixed(2)} s`);
  console.log(`mic audio streamed:   ${snapshot.micSeconds.toFixed(2)} s`);
  console.log(`dropped audio frames: ${snapshot.droppedAudioFrames}`);
  console.log(`usage turns: ${snapshot.usageTurns.length}`);
  for (const [index, usage] of snapshot.usageTurns.entries()) {
    console.log(
      `  turn ${index + 1}: prompt=${usage.promptTokenCount ?? 0} ` +
        `response=${usage.responseTokenCount ?? 0} total=${usage.totalTokenCount ?? 0}`,
    );
  }
  console.log(
    `estimate: $${snapshot.estimate.usd.toFixed(4)} over ` +
      `${snapshot.estimate.minutes.toFixed(2)} min ` +
      `(audio in ${snapshot.estimate.micSeconds.toFixed(1)} s, ` +
      `out ${snapshot.estimate.tutorSeconds.toFixed(1)} s)`,
  );

  console.log("\ntranscripts:");
  const finalTranscripts = transcripts.filter((line) => !line.partial);
  if (finalTranscripts.length === 0) {
    console.log("  (none)");
  }
  for (const line of finalTranscripts) {
    console.log(`  ${line.role}: ${line.text}`);
  }

  console.log("\ncanvas / beat events:");
  if (liveEvents.length === 0) {
    console.log("  (none)");
  }
  for (const event of liveEvents) {
    console.log(`  ${event}`);
  }

  const records = readJournal(join(folder, "session.jsonl"));
  console.log("\ntool calls:");
  const toolCalls = records.filter((record) => record.kind === "tool_call");
  if (toolCalls.length === 0) {
    console.log("  (none)");
  }
  for (const record of toolCalls) {
    console.log(`  ${String(record.name)} ${JSON.stringify(record.args ?? {})}`);
  }

  console.log("\nJSONL record summary:");
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  }
  for (const [kind, count] of [...counts.entries()].sort()) {
    console.log(`  ${kind}: ${count}`);
  }
  const end = records.find((record) => record.kind === "session_end");
  if (end !== undefined) {
    console.log(`  session_end: ${JSON.stringify(end.estimate)}`);
  }
  console.log(`\nsession folder: ${folder}`);
}

async function streamPcm(session: Session, pcm: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < pcm.byteLength) {
    const frame = pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.byteLength));
    session.handleClientAudio(frame);
    offset += frame.byteLength;
    await Bun.sleep(FRAME_MS);
  }
}

function seedWorkspace(workspacePath: string): void {
  const files: Record<string, string> = {
    "config/tutor.md": [
      "# Репетитор",
      "",
      "Ты — добрый голосовой репетитор по математике для ребёнка шести лет.",
      "Говори по-русски, короткими фразами, не больше двух предложений за раз.",
      "Одна задача — один вопрос. Хвали за попытку, а не только за ответ.",
      "Веди ребёнка через этапы: вспомнить, показать, попробовать, разобрать,",
      "исправить, закрепить, отрефлексировать, попрощаться.",
    ].join("\n"),
    "config/curriculum.md": [
      "# Неделя",
      "",
      "Тема недели: состав числа 10.",
      "Цель: ребёнок раскладывает 10 на пары и объясняет свой выбор.",
    ].join("\n"),
    "memory/child.md": [
      "# Ребёнок",
      "",
      "Шесть лет. Любит считать предметы вслух.",
      "Лучше понимает на тен-фрейме, чем на числовой прямой.",
      "После ошибки полезно спросить: «Как ты это получил?»",
    ].join("\n"),
    [`plans/lesson-${new Date().toISOString().slice(0, 10)}.md`]: [
      "# Урок: состав числа 10",
      "",
      "1. Вспомнить: сколько будет 5 + 5.",
      "2. Показать тен-фрейм с 7 клетками.",
      "3. Попросить дополнить до 10.",
      "4. Разобрать ошибку через пары чисел.",
      "5. Закрепить: 3 + 7 и 7 + 3.",
      "6. Рефлексия и прощание.",
    ].join("\n"),
  };

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(workspacePath, relativePath);
    if (!existsSync(absolute)) {
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, `${contents}\n`, "utf8");
    }
  }
}

function readPcmFile(path: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path));
  if (
    bytes.byteLength >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WAVE"
  ) {
    return extractWavData(bytes);
  }
  return bytes;
}

function extractWavData(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let formatOk = false;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (id === "fmt " && size >= 16) {
      const audioFormat = view.getUint16(dataStart, true);
      const channels = view.getUint16(dataStart + 2, true);
      const sampleRate = view.getUint32(dataStart + 4, true);
      const bits = view.getUint16(dataStart + 14, true);
      formatOk = audioFormat === 1 && channels === 1 && sampleRate === 16_000 && bits === 16;
      if (!formatOk) {
        throw new Error(
          `WAV must be PCM mono 16 kHz 16-bit (got format=${audioFormat}, ` +
            `channels=${channels}, rate=${sampleRate}, bits=${bits})`,
        );
      }
    }
    if (id === "data") {
      if (!formatOk) {
        throw new Error("WAV is missing a 16 kHz mono PCM fmt chunk before data");
      }
      return bytes.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

function silence(seconds: number): Uint8Array {
  return new Uint8Array(16_000 * 2 * seconds);
}

function readJournal(path: string): JournalRecord[] {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalRecord);
}

function parseArgs(argv: readonly string[]): ProbeArgs {
  let file: string | null = null;
  let workspace: string | null = null;
  let text: string | null = null;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--file") {
      file = argv[++index] ?? null;
    } else if (arg === "--workspace") {
      workspace = argv[++index] ?? null;
    } else if (arg === "--text") {
      text = argv[++index] ?? null;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { file, workspace, text, help };
}

function printUsage(): void {
  console.log(
    "usage: GEMINI_API_KEY=… bun run scripts/probe-file.ts " +
      "[--file mic.pcm] [--workspace path] [--text \"…\"]",
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(bytes[offset + i]);
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error: unknown) => {
  console.error(`probe failed: ${messageOf(error)}`);
  process.exitCode = 1;
});
