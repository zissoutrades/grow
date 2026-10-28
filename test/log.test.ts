import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSessionStamp, SessionLog } from "../src/proxy/log";

const folders: string[] = [];
const fixedNow = (): Date => new Date(2026, 9, 28, 15, 30, 0);

function workspace(): string {
  const folder = mkdtempSync(join(tmpdir(), "grow-log-"));
  folders.push(folder);
  return folder;
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("formatSessionStamp", () => {
  test("formats the local date as yyyy-mm-dd-hhmm", () => {
    expect(formatSessionStamp(new Date(2026, 0, 2, 3, 4))).toBe("2026-01-02-0304");
  });
});

describe("SessionLog", () => {
  test("creates the session folder and appends JSONL records", () => {
    const folder = workspace();
    const log = SessionLog.create(folder, { now: fixedNow });

    log.append("session_start", { sessionId: log.sessionId, files: ["config/tutor.md"] });
    log.append("transcript", { role: "child", text: "пять", partial: false });
    log.close();

    expect(log.sessionId).toBe("2026-10-28-1530");
    expect(log.folder).toBe(join(folder, "sessions", "2026-10-28-1530"));
    const lines = readFileSync(log.jsonlPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      ts: "2026-10-28T15:30:00.000Z",
      kind: "session_start",
      sessionId: "2026-10-28-1530",
    });
    expect(lines[1]).toMatchObject({
      kind: "transcript",
      role: "child",
      text: "пять",
      partial: false,
    });
  });

  test("streams audio to PCM files without putting bytes in JSONL", () => {
    const folder = workspace();
    const log = SessionLog.create(folder, { now: fixedNow });
    const mic = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const tutor = new Uint8Array([6, 7, 8, 9]);

    log.appendMic(mic);
    log.appendTutor(tutor);
    log.append("transcript", { role: "tutor", text: "привет", partial: false });
    log.closeAudio();

    expect(statSync(log.micPath).size).toBe(6);
    expect(statSync(log.tutorPath).size).toBe(4);
    const jsonl = readFileSync(log.jsonlPath, "utf8");
    expect(jsonl).not.toContain("AAECAwQF");
    expect(jsonl.trim().split("\n")).toHaveLength(1);

    // session_end is appended after the audio files are closed/stamped.
    log.append("session_end", { reason: "child_tap" });
    log.close();
  });

  test("record kind wins over a payload kind field", () => {
    const folder = workspace();
    const log = SessionLog.create(folder, { now: fixedNow });

    log.append("child_action", { kind: "choice", value: { id: "7", label: "7" } });
    log.close();

    const [record] = readFileSync(log.jsonlPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(record.kind).toBe("child_action");
    expect(record.value).toEqual({ id: "7", label: "7" });
  });

  test("makes session ids unique within the same minute", () => {
    const folder = workspace();
    const first = SessionLog.create(folder, { now: fixedNow });
    const second = SessionLog.create(folder, { now: fixedNow });

    expect(first.sessionId).toBe("2026-10-28-1530");
    expect(second.sessionId).toBe("2026-10-28-1530-b");
    first.close();
    second.close();
  });

  test("refuses to append after close", () => {
    const folder = workspace();
    const log = SessionLog.create(folder, { now: fixedNow });
    log.close();

    expect(() => log.append("session_end", { reason: "timeout" })).toThrow(
      "session log is closed",
    );
  });
});
