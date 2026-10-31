import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_RECENTS,
  readRecents,
  recordRecent,
  recentsFilePath,
} from "../src/proxy/recents";

const folders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "grow-recents-"));
  folders.push(folder);
  return folder;
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("readRecents", () => {
  test("a missing file reads as an empty list", () => {
    const filePath = join(tempFolder(), "recents.json");

    expect(readRecents(filePath)).toEqual([]);
  });

  test("a corrupt file reads as an empty list", () => {
    const filePath = join(tempFolder(), "recents.json");
    writeFileSync(filePath, "{not json", "utf8");

    expect(readRecents(filePath)).toEqual([]);
  });

  test("keeps only well-formed entries and orders them most-recent-first", () => {
    const filePath = join(tempFolder(), "recents.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        recents: [
          { path: "/old", lastUsed: "2026-10-01T10:00:00.000Z" },
          { path: "", lastUsed: "2026-10-02T10:00:00.000Z" },
          { path: "/new", lastUsed: "2026-10-03T10:00:00.000Z" },
          { path: 42, lastUsed: "2026-10-04T10:00:00.000Z" },
          { path: "/broken-date", lastUsed: "not a date" },
          { path: "/new", lastUsed: "2026-10-05T10:00:00.000Z" },
        ],
      }),
      "utf8",
    );

    expect(readRecents(filePath)).toEqual([
      { path: "/new", lastUsed: "2026-10-03T10:00:00.000Z" },
      { path: "/old", lastUsed: "2026-10-01T10:00:00.000Z" },
    ]);
  });

  test("caps a hand-edited list at five entries", () => {
    const filePath = join(tempFolder(), "recents.json");
    const recents = Array.from({ length: 8 }, (_value, index) => ({
      path: `/workspace-${index}`,
      lastUsed: `2026-10-0${index + 1}T10:00:00.000Z`,
    }));
    writeFileSync(filePath, JSON.stringify({ recents }), "utf8");

    const result = readRecents(filePath);

    expect(result).toHaveLength(MAX_RECENTS);
    expect(result[0]?.path).toBe("/workspace-7");
  });
});

describe("recordRecent", () => {
  test("records a workspace with an ISO timestamp and readable JSON", () => {
    const filePath = join(tempFolder(), "recents.json");
    const now = new Date("2026-10-30T12:00:00.000Z");

    const result = recordRecent(filePath, "/workspace/alpha", now);

    expect(result).toEqual([
      { path: "/workspace/alpha", lastUsed: "2026-10-30T12:00:00.000Z" },
    ]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ recents: result });
    expect(readFileSync(filePath, "utf8")).toContain("\n  ");
  });

  test("dedupes by path, moving the workspace to the front with a new timestamp", () => {
    const filePath = join(tempFolder(), "recents.json");
    recordRecent(filePath, "/workspace/alpha", new Date("2026-10-01T10:00:00.000Z"));
    recordRecent(filePath, "/workspace/beta", new Date("2026-10-02T10:00:00.000Z"));

    const result = recordRecent(
      filePath,
      "/workspace/alpha",
      new Date("2026-10-03T10:00:00.000Z"),
    );

    expect(result).toEqual([
      { path: "/workspace/alpha", lastUsed: "2026-10-03T10:00:00.000Z" },
      { path: "/workspace/beta", lastUsed: "2026-10-02T10:00:00.000Z" },
    ]);
    expect(readRecents(filePath)).toEqual(result);
  });

  test("caps the store at five entries, dropping the oldest", () => {
    const filePath = join(tempFolder(), "recents.json");
    for (let index = 0; index < MAX_RECENTS + 1; index += 1) {
      recordRecent(
        filePath,
        `/workspace-${index}`,
        new Date(`2026-10-0${index + 1}T10:00:00.000Z`),
      );
    }

    const result = readRecents(filePath);

    expect(result).toHaveLength(MAX_RECENTS);
    expect(result.map((recent) => recent.path)).toEqual([
      "/workspace-5",
      "/workspace-4",
      "/workspace-3",
      "/workspace-2",
      "/workspace-1",
    ]);
  });

  test("an unwritable file logs and never throws", () => {
    const filePath = join(tempFolder(), "missing-dir", "recents.json");

    expect(() => recordRecent(filePath, "/workspace/alpha")).not.toThrow();
    expect(readRecents(filePath)).toEqual([]);
  });
});

describe("recentsFilePath", () => {
  test("honours the GROW_RECENTS_FILE override", () => {
    expect(
      recentsFilePath({
        env: { GROW_RECENTS_FILE: "/tmp/custom-recents.json" },
        cwd: "/repo",
        standalone: false,
      }),
    ).toBe("/tmp/custom-recents.json");
  });

  test("uses cwd in dev and the executable folder in a compiled build", () => {
    expect(recentsFilePath({ env: {}, cwd: "/repo", standalone: false })).toBe(
      "/repo/recents.json",
    );
    expect(
      recentsFilePath({
        env: {},
        execPath: "/opt/grow/grow-windows-x64.exe",
        cwd: "/repo",
        standalone: true,
      }),
    ).toBe("/opt/grow/recents.json");
  });
});
