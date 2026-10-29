import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackage, findNewestLesson, PackageError } from "../src/proxy/package";

const folders: string[] = [];

function workspace(): string {
  const folder = mkdtempSync(join(tmpdir(), "grow-package-"));
  folders.push(folder);
  for (const relative of [
    "config",
    "plans",
    "memory",
  ]) {
    mkdirSync(join(folder, relative), { recursive: true });
  }
  writeFileSync(join(folder, "config/tutor.md"), "ТЬЮТОР\n");
  writeFileSync(join(folder, "config/curriculum.md"), "ПРОГРАММА\n");
  writeFileSync(join(folder, "memory/child.md"), "ПАМЯТЬ\n");
  writeFileSync(join(folder, "plans/lesson-2026-10-01.md"), "СТАРЫЙ УРОК\n");
  writeFileSync(join(folder, "plans/lesson-2026-10-27.md"), "НОВЫЙ УРОК\n");
  return folder;
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("buildPackage", () => {
  test("composes files in protocol order and appends the canvas line", () => {
    const folder = workspace();

    const result = buildPackage(folder);

    const tutor = result.systemInstruction.indexOf("ТЬЮТОР");
    const curriculum = result.systemInstruction.indexOf("ПРОГРАММА");
    const lesson = result.systemInstruction.indexOf("НОВЫЙ УРОК");
    const child = result.systemInstruction.indexOf("ПАМЯТЬ");
    expect(tutor).toBeGreaterThanOrEqual(0);
    expect(curriculum).toBeGreaterThan(tutor);
    expect(lesson).toBeGreaterThan(curriculum);
    expect(child).toBeGreaterThan(lesson);
    expect(result.systemInstruction).toContain("Состояние холста: холст пуст.");
  });

  test("returns the contributing files with byte lengths", () => {
    const folder = workspace();

    const result = buildPackage(folder);

    expect(result.files).toEqual([
      { path: "config/tutor.md", bytes: Buffer.byteLength("ТЬЮТОР\n") },
      { path: "config/curriculum.md", bytes: Buffer.byteLength("ПРОГРАММА\n") },
      { path: "plans/lesson-2026-10-27.md", bytes: Buffer.byteLength("НОВЫЙ УРОК\n") },
      { path: "memory/child.md", bytes: Buffer.byteLength("ПАМЯТЬ\n") },
    ]);
  });

  test("treats a same-date suffixed plan as newer than the plain plan", () => {
    const folder = workspace();
    writeFileSync(join(folder, "plans/lesson-2026-10-27-1530.md"), "РЕВИЗИЯ\n");
    writeFileSync(join(folder, "plans/lesson-2026-10-27-1530-b.md"), "ВТОРАЯ РЕВИЗИЯ\n");

    expect(findNewestLesson(folder)).toBe("plans/lesson-2026-10-27-1530-b.md");

    // A later date still outranks any same-day suffix.
    writeFileSync(join(folder, "plans/lesson-2026-10-28.md"), "СЛЕДУЮЩИЙ ДЕНЬ\n");
    expect(findNewestLesson(folder)).toBe("plans/lesson-2026-10-28.md");
  });

  test("includes the newest lesson by date-prefixed filename only", () => {
    const folder = workspace();

    const result = buildPackage(folder);

    expect(result.systemInstruction).toContain("НОВЫЙ УРОК");
    expect(result.systemInstruction).not.toContain("СТАРЫЙ УРОК");
    expect(result.files.map((file) => file.path)).not.toContain(
      "plans/lesson-2026-10-01.md",
    );
  });

  test("asks for something on the canvas by the first beat transition", () => {
    const folder = workspace();

    const result = buildPackage(folder);

    expect(result.systemInstruction).toContain(
      "К концу первого перехода между этапами что-то должно появиться на холсте — не оставляй холст пустым.",
    );
    const advanceBeat = result.systemInstruction.indexOf(
      "На каждом переходе между этапами урока вызывай инструмент advance_beat.",
    );
    const kickoff = result.systemInstruction.indexOf("К концу первого перехода");
    expect(kickoff).toBeGreaterThan(advanceBeat);
  });

  test("omits the lesson section when no plan exists", () => {
    const folder = workspace();
    rmSync(join(folder, "plans/lesson-2026-10-01.md"));
    rmSync(join(folder, "plans/lesson-2026-10-27.md"));

    const result = buildPackage(folder);

    expect(findNewestLesson(folder)).toBeNull();
    expect(result.systemInstruction).toContain("План урока пока не составлен.");
    expect(result.files.map((file) => file.path)).toEqual([
      "config/tutor.md",
      "config/curriculum.md",
      "memory/child.md",
    ]);
  });

  test("reports every missing required file", () => {
    const folder = workspace();
    rmSync(join(folder, "config/tutor.md"));
    rmSync(join(folder, "memory/child.md"));

    let caught: unknown;
    try {
      buildPackage(folder);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PackageError);
    const packageError = caught as PackageError;
    expect(packageError.missing).toEqual(["config/tutor.md", "memory/child.md"]);
  });

  test("rejects a missing workspace folder", () => {
    const folder = join(tmpdir(), "grow-package-does-not-exist");

    expect(() => buildPackage(folder)).toThrow(PackageError);
  });
});
