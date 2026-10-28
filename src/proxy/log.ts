import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** Record kinds fixed by PROTOCOL §7. */
export type RecordKind =
  | "session_start"
  | "package"
  | "transcript"
  | "tool_call"
  | "tool_result"
  | "beat"
  | "turn_event"
  | "inject"
  | "child_action"
  | "usage"
  | "session_end"
  | "after";

export interface SessionLogOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

/**
 * Append-only JSONL session log plus the two raw PCM audio streams.
 *
 * Audio bytes are written only to `mic.pcm` / `tutor.pcm`; JSONL records stay
 * text-only. Folder names are `<yyyy-mm-dd-hhmm>` and are made unique with a
 * `-b`, `-c`, … suffix if two sessions start in the same minute.
 */
export class SessionLog {
  readonly sessionId: string;
  readonly folder: string;
  readonly jsonlPath: string;
  readonly micPath: string;
  readonly tutorPath: string;

  private readonly now: () => Date;
  private readonly micFd: number;
  private readonly tutorFd: number;
  private closed = false;
  private audioClosed = false;

  private constructor(
    sessionId: string,
    folder: string,
    now: () => Date,
  ) {
    this.sessionId = sessionId;
    this.folder = folder;
    this.jsonlPath = join(folder, "session.jsonl");
    this.micPath = join(folder, "mic.pcm");
    this.tutorPath = join(folder, "tutor.pcm");
    this.now = now;
    this.micFd = openSync(this.micPath, "w");
    this.tutorFd = openSync(this.tutorPath, "w");
  }

  static create(workspacePath: string, options: SessionLogOptions = {}): SessionLog {
    const now = options.now ?? (() => new Date());
    const sessionsDir = join(workspacePath, "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const baseId = formatSessionStamp(now());
    let sessionId = baseId;
    let suffix = 0;
    while (existsSync(join(sessionsDir, sessionId))) {
      suffix += 1;
      sessionId = `${baseId}-${String.fromCharCode("b".charCodeAt(0) + suffix - 1)}`;
    }

    const folder = join(sessionsDir, sessionId);
    mkdirSync(folder, { recursive: true });
    const log = new SessionLog(sessionId, folder, now);
    appendFileSync(log.jsonlPath, "", "utf8");
    return log;
  }

  append(kind: RecordKind, payload: Record<string, unknown> = {}): void {
    if (this.closed) {
      throw new Error("session log is closed");
    }
    // The record kind is fixed by the call site and always wins: payloads may
    // carry their own `kind` field (e.g. child_action's choice/tenframe).
    const record = { ts: this.now().toISOString(), ...payload, kind };
    appendFileSync(this.jsonlPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  appendMic(bytes: Uint8Array): void {
    this.writeAudio(this.micFd, bytes);
  }

  appendTutor(bytes: Uint8Array): void {
    this.writeAudio(this.tutorFd, bytes);
  }

  /** Flush and close only the audio streams, so WAV stamping can run. */
  closeAudio(): void {
    if (this.audioClosed) {
      return;
    }
    closeSync(this.micFd);
    closeSync(this.tutorFd);
    this.audioClosed = true;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closeAudio();
    this.closed = true;
  }

  private writeAudio(fd: number, bytes: Uint8Array): void {
    if (this.audioClosed) {
      throw new Error("session audio log is closed");
    }
    if (bytes.byteLength === 0) {
      return;
    }
    writeSync(fd, bytes);
  }
}

/** `<yyyy-mm-dd-hhmm>` in the host's local time (manual, not locale-dependent). */
export function formatSessionStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-"),
    [pad(date.getHours()), pad(date.getMinutes())].join(""),
  ].join("-");
}
