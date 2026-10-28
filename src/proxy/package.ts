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
  "Слушай ребёнка и опирайся на учебный план ниже; не пересказывай его вслух.",
  "На каждом переходе между этапами урока вызывай инструмент advance_beat.",
  "Рисуй на холсте только через инструменты show_ten_frame, fill_frame, show_number_line, show_choice_cards и show_text.",
  "Когда ребёнок нажимает на холсте, считай это его ответом.",
  "Если ребёнок ошибся — помоги найти ошибку, не говори «неправильно».",
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
 * `lesson-<yyyy-mm-dd>.md`). Lexicographic descending is deterministic and
 * does not depend on filesystem mtimes.
 */
export function findNewestLesson(workspacePath: string): string | null {
  const plansDir = join(workspacePath, "plans");
  if (!existsSync(plansDir) || !statSync(plansDir).isDirectory()) {
    return null;
  }
  const matches = readdirSync(plansDir)
    .filter((name) => /^lesson-.*\.md$/.test(name))
    .sort((a, b) => b.localeCompare(a));
  return matches.length > 0 ? `plans/${matches[0]}` : null;
}

function isFile(absolutePath: string): boolean {
  return existsSync(absolutePath) && statSync(absolutePath).isFile();
}
