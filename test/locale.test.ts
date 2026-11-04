import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSetupMessage } from "../src/proxy/gemini";
import { createServer } from "../src/proxy/index";
import { currentLocale, resolveLocale, sttLanguageCode } from "../src/proxy/locale";
import { buildPackage } from "../src/proxy/package";
import { LOCALE_DICTIONARIES, normalizeLocale, translateFor } from "../src/ui/locale.js";

const REPO_ROOT = join(import.meta.dir, "..");
const TEMPLATE = join(REPO_ROOT, "templates/demo-en");
const CYRILLIC = /[А-Яа-яЁё]/;

const folders: string[] = [];

function englishWorkspace(): string {
  const folder = mkdtempSync(join(tmpdir(), "grow-locale-"));
  folders.push(folder);
  for (const relative of ["config", "plans", "memory"]) {
    mkdirSync(join(folder, relative), { recursive: true });
  }
  writeFileSync(join(folder, "config/tutor.md"), "# Tutor\n\nBe brief.\n");
  writeFileSync(join(folder, "config/curriculum.md"), "# Curriculum\n\nMake ten.\n");
  writeFileSync(join(folder, "memory/child.md"), "# Ivan\n\nAge: 6.\n");
  writeFileSync(join(folder, "plans/lesson-2026-11-02.md"), "# Lesson\n\n1. Make ten.\n");
  return folder;
}

function filesUnder(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const absolute = join(folder, entry.name);
    if (entry.isDirectory()) {
      found.push(...filesUnder(absolute));
    } else {
      found.push(absolute);
    }
  }
  return found;
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("GROW_LOCALE resolution", () => {
  test("only the exact value en switches the locale", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale(undefined)).toBe("ru");
    expect(resolveLocale("ru")).toBe("ru");
    expect(resolveLocale("EN")).toBe("ru");
    expect(resolveLocale("fr")).toBe("ru");
    expect(resolveLocale(" en ")).toBe("ru");
  });

  test("the STT language pin follows the locale", () => {
    expect(sttLanguageCode("en")).toBe("en-US");
    expect(sttLanguageCode("ru")).toBe("ru-RU");
  });

  test("unset environment reads as Russian", () => {
    const previous = process.env.GROW_LOCALE;
    try {
      delete process.env.GROW_LOCALE;
      expect(currentLocale()).toBe("ru");
      process.env.GROW_LOCALE = "en";
      expect(currentLocale()).toBe("en");
    } finally {
      if (previous === undefined) {
        delete process.env.GROW_LOCALE;
      } else {
        process.env.GROW_LOCALE = previous;
      }
    }
  });
});

describe("package locale", () => {
  test("the English runtime instruction is fully English", () => {
    const folder = englishWorkspace();

    const result = buildPackage(folder, "en");

    expect(result.systemInstruction).toContain(
      "You are a voice math tutor for a six-year-old child.",
    );
    expect(result.systemInstruction).toContain("Answer and write only in English, using Latin letters.");
    expect(result.systemInstruction).toContain(
      "Wait for the child to answer your question before advancing the beat. Do not advance the beat in the middle of your own sentence.",
    );
    expect(result.systemInstruction).toContain("Canvas state: the canvas is empty.");
    expect(result.systemInstruction).not.toMatch(CYRILLIC);
  });

  test("buildPackage defaults to GROW_LOCALE", () => {
    const folder = englishWorkspace();
    const previous = process.env.GROW_LOCALE;
    try {
      process.env.GROW_LOCALE = "en";
      expect(buildPackage(folder).systemInstruction).not.toMatch(CYRILLIC);

      delete process.env.GROW_LOCALE;
      expect(buildPackage(folder).systemInstruction).toContain(
        "Ты — голосовой репетитор по математике для ребёнка шести лет.",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.GROW_LOCALE;
      } else {
        process.env.GROW_LOCALE = previous;
      }
    }
  });

  test("the demo template loads as an English session package", () => {
    const result = buildPackage(TEMPLATE, "en");

    expect(result.files.map((file) => file.path)).toEqual([
      "config/tutor.md",
      "config/curriculum.md",
      "plans/lesson-2026-11-02.md",
      "memory/child.md",
    ]);
    expect(result.systemInstruction).toContain("8 + 5");
    expect(result.systemInstruction).toContain("## Season");
    expect(result.systemInstruction).toContain("3. Shapes and measurement.");
    expect(result.systemInstruction.indexOf("## Season")).toBeLessThan(
      result.systemInstruction.indexOf("## Current topic"),
    );
    expect(result.systemInstruction).toContain("Ivan");
    expect(result.systemInstruction).toContain("Latin letters");
    expect(result.systemInstruction).not.toMatch(CYRILLIC);
  });

  test("no template file contains Cyrillic", () => {
    for (const file of filesUnder(TEMPLATE)) {
      expect(readFileSync(file, "utf8")).not.toMatch(CYRILLIC);
    }
  });
});

describe("Gemini setup locale", () => {
  function setupFor(locale: "ru" | "en"): Record<string, unknown> {
    const envelope = createSetupMessage({
      model: "models/gemini-3.8-live",
      voiceName: "Kore",
      systemInstruction: "instruction",
      locale,
    });
    return envelope.setup as Record<string, unknown>;
  }

  test("pins input STT to en-US in English and ru-RU in Russian", () => {
    expect(setupFor("en").inputAudioTranscription).toEqual({ languageCodes: ["en-US"] });
    expect(setupFor("ru").inputAudioTranscription).toEqual({ languageCodes: ["ru-RU"] });
  });

  test("sends the tool descriptions of the same locale", () => {
    const enTools = setupFor("en").tools as Array<{ functionDeclarations: Array<{ description: string }> }>;
    const ruTools = setupFor("ru").tools as Array<{ functionDeclarations: Array<{ description: string }> }>;

    expect(enTools[0].functionDeclarations[0].description).toContain("Mark a transition");
    expect(ruTools[0].functionDeclarations[0].description).toContain("Отметь переход");
  });
});

describe("UI locale dictionary", () => {
  test("ru and en define exactly the same keys", () => {
    expect(Object.keys(LOCALE_DICTIONARIES.en).sort()).toEqual(
      Object.keys(LOCALE_DICTIONARIES.ru).sort(),
    );
  });

  test("every English string is free of Cyrillic", () => {
    for (const value of Object.values(LOCALE_DICTIONARIES.en)) {
      expect(value).not.toMatch(CYRILLIC);
    }
  });

  test("normalizeLocale treats anything but en as Russian", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("EN")).toBe("ru");
    expect(normalizeLocale(undefined)).toBe("ru");
  });

  test("the demo labels are short, natural English", () => {
    expect(translateFor("en", "beat.recall")).toBe("recalling");
    expect(translateFor("en", "beat.present")).toBe("explaining");
    expect(translateFor("en", "beat.attempt")).toBe("trying");
    expect(translateFor("en", "beat.diagnose")).toBe("figuring out");
    expect(translateFor("en", "beat.repair")).toBe("fixing");
    expect(translateFor("ru", "beat.recall")).toBe("вспоминаем");
  });

  test("the console config tab is labelled rules", () => {
    expect(translateFor("en", "console.tab.permissions")).toBe("rules");
    expect(translateFor("ru", "console.tab.permissions")).toBe("правила");
  });

  test("every data-i18n key in both pages exists in both dictionaries", () => {
    const keyPattern = /data-i18n(?:-placeholder|-aria-label)?="([^"]+)"/g;
    for (const page of ["index.html", "console.html"]) {
      const html = readFileSync(join(REPO_ROOT, "src/ui", page), "utf8");
      const keys = [...html.matchAll(keyPattern)].map((match) => match[1]);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(LOCALE_DICTIONARIES.ru[key]).toBeDefined();
        expect(LOCALE_DICTIONARIES.en[key]).toBeDefined();
      }
    }
  });
});

describe("GET /api/locale", () => {
  const server = createServer(0);
  const base = `http://127.0.0.1:${server.port}`;

  afterAll(() => {
    server.stop(true);
  });

  test("reports the locale of the running proxy", async () => {
    const previous = process.env.GROW_LOCALE;
    try {
      delete process.env.GROW_LOCALE;
      expect(await (await fetch(`${base}/api/locale`)).json()).toEqual({ locale: "ru" });

      process.env.GROW_LOCALE = "en";
      expect(await (await fetch(`${base}/api/locale`)).json()).toEqual({ locale: "en" });

      process.env.GROW_LOCALE = "EN";
      expect(await (await fetch(`${base}/api/locale`)).json()).toEqual({ locale: "ru" });
    } finally {
      if (previous === undefined) {
        delete process.env.GROW_LOCALE;
      } else {
        process.env.GROW_LOCALE = previous;
      }
    }
  });
});
