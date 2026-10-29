import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeSessionFrom,
  applyPreset,
  consoleChat,
  consoleState,
  ConsoleError,
  readConsoleConfig,
  readConsoleFiles,
  unifiedDiff,
  writeConsoleConfig,
} from "../src/proxy/console";

const folders: string[] = [];

function workspace(): string {
  const folder = mkdtempSync(join(tmpdir(), "grow-console-"));
  folders.push(folder);
  for (const relative of [
    "config/presets",
    "memory/diary",
    "reports",
    "plans",
    "sessions/2026-10-27-1200",
  ]) {
    mkdirSync(join(folder, relative), { recursive: true });
  }
  writeFileSync(join(folder, "config/tutor.md"), "Ты — тьютор.\nГовори коротко.\n");
  writeFileSync(join(folder, "config/curriculum.md"), "Тема недели: состав числа 10.\n");
  writeFileSync(join(folder, "config/permissions.json"), '{"mic":true}\n');
  writeFileSync(join(folder, "config/presets/gentle.md"), "Ты — очень мягкий тьютор.\n");
  writeFileSync(join(folder, "config/presets/strict.md"), "Ты — строгий тьютор.\n");
  writeFileSync(join(folder, "memory/diary/2026-10-26.md"), "Дневник 26.\n");
  writeFileSync(join(folder, "memory/diary/2026-10-27.md"), "Дневник 27.\n");
  writeFileSync(join(folder, "reports/2026-10-25-report.md"), "Отчёт 25.\n");
  writeFileSync(join(folder, "reports/2026-10-27-report.md"), "Отчёт 27.\n");
  writeFileSync(join(folder, "plans/lesson-2026-10-26.md"), "# Старый план\n");
  writeFileSync(join(folder, "plans/lesson-2026-10-27.md"), "# План 27\n\n1. Повторить 10.\n");
  writeFileSync(
    join(folder, "sessions/2026-10-27-1200/session.jsonl"),
    '{"kind":"session_end","note":"ребёнок справился"}\n',
  );
  return folder;
}

interface FakeCall {
  readonly prompt: string;
  readonly system?: string;
}

function scripted(responses: string[]): {
  generate: (prompt: string, system?: string) => Promise<string>;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const queue = [...responses];
  return {
    calls,
    async generate(prompt, system) {
      calls.push({ prompt, system });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("fake text model ran out of responses");
      }
      return next;
    },
  };
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("workspace reads", () => {
  test("returns the latest diary, report and lesson plan with paths", () => {
    const folder = workspace();

    const files = readConsoleFiles(folder);

    expect(files.diary).toEqual({
      path: "memory/diary/2026-10-27.md",
      content: "Дневник 27.\n",
    });
    expect(files.report?.path).toBe("reports/2026-10-27-report.md");
    expect(files.lesson?.path).toBe("plans/lesson-2026-10-27.md");
    expect(files.lesson?.content).toContain("План 27");
  });

  test("returns config contents and the preset names", () => {
    const folder = workspace();

    const config = readConsoleConfig(folder);

    expect(config.tutor).toContain("Ты — тьютор.");
    expect(config.curriculum).toContain("состав числа 10");
    expect(config.permissions).toBe('{"mic":true}\n');
    expect(config.presets).toEqual(["gentle.md", "strict.md"]);
  });

  test("returns null entries when a folder has no matching files", () => {
    const folder = workspace();
    rmSync(join(folder, "memory/diary"), { recursive: true });
    rmSync(join(folder, "plans/lesson-2026-10-27.md"));

    const files = readConsoleFiles(folder);

    expect(files.diary).toBeNull();
    expect(files.lesson?.path).toBe("plans/lesson-2026-10-26.md");
  });
});

describe("unifiedDiff", () => {
  test("marks removed and added lines with a hunk header", () => {
    const diff = unifiedDiff("старый\nобщий\n", "новый\nобщий\n", "config/tutor.md");

    expect(diff).toContain("--- a/config/tutor.md");
    expect(diff).toContain("+++ b/config/tutor.md");
    expect(diff).toContain("@@");
    expect(diff).toContain("-старый");
    expect(diff).toContain("+новый");
    expect(diff).toContain(" общий");
  });

  test("returns an empty string for identical contents", () => {
    expect(unifiedDiff("одно\n", "одно\n", "config/tutor.md")).toBe("");
  });
});

describe("manager chat loop", () => {
  test("executes read_diary and returns the final reply", async () => {
    const folder = workspace();
    const fake = scripted(['{"tool":"read_diary","args":{}}', "Дневник прочитан."]);

    const result = await consoleChat("Что в дневнике?", {
      workspacePath: folder,
      generateText: fake.generate,
    });

    expect(result.reply).toBe("Дневник прочитан.");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].tool).toBe("read_diary");
    expect(result.actions[0].result).toMatchObject({
      found: true,
      path: "memory/diary/2026-10-27.md",
    });
    expect((result.actions[0].result as { content: string }).content).toContain(
      "Дневник 27",
    );
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].prompt).toContain("Дневник 27");
  });

  test("supports multiple tool rounds for report and plan", async () => {
    const folder = workspace();
    const fake = scripted([
      '{"tool":"read_report","args":{}}',
      '{"tool":"read_plan","args":{}}',
      "Прочитал отчёт и план.",
    ]);

    const result = await consoleChat("Что было и что дальше?", {
      workspacePath: folder,
      generateText: fake.generate,
    });

    expect(result.actions.map((action) => action.tool)).toEqual([
      "read_report",
      "read_plan",
    ]);
    expect(result.reply).toBe("Прочитал отчёт и план.");
  });

  test("edit_config applies a find/replace edit and returns the diff", async () => {
    const folder = workspace();
    const fake = scripted([
      JSON.stringify({
        tool: "edit_config",
        args: {
          path: "config/tutor.md",
          find: "Ты — тьютор.",
          replace: "Ты — добрый тьютор.",
        },
      }),
      "Поправил конфиг.",
    ]);

    const result = await consoleChat("Сделай тьютора добрее", {
      workspacePath: folder,
      generateText: fake.generate,
    });

    expect(result.reply).toBe("Поправил конфиг.");
    const edited = readFileSync(join(folder, "config/tutor.md"), "utf8");
    expect(edited).toContain("Ты — добрый тьютор.");
    const action = result.actions[0];
    expect(action.tool).toBe("edit_config");
    const diff = (action.result as { diff: string }).diff;
    expect(diff).toContain("-Ты — тьютор.");
    expect(diff).toContain("+Ты — добрый тьютор.");
  });

  test("stops after three tool rounds and asks for a final text reply", async () => {
    const folder = workspace();
    const fake = scripted([
      '{"tool":"read_diary","args":{}}',
      '{"tool":"read_diary","args":{}}',
      '{"tool":"read_diary","args":{}}',
      "Больше ничего не нужно.",
    ]);

    const result = await consoleChat("Проверь всё", {
      workspacePath: folder,
      generateText: fake.generate,
    });

    expect(result.actions).toHaveLength(3);
    expect(result.reply).toBe("Больше ничего не нужно.");
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[3].prompt).toContain("Инструменты больше недоступны");
  });

  test("a failed tool is reported to the model instead of aborting the turn", async () => {
    const folder = workspace();
    const fake = scripted([
      '{"tool":"edit_config","args":{"path":"config/permissions.json","content":"{}"}}',
      "Этот файл менять нельзя.",
    ]);

    const result = await consoleChat("Поменяй права", {
      workspacePath: folder,
      generateText: fake.generate,
    });

    expect(result.reply).toBe("Этот файл менять нельзя.");
    const action = result.actions[0];
    expect(action.result).toHaveProperty("error");
    expect(readFileSync(join(folder, "config/permissions.json"), "utf8")).toBe(
      '{"mic":true}\n',
    );
  });

  test("revise_plan writes the next dated plan from the latest session", async () => {
    const folder = workspace();
    const revised = "# План 28\n\n1. Повторить состав 10.\n";
    const fake = scripted([
      '{"tool":"revise_plan","args":{}}',
      revised,
      "План обновлён.",
    ]);

    const result = await consoleChat("Пересмотри план", {
      workspacePath: folder,
      generateText: fake.generate,
    });

    expect(result.reply).toBe("План обновлён.");
    expect(result.actions[0].tool).toBe("revise_plan");
    expect((result.actions[0].result as { path: string }).path).toBe(
      "plans/lesson-2026-10-28.md",
    );
    expect(existsSync(join(folder, "plans/lesson-2026-10-28.md"))).toBe(true);
    expect(readFileSync(join(folder, "plans/lesson-2026-10-28.md"), "utf8")).toContain(
      "Повторить состав 10",
    );
    // The diff baseline is the revised plan, not the (new, empty) target file.
    const diff = (result.actions[0].result as { diff: string }).diff;
    expect(diff).toContain("-# План 27");
    expect(diff).toContain("-1. Повторить 10.");
    expect(diff).toContain("+# План 28");
    expect(diff).toContain("+1. Повторить состав 10.");
    // The revision call is the second model call and sees the session journal.
    expect(fake.calls[1].system).toContain("методист");
    expect(fake.calls[1].prompt).toContain("Журнал сессии");
    expect(fake.calls[1].prompt).toContain("ребёнок справился");
  });

  test("revise_plan does not clobber a plan the after-loop already wrote for the same date", async () => {
    const folder = workspace();
    const afterLoopPlan = "# План 28 от после-цикла\n\n1. Шаг после занятия.\n";
    const calls: FakeCall[] = [];
    const responses = [
      '{"tool":"revise_plan","args":{}}',
      "# План 28 из консоли\n\n1. Шаг из консоли.\n",
      "План обновлён.",
    ];
    const generate = async (prompt: string, system?: string): Promise<string> => {
      calls.push({ prompt, system });
      const next = responses.shift();
      if (next === undefined) {
        throw new Error("fake text model ran out of responses");
      }
      // The second call is the revision itself; the after-loop writes its plan
      // for the same date before the console's own write lands.
      if (calls.length === 2) {
        writeFileSync(join(folder, "plans/lesson-2026-10-28.md"), afterLoopPlan, "utf8");
      }
      return next;
    };

    const result = await consoleChat("Пересмотри план", {
      workspacePath: folder,
      generateText: generate,
      now: () => new Date(2026, 9, 28, 14, 5),
    });

    expect((result.actions[0].result as { path: string }).path).toBe(
      "plans/lesson-2026-10-28-1405.md",
    );
    // The after-loop's plan survives; the console revision gets a time suffix.
    expect(readFileSync(join(folder, "plans/lesson-2026-10-28.md"), "utf8")).toBe(
      afterLoopPlan,
    );
    expect(
      readFileSync(join(folder, "plans/lesson-2026-10-28-1405.md"), "utf8"),
    ).toContain("Шаг из консоли");
  });

  test("revise_plan prompt carries the parent's current chat request", async () => {
    const folder = workspace();
    const request =
      "добавим еще одну сложную карточку, чтобы посчитать двойками до 10: 2, 4, 6, 8, 10";
    const fake = scripted([
      '{"tool":"revise_plan","args":{}}',
      "# План с двойками\n\n1. Считать двойками.\n",
      "План обновлён.",
    ]);

    await consoleChat(request, {
      workspacePath: folder,
      generateText: fake.generate,
    });

    expect(fake.calls[1].prompt).toContain(`Запрос родителя из чата: ${request}`);
    expect(fake.calls[1].prompt).toContain("обязательно отрази его в плане");
  });
});

describe("direct parent edits", () => {
  test("writes the config file and returns a diff", () => {
    const folder = workspace();

    const result = writeConsoleConfig(
      folder,
      "config/tutor.md",
      "Ты — спокойный тьютор.\n",
    );

    expect(result.diff).toContain("-Ты — тьютор.");
    expect(result.diff).toContain("+Ты — спокойный тьютор.");
    expect(readFileSync(join(folder, "config/tutor.md"), "utf8")).toBe(
      "Ты — спокойный тьютор.\n",
    );
  });

  test("refuses to write files outside the two config files", () => {
    const folder = workspace();

    expect(() => writeConsoleConfig(folder, "config/permissions.json", "{}")).toThrow(
      ConsoleError,
    );
  });

  test("preset switch copies the preset over tutor.md and returns a diff", () => {
    const folder = workspace();

    const result = applyPreset(folder, "gentle.md");

    expect(result.applied).toBe(true);
    expect(result.diff).toContain("+Ты — очень мягкий тьютор.");
    expect(readFileSync(join(folder, "config/tutor.md"), "utf8")).toBe(
      "Ты — очень мягкий тьютор.\n",
    );
  });

  test("rejects a preset name that escapes the presets folder", () => {
    const folder = workspace();

    expect(() => applyPreset(folder, "../tutor.md")).toThrow(ConsoleError);
  });
});

describe("console state", () => {
  test("reflects an active child session", () => {
    const folder = workspace();

    const result = consoleState("2026-10-28-1200", folder);

    expect(result.activeSession).toBe("2026-10-28-1200");
    expect(result.workspace).toBe(folder);
  });

  test("selects the newest live session and ignores finished ones", () => {
    const active = activeSessionFrom([
      { sessionId: "2026-10-28-1100", state: "done" },
      { sessionId: "2026-10-28-1200", state: "live" },
      { sessionId: "2026-10-28-1300", state: "finalizing" },
    ]);

    expect(active).toBe("2026-10-28-1200");
  });

  test("reports no active session when the proxy has none", () => {
    expect(consoleState(null, null)).toEqual({ activeSession: null, workspace: null });
    expect(activeSessionFrom([{ sessionId: "x", state: "done" }])).toBeNull();
  });
});

describe("next plan date rule", () => {
  test("revise_plan uses the newest plan date when it is ahead of the session", async () => {
    const folder = workspace();
    writeFileSync(join(folder, "plans/lesson-2026-11-02.md"), "# План 2 ноября\n");
    const fake = scripted([
      '{"tool":"revise_plan","args":{}}',
      "# План 3 ноября\n",
      "План обновлён.",
    ]);

    const result = await consoleChat("Пересмотри план", {
      workspacePath: folder,
      generateText: fake.generate,
    });

    expect((result.actions[0].result as { path: string }).path).toBe(
      "plans/lesson-2026-11-03.md",
    );
    expect(existsSync(join(folder, "plans/lesson-2026-11-03.md"))).toBe(true);
  });

  test("revise_plan uses the session date when it is ahead of the newest plan", async () => {
    const folder = workspace();
    mkdirSync(join(folder, "sessions/2026-10-29-0900"), { recursive: true });
    writeFileSync(
      join(folder, "sessions/2026-10-29-0900/session.jsonl"),
      '{"kind":"session_end"}\n',
    );
    const fake = scripted([
      '{"tool":"revise_plan","args":{}}',
      "# План 30 октября\n",
      "План обновлён.",
    ]);

    const result = await consoleChat("Пересмотри план", {
      workspacePath: folder,
      generateText: fake.generate,
      now: () => new Date(2026, 9, 28),
    });

    expect((result.actions[0].result as { path: string }).path).toBe(
      "plans/lesson-2026-10-30.md",
    );
  });

  test("revise_plan dates the plan today when no plans exist", async () => {
    const folder = workspace();
    rmSync(join(folder, "plans"), { recursive: true });
    const fake = scripted([
      '{"tool":"revise_plan","args":{}}',
      "# План сегодня\n",
      "План обновлён.",
    ]);

    const result = await consoleChat("Пересмотри план", {
      workspacePath: folder,
      generateText: fake.generate,
      now: () => new Date(2026, 9, 28),
    });

    expect((result.actions[0].result as { path: string }).path).toBe(
      "plans/lesson-2026-10-28.md",
    );
    expect(existsSync(join(folder, "plans/lesson-2026-10-28.md"))).toBe(true);
  });
});
