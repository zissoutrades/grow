import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { currentLocale, type Locale } from "./locale";

export interface PackageFile {
  /** Path relative to the workspace folder, using forward slashes. */
  readonly path: string;
  readonly bytes: number;
}

export interface SessionPackage {
  /** One system-instruction text in the active locale, ready for Gemini's setup message. */
  readonly systemInstruction: string;
  /** Files that contributed to the instruction, in composition order. */
  readonly files: readonly PackageFile[];
}

export class PackageError extends Error {
  readonly missing: readonly string[];

  constructor(message: string, missing: readonly string[] = []) {
    super(message);
    this.name = "PackageError";
    this.missing = missing;
  }
}

const REQUIRED_FILES = [
  "config/tutor.md",
  "config/curriculum.md",
  "memory/child.md",
] as const;

const RUNTIME_INSTRUCTIONS: Record<Locale, string> = {
  ru: [
    "Ты — голосовой репетитор по математике для ребёнка шести лет.",
    "Говори только по-русски, короткими фразами, по одной мысли за раз.",
    "Отвечай и пиши только по-русски кириллицей.",
    "Слушай ребёнка и опирайся на учебный план ниже; не пересказывай его вслух.",
    "Состояние холста — источник истины о клетках и виджетах; формулируй следующий вопрос по состоянию холста, а не по предыдущим догадкам ребёнка.",
    "На каждом переходе между этапами урока вызывай инструмент advance_beat.",
    "Вызывай advance_beat, когда начинаешь новый этап, перед вопросом этого этапа. Затем задай вопрос и дождись ответа ребёнка, прежде чем вызывать advance_beat для следующего этапа.",
    "После того как ты задал вопрос, тихо ждать ответа ребёнка — правильно и ожидаемо. Никогда не произноси режиссёрские ремарки, комментарии или разметку вроде <!-- ... --> — это никогда не звучит вслух.",
    "К концу первого перехода между этапами что-то должно появиться на холсте — не оставляй холст пустым.",
    "Рисуй на холсте только через инструменты show_ten_frame, fill_frame, show_number_line, show_choice_cards и show_text.",
    "Когда ребёнок нажимает на холсте, считай это его ответом.",
    "Если ребёнок ошибся — помоги найти ошибку, не говори «неправильно».",
    "В конце занятия подведи персональный итог: что у ребёнка получилось легко, что было трудным, и что ждёт его в следующий раз, — вместо шаблонной похвалы.",
  ].join("\n"),
  en: [
    "You are a voice math tutor for a six-year-old child.",
    "Speak only English, in short phrases, one thought at a time.",
    "Answer and write only in English, using Latin letters.",
    "Listen to the child and follow the lesson plan below; do not read it aloud.",
    "The canvas state is the source of truth about cells and widgets; base your next question on the canvas state, not on the child's earlier guesses.",
    "At every transition between lesson beats, call the advance_beat tool.",
    "Call advance_beat when you begin a new beat, before you ask that beat's question. Then ask the question and wait for the child's answer before calling advance_beat for the next beat.",
    "By the end of the first beat transition something must appear on the canvas — never leave it empty.",
    "Draw on the canvas only through the show_ten_frame, fill_frame, show_number_line, show_choice_cards and show_text tools.",
    "When the child taps the canvas, treat that as their answer.",
    "Never count for the child: the child says the numbers. Count only to confirm what the child already counted.",
    "End every turn with a question to the child; never announce a step and then wait silently.",
    "After asking a question, waiting quietly for the child's answer is correct and expected. Never speak stage directions, comments, or markup such as <!-- ... --> — those are never said aloud.",
    "At the end of the session, give a personal summary: what came easily, what was hard, and what comes next time — not generic praise.",
  ].join("\n"),
};

interface PackageCopy {
  readonly noLesson: string;
  readonly canvasEmpty: string;
}

const PACKAGE_COPY: Record<Locale, PackageCopy> = {
  ru: {
    noLesson: "=== план урока ===\nПлан урока пока не составлен.",
    canvasEmpty: "Состояние холста: холст пуст.",
  },
  en: {
    noLesson: "=== lesson plan ===\nNo lesson plan has been made yet.",
    canvasEmpty: "Canvas state: the canvas is empty.",
  },
};

/**
 * Build the deterministic session package from a workspace folder.
 *
 * Order: runtime instructions, tutor config, the optional `config/rules.md`,
 * curriculum, newest lesson plan, child memory, then one line of canvas state
 * (PROTOCOL §4 plus the optional house-rules section). No model calls, no
 * clock.
 */
export function buildPackage(
  workspacePath: string,
  locale: Locale = currentLocale(),
): SessionPackage {
  if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
    throw new PackageError(`workspace folder not found: ${workspacePath}`);
  }

  const missing = REQUIRED_FILES.filter(
    (relativePath) => !isFile(join(workspacePath, relativePath)),
  );
  if (missing.length > 0) {
    throw new PackageError(
      `workspace is missing required files: ${missing.join(", ")}`,
      missing,
    );
  }

  const copy = PACKAGE_COPY[locale];
  const sections: string[] = [RUNTIME_INSTRUCTIONS[locale]];
  const files: PackageFile[] = [];

  const appendFile = (relativePath: string): void => {
    const absolutePath = join(workspacePath, relativePath);
    const contents = readFileSync(absolutePath, "utf8");
    sections.push(`=== ${relativePath} ===\n${contents.trimEnd()}`);
    files.push({ path: relativePath, bytes: Buffer.byteLength(contents, "utf8") });
  };

  appendFile("config/tutor.md");
  if (isFile(join(workspacePath, "config/rules.md"))) {
    appendFile("config/rules.md");
  }
  appendFile("config/curriculum.md");

  const newestLesson = findNewestLesson(workspacePath);
  if (newestLesson !== null) {
    appendFile(newestLesson);
  } else {
    sections.push(copy.noLesson);
  }

  appendFile("memory/child.md");
  sections.push(copy.canvasEmpty);

  return {
    systemInstruction: sections.join("\n\n"),
    files,
  };
}

/**
 * Newest lesson plan by filename (names are date-prefixed by convention:
 * `lesson-<yyyy-mm-dd>.md`, with a same-day collision suffix
 * `lesson-<yyyy-mm-dd>-<hhmm>.md`). The date decides first; within one date a
 * plain name is older than any suffixed revision. A plain lexicographic
 * descending sort would rank `lesson-<date>.md` above
 * `lesson-<date>-<hhmm>.md` (`.` sorts after `-`), so the date and suffix are
 * compared separately. Does not depend on filesystem mtimes.
 */
export function findNewestLesson(workspacePath: string): string | null {
  const plansDir = join(workspacePath, "plans");
  if (!existsSync(plansDir) || !statSync(plansDir).isDirectory()) {
    return null;
  }
  const matches = readdirSync(plansDir)
    .filter((name) => /^lesson-.*\.md$/.test(name))
    .sort((a, b) => compareLessonNames(b, a));
  return matches.length > 0 ? `plans/${matches[0]}` : null;
}

/** Ascending order: date, then plain-before-suffixed, then the suffix text. */
function compareLessonNames(a: string, b: string): number {
  const left = splitLessonName(a);
  const right = splitLessonName(b);
  if (left.date !== right.date) {
    return left.date < right.date ? -1 : 1;
  }
  if (left.suffix !== right.suffix) {
    return left.suffix < right.suffix ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function splitLessonName(name: string): { date: string; suffix: string } {
  const match = /^lesson-(\d{4}-\d{2}-\d{2})(.*)\.md$/.exec(name);
  if (match === null) {
    return { date: name, suffix: "" };
  }
  return { date: match[1], suffix: match[2] };
}

function isFile(absolutePath: string): boolean {
  return existsSync(absolutePath) && statSync(absolutePath).isFile();
}
