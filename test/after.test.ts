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
  nextLessonDateFor,
  parseAfterResponse,
  runAfterLoop,
  type AfterContext,
} from "../src/proxy/after";

const folders: string[] = [];

interface Fixture {
  readonly workspacePath: string;
  readonly sessionFolder: string;
}

const PAYLOAD = {
  diary: "Сегодня ребёнок уверенно дополнил тен-фрейм до десяти.",
  report: "## Что было\n\nСчитали состав десяти.\n\n## Сигналы\n\nПлюс: уверенный ответ.",
  planRevision: "# Урок: состав десяти\n\n1. Вспомнить: 5 + 5.\n2. Закрепить: 3 + 7.",
};

interface ModelCall {
  readonly prompt: string;
  readonly system: string | undefined;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "grow-after-"));
  folders.push(root);
  const workspacePath = join(root, "workspace");
  for (const relative of ["config", "plans", "memory"]) {
    mkdirSync(join(workspacePath, relative), { recursive: true });
  }
  writeFileSync(join(workspacePath, "config/tutor.md"), "Тьютор: говори коротко.\n");
  writeFileSync(join(workspacePath, "config/curriculum.md"), "Тема недели: состав десяти.\n");
  writeFileSync(join(workspacePath, "memory/child.md"), "Шесть лет, любит тен-фрейм.\n");
  writeFileSync(
    join(workspacePath, "plans/lesson-2026-10-30.md"),
    "# Урок: состав десяти\n\n1. Вспомнить 5 + 5.\n",
  );

  const sessionFolder = join(workspacePath, "sessions", "2026-10-30-0930");
  mkdirSync(sessionFolder, { recursive: true });
  writeFileSync(
    join(sessionFolder, "session.jsonl"),
    [
      record({ kind: "session_start", sessionId: "2026-10-30-0930" }),
      record({ kind: "package", files: [{ path: "config/tutor.md", bytes: 31 }] }),
      record({ kind: "transcript", role: "tutor", text: "Сколько будет 7 + 3?", partial: false }),
      record({ kind: "transcript", role: "child", text: "ПРОМЕЖУТОЧНЫЙ", partial: true }),
      record({ kind: "transcript", role: "child", text: "Десять", partial: false }),
      record({ kind: "beat", beatId: "present", outcome: "ok" }),
      // U1 logs child actions with the payload's own `kind` clobbering the
      // record kind; the after-loop accepts both shapes.
      record({
        kind: "choice",
        value: { id: "7", label: "7" },
        text: "[canvas] ребёнок нажал: карточка 7",
      }),
      record({ kind: "tool_call", name: "show_ten_frame", args: { filled: 7 } }),
      record({
        kind: "session_end",
        reason: "child_tap",
        estimate: { usd: 0.0123, minutes: 8.4 },
        droppedAudioFrames: 0,
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  return { workspacePath, sessionFolder };
}

function context(fixture: Fixture, generateText: AfterContext["generateText"]): AfterContext {
  return {
    sessionId: "2026-10-30-0930",
    sessionFolder: fixture.sessionFolder,
    workspacePath: fixture.workspacePath,
    reason: "child_tap",
    generateText,
  };
}

/** Add a second closed session on the same date (different time). */
function addSession(fixture: Fixture, sessionId: string): string {
  const sessionFolder = join(fixture.workspacePath, "sessions", sessionId);
  mkdirSync(sessionFolder, { recursive: true });
  writeFileSync(
    join(sessionFolder, "session.jsonl"),
    [
      record({ kind: "session_start", sessionId }),
      record({ kind: "transcript", role: "child", text: "Восемь", partial: false }),
      record({
        kind: "session_end",
        reason: "child_tap",
        estimate: { usd: 0.01, minutes: 7.5 },
        droppedAudioFrames: 0,
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  return sessionFolder;
}

function fakeModel(payload: unknown, calls: ModelCall[] = []): AfterContext["generateText"] {
  return async (prompt, system) => {
    calls.push({ prompt, system });
    return typeof payload === "string" ? payload : JSON.stringify(payload);
  };
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("after-loop", () => {
  test("writes diary, report and a new next-lesson plan, then appends the after record", async () => {
    const fixturePaths = fixture();
    const calls: ModelCall[] = [];

    const result = await runAfterLoop(context(fixturePaths, fakeModel(PAYLOAD, calls)));

    expect(result).toEqual({ status: "done", written: ["diary", "report", "plan"] });
    expect(calls).toHaveLength(1);

    const diary = readFileSync(join(fixturePaths.workspacePath, "memory/diary/2026-10-30.md"), "utf8");
    const report = readFileSync(
      join(fixturePaths.workspacePath, "reports/2026-10-30-report.md"),
      "utf8",
    );
    const plan = readFileSync(
      join(fixturePaths.workspacePath, "plans/lesson-2026-10-31.md"),
      "utf8",
    );
    expect(diary).toBe(`${PAYLOAD.diary}\n`);
    expect(report).toBe(`${PAYLOAD.report}\n`);
    expect(plan).toBe(`${PAYLOAD.planRevision}\n`);

    // The session's own plan and the child memory are read, never written.
    expect(readFileSync(join(fixturePaths.workspacePath, "plans/lesson-2026-10-30.md"), "utf8")).toBe(
      "# Урок: состав десяти\n\n1. Вспомнить 5 + 5.\n",
    );
    expect(readFileSync(join(fixturePaths.workspacePath, "memory/child.md"), "utf8")).toBe(
      "Шесть лет, любит тен-фрейм.\n",
    );

    expect(calls[0].system ?? "").toContain("JSON");
    expect(calls[0].prompt).toContain("Сколько будет 7 + 3?");
    expect(calls[0].prompt).toContain("Десять");
    expect(calls[0].prompt).toContain("карточка 7");
    expect(calls[0].prompt).toContain("Тема недели: состав десяти.");
    expect(calls[0].prompt).toContain("Дата следующего занятия: 2026-10-31");
    expect(calls[0].prompt).not.toContain("ПРОМЕЖУТОЧНЫЙ");

    const after = lastRecord(fixturePaths.sessionFolder);
    expect(after.kind).toBe("after");
    expect(after.status).toBe("done");
    expect(after.written).toEqual(["diary", "report", "plan"]);
    expect(after.paths).toEqual({
      diary: "memory/diary/2026-10-30.md",
      report: "reports/2026-10-30-report.md",
      plan: "plans/lesson-2026-10-31.md",
    });
  });

  test("the plan-revision prompt forbids scripting wrong-answer corrections in both locales", async () => {
    for (const locale of ["en", "ru"] as const) {
      const fixturePaths = fixture();
      const calls: ModelCall[] = [];

      await runAfterLoop({
        ...context(fixturePaths, fakeModel(PAYLOAD, calls)),
        locale,
      });

      const system = calls[0].system ?? "";
      if (locale === "en") {
        expect(system).toContain(
          "Never script the tutor's verbal response to a wrong answer in the plan",
        );
        expect(system).toContain(
          "How to respond to a wrong answer is set by the tutor config (config/tutor.md, Method section)",
        );
      } else {
        expect(system).toContain("Никогда не прописывай в плане словесную реакцию на неверный ответ");
        expect(system).toContain("Как реагировать на ошибку, задаёт конфиг тьютора");
      }
    }
  });

  test("the plan-revision prompt forbids counting warm-ups in both locales", async () => {
    for (const locale of ["en", "ru"] as const) {
      const fixturePaths = fixture();
      const calls: ModelCall[] = [];

      await runAfterLoop({
        ...context(fixturePaths, fakeModel(PAYLOAD, calls)),
        locale,
      });

      const system = calls[0].system ?? "";
      if (locale === "en") {
        expect(system).toContain("The recall beat is one short make-ten warm-up question");
        expect(system).toContain("Never open the lesson with counting to ten and then back.");
      } else {
        expect(system).toContain(
          "Бит recall — один короткий вопрос на разминку про состав десятка",
        );
        expect(system).toContain("Никогда не начинай урок с счёта до десяти и обратно.");
      }
    }
  });

  test("a second session on the same date writes time-suffixed diary and report", async () => {
    const fixturePaths = fixture();
    const first = await runAfterLoop(context(fixturePaths, fakeModel(PAYLOAD)));
    expect(first.status).toBe("done");

    const secondFolder = addSession(fixturePaths, "2026-10-30-1000");
    const secondPayload = {
      diary: "Второе занятие: ребёнок сам собрал десятку.",
      report: "## Второе занятие\n\nСигналы: уверенность выросла.",
      planRevision: "# Урок: закрепление\n\n1. Повторить состав десяти.",
    };
    const second = await runAfterLoop({
      sessionId: "2026-10-30-1000",
      sessionFolder: secondFolder,
      workspacePath: fixturePaths.workspacePath,
      reason: "child_tap",
      generateText: fakeModel(secondPayload),
    });

    expect(second).toEqual({ status: "done", written: ["diary", "report", "plan"] });

    // The rehearsal's files survive byte-for-byte.
    expect(
      readFileSync(join(fixturePaths.workspacePath, "memory/diary/2026-10-30.md"), "utf8"),
    ).toBe(`${PAYLOAD.diary}\n`);
    expect(
      readFileSync(join(fixturePaths.workspacePath, "reports/2026-10-30-report.md"), "utf8"),
    ).toBe(`${PAYLOAD.report}\n`);

    // The second session's files carry its session time.
    expect(
      readFileSync(join(fixturePaths.workspacePath, "memory/diary/2026-10-30-1000.md"), "utf8"),
    ).toBe(`${secondPayload.diary}\n`);
    expect(
      readFileSync(
        join(fixturePaths.workspacePath, "reports/2026-10-30-1000-report.md"),
        "utf8",
      ),
    ).toBe(`${secondPayload.report}\n`);

    // Plans never collide: 10-31 from the first run, 11-01 from the second.
    expect(existsSync(join(fixturePaths.workspacePath, "plans/lesson-2026-10-31.md"))).toBe(true);
    expect(existsSync(join(fixturePaths.workspacePath, "plans/lesson-2026-11-01.md"))).toBe(true);

    const after = lastRecord(secondFolder);
    expect(after.paths).toEqual({
      diary: "memory/diary/2026-10-30-1000.md",
      report: "reports/2026-10-30-1000-report.md",
      plan: "plans/lesson-2026-11-01.md",
    });
  });

  test("does not clobber a plan written for the same date by the console", async () => {
    const fixturePaths = fixture();
    const consolePlan = "# План 31 октября из консоли\n\n1. Ответ на запрос родителя.\n";
    const target = join(fixturePaths.workspacePath, "plans/lesson-2026-10-31.md");
    // The console writes the same next-date plan while the after-loop's model
    // call is in flight (the observed defect: the later writer won).
    const model: AfterContext["generateText"] = async () => {
      writeFileSync(target, consolePlan, "utf8");
      return JSON.stringify(PAYLOAD);
    };

    const result = await runAfterLoop(context(fixturePaths, model));

    expect(result).toEqual({ status: "done", written: ["diary", "report", "plan"] });
    // The console revision survives byte-for-byte; the after-loop suffixes its
    // plan with the session time instead of overwriting it.
    expect(readFileSync(target, "utf8")).toBe(consolePlan);
    expect(
      readFileSync(
        join(fixturePaths.workspacePath, "plans/lesson-2026-10-31-0930.md"),
        "utf8",
      ),
    ).toBe(`${PAYLOAD.planRevision}\n`);
    expect(lastRecord(fixturePaths.sessionFolder).paths).toMatchObject({
      plan: "plans/lesson-2026-10-31-0930.md",
    });
  });

  test("extracts the JSON payload when it is wrapped in a code fence", async () => {
    const fixturePaths = fixture();
    const fenced = `\`\`\`json\n${JSON.stringify(PAYLOAD)}\n\`\`\``;

    const result = await runAfterLoop(context(fixturePaths, fakeModel(fenced)));

    expect(result.status).toBe("done");
    expect(
      readFileSync(join(fixturePaths.workspacePath, "memory/diary/2026-10-30.md"), "utf8"),
    ).toBe(`${PAYLOAD.diary}\n`);
  });

  test("records an error and writes no files when the text model fails", async () => {
    const fixturePaths = fixture();
    const memoryBefore = readFileSync(join(fixturePaths.workspacePath, "memory/child.md"), "utf8");

    const result = await runAfterLoop(
      context(fixturePaths, async () => {
        throw new Error("model unavailable");
      }),
    );

    expect(result).toEqual({ status: "error", written: [] });
    expect(existsSync(join(fixturePaths.workspacePath, "memory/diary"))).toBe(false);
    expect(existsSync(join(fixturePaths.workspacePath, "reports"))).toBe(false);
    expect(existsSync(join(fixturePaths.workspacePath, "plans/lesson-2026-10-31.md"))).toBe(false);
    expect(readFileSync(join(fixturePaths.workspacePath, "memory/child.md"), "utf8")).toBe(
      memoryBefore,
    );

    const after = lastRecord(fixturePaths.sessionFolder);
    expect(after.kind).toBe("after");
    expect(after.status).toBe("error");
    expect(after.written).toEqual([]);
    expect(String(after.error)).toContain("model unavailable");
  });

  test("records an error when the model response lacks the required keys", async () => {
    const fixturePaths = fixture();

    const result = await runAfterLoop(
      context(fixturePaths, fakeModel({ diary: "только запись" })),
    );

    expect(result).toEqual({ status: "error", written: [] });
    expect(existsSync(join(fixturePaths.workspacePath, "memory/diary"))).toBe(false);
    expect(lastRecord(fixturePaths.sessionFolder).status).toBe("error");
  });

  test("derives the next lesson date from the later of the session date and newest plan", () => {
    const fixturePaths = fixture();

    expect(nextLessonDateFor(fixturePaths.workspacePath, "2026-10-30")).toBe("2026-10-31");

    writeFileSync(join(fixturePaths.workspacePath, "plans/lesson-2026-11-02.md"), "# future\n");
    expect(nextLessonDateFor(fixturePaths.workspacePath, "2026-10-30")).toBe("2026-11-03");
  });

  test("derives the next lesson date from a time-suffixed newest plan", () => {
    const fixturePaths = fixture();

    writeFileSync(
      join(fixturePaths.workspacePath, "plans/lesson-2026-11-02-1530.md"),
      "# future revision\n",
    );

    expect(nextLessonDateFor(fixturePaths.workspacePath, "2026-10-30")).toBe("2026-11-03");
  });

  test("with no lesson plans, dates the new plan today", async () => {
    const fixturePaths = fixture();
    rmSync(join(fixturePaths.workspacePath, "plans"), { recursive: true });

    expect(
      nextLessonDateFor(fixturePaths.workspacePath, "2026-10-20", () => new Date(2026, 9, 28)),
    ).toBe("2026-10-28");

    const result = await runAfterLoop({
      ...context(fixturePaths, fakeModel(PAYLOAD)),
      now: () => new Date(2026, 9, 30, 9, 30),
    });

    expect(result.status).toBe("done");
    expect(existsSync(join(fixturePaths.workspacePath, "plans/lesson-2026-10-30.md"))).toBe(true);
  });

  test("parseAfterResponse accepts JSON surrounded by prose", () => {
    const payload = parseAfterResponse(`Вот результат:\n${JSON.stringify(PAYLOAD)}\nГотово.`);

    expect(payload).toEqual(PAYLOAD);
  });
});

function record(payload: Record<string, unknown>): string {
  return JSON.stringify({ ts: "2026-10-30T09:30:00.000Z", ...payload });
}

function lastRecord(sessionFolder: string): Record<string, unknown> {
  const lines = readFileSync(join(sessionFolder, "session.jsonl"), "utf8")
    .trim()
    .split("\n");
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

describe("after-loop demo locale", () => {
  test("asks for English artefacts and labels when the locale is en", async () => {
    const fixturePaths = fixture();
    const calls: ModelCall[] = [];

    const result = await runAfterLoop({
      ...context(fixturePaths, fakeModel(PAYLOAD, calls)),
      locale: "en",
    });

    expect(result).toEqual({ status: "done", written: ["diary", "report", "plan"] });
    const system = calls[0].system ?? "";
    const prompt = calls[0].prompt;
    expect(system).toContain("you write three texts in English");
    expect(system).not.toMatch(/[А-Яа-яЁё]/);
    expect(prompt).toContain("Session date: 2026-10-30");
    expect(prompt).toContain("Next session date: 2026-10-31");
    expect(prompt).toContain("Child: Десять");
    expect(prompt).toContain("Tutor: Сколько будет 7 + 3?");
    expect(prompt).toContain("Child action (choice):");
    expect(prompt).toContain("Everything in English.");
    expect(prompt).not.toContain("Дата занятия");
  });

  test("keeps the Russian prompt labels when the locale is unset", async () => {
    const fixturePaths = fixture();
    const calls: ModelCall[] = [];

    await runAfterLoop(context(fixturePaths, fakeModel(PAYLOAD, calls)));

    expect(calls[0].system ?? "").toContain("ты пишешь три текста по-русски");
    expect(calls[0].prompt).toContain("Дата занятия: 2026-10-30");
  });
});
