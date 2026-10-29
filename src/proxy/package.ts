import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PackageFile {
  /** Path relative to the workspace folder, using forward slashes. */
  readonly path: string;
  readonly bytes: number;
}

export interface SessionPackage {
  /** One Russian system-instruction text, ready for Gemini's setup message. */
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

const RUNTIME_INSTRUCTIONS = [
  "Ты — голосовой репетитор по математике для ребёнка шести лет.",
  "Говори только по-русски, короткими фразами, по одной мысли за раз.",
  "Отвечай и пиши только по-русски кириллицей.",
  "Слушай ребёнка и опирайся на учебный план ниже; не пересказывай его вслух.",
  "Состояние холста — источник истины о клетках и виджетах; формулируй следующий вопрос по состоянию холста, а не по предыдущим догадкам ребёнка.",
  "На каждом переходе между этапами урока вызывай инструмент advance_beat.",
  "К концу первого перехода между этапами что-то должно появиться на холсте — не оставляй холст пустым.",
  "Рисуй на холсте только через инструменты show_ten_frame, fill_frame, show_number_line, show_choice_cards и show_text.",
  "Когда ребёнок нажимает на холсте, считай это его ответом.",
  "Если ребёнок ошибся — помоги найти ошибку, не говори «неправильно».",
  "В конце занятия подведи персональный итог: что у ребёнка получилось легко, что было трудным, и что ждёт его в следующий раз, — вместо шаблонной похвалы.",
].join("\n");

/**
 * Build the deterministic session package from a workspace folder.
 *
 * Order is fixed by PROTOCOL §4: tutor config, curriculum, newest lesson plan,
 * child memory, then one line of canvas state. No model calls, no clock.
 */
export function buildPackage(workspacePath: string): SessionPackage {
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

  const sections: string[] = [RUNTIME_INSTRUCTIONS];
  const files: PackageFile[] = [];

  const appendFile = (relativePath: string): void => {
    const absolutePath = join(workspacePath, relativePath);
    const contents = readFileSync(absolutePath, "utf8");
    sections.push(`=== ${relativePath} ===\n${contents.trimEnd()}`);
    files.push({ path: relativePath, bytes: Buffer.byteLength(contents, "utf8") });
  };

  appendFile("config/tutor.md");
  appendFile("config/curriculum.md");

  const newestLesson = findNewestLesson(workspacePath);
  if (newestLesson !== null) {
    appendFile(newestLesson);
  } else {
    sections.push("=== план урока ===\nПлан урока пока не составлен.");
  }

  appendFile("memory/child.md");
  sections.push("Состояние холста: холст пуст.");

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
