import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { currentLocale, type Locale } from "./locale";
import { findNewestLesson } from "./package";
import { generateText, type TextModelFn } from "./text-model";

/**
 * Post-session after-loop (PROTOCOL §7/§9).
 *
 * One text-model call reads the closed session log plus the workspace files and
 * returns `{diary, report, planRevision}` in the active locale. The loop writes exactly
 * three files — `memory/diary/<date>.md`, `reports/<date>-report.md` and a new
 * `plans/lesson-<next-date>.md` — and appends the `after` record to the closed
 * `session.jsonl`.
 *
 * Same-day sessions do not overwrite each other: when the date-named diary or
 * report already exists, the session time (`<date>-<hhmm>`) is inserted, per
 * PROTOCOL §7. A second collision within the same minute falls back to `-b`,
 * `-c`, … so no rehearsal can ever clobber the demo.
 *
 * It never writes `memory/child.md` (or any other memory file) and never
 * throws: any failure (missing key, model error, malformed JSON, disk error)
 * becomes `{status: "error", written: []}` plus an `after` error record, so the
 * finalize path cannot crash.
 */

export type AfterStatus = "running" | "done" | "error" | "skipped";

export interface AfterContext {
  readonly sessionId: string;
  readonly sessionFolder: string;
  readonly workspacePath: string;
  readonly reason: "child_tap" | "parent_console" | "timeout" | "silence" | "child_unresponsive";
  /** Demo locale; defaults to the proxy's `GROW_LOCALE` (Russian when unset). */
  readonly locale?: Locale;
  /** Injectable text model for tests; defaults to the shared §9 route. */
  readonly generateText?: TextModelFn;
  /** Injectable clock, used when the session stamp lacks a date/time and for the no-plan rule. */
  readonly now?: () => Date;
}

export interface AfterResult {
  readonly status: AfterStatus;
  /** Artefact kinds written by the loop: diary, report, plan. */
  readonly written: readonly string[];
}

/** The exact JSON object the text model is asked to return. */
export interface AfterPayload {
  readonly diary: string;
  readonly report: string;
  readonly planRevision: string;
}

/** Workspace-relative paths of the three artefacts. */
export interface AfterFiles {
  readonly diary: string;
  readonly report: string;
  readonly plan: string;
}

export class AfterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AfterError";
  }
}

const WRITTEN_KINDS = ["diary", "report", "plan"] as const;

interface AfterCopy {
  readonly sessionDate: string;
  readonly nextLessonDate: string;
  readonly reason: string;
  readonly lessonHeading: string;
  readonly noLesson: string;
  readonly transcriptHeading: string;
  readonly outcomeHeading: string;
  readonly childRole: string;
  readonly tutorRole: string;
  readonly beat: (beatId: string, outcome: string) => string;
  readonly childAction: (kind: string, text: string) => string;
  readonly tool: (name: string, args: string) => string;
  readonly emptyTranscript: string;
  readonly jsonInstruction: string;
  readonly cost: (usd: string) => string;
  readonly duration: (minutes: string) => string;
  readonly droppedFrames: (frames: string) => string;
}

const SYSTEM_PROMPTS: Record<Locale, string> = {
  ru: [
    "Ты — методист и аналитик учебных занятий для ребёнка шести лет.",
    "По стенограмме занятия и файлам рабочей папки ты пишешь три текста по-русски.",
    "Ответ — строго один JSON-объект без пояснений и без markdown-ограждений.",
    'Схема: {"diary": "…", "report": "…", "planRevision": "…"}',
    "diary — короткая тёплая запись для родителя, 3–5 предложений: как прошло занятие, что получилось.",
    "report — разбор для родителя: что происходило, какие были сигналы (успехи, трудности, ошибки), что это значит для следующих занятий.",
    "planRevision — полный план следующего занятия в том же формате, что файл plans/lesson-*.md: заголовок с датой, нумерованные шаги по битам (recall, present, attempt, diagnose, repair, extend, consolidate, reflect, close).",
    "Опирайся только на стенограмму и файлы; не выдумывай фактов. Никаких пояснений вокруг JSON.",
  ].join("\n"),
  en: [
    "You are a teaching methodologist and session analyst for a six-year-old child.",
    "From the session transcript and the workspace files you write three texts in English.",
    "Reply with exactly one JSON object, no commentary and no markdown fences.",
    'Schema: {"diary": "…", "report": "…", "planRevision": "…"}',
    "diary — a short, warm note for the parent, 3–5 sentences: how the session went and what went well.",
    "report — an analysis for the parent: what happened, which signals appeared (successes, struggles, mistakes), and what they mean for the next sessions.",
    "planRevision — the full plan for the next session in the same format as plans/lesson-*.md: a dated header and numbered steps for the beats (recall, present, attempt, diagnose, repair, extend, consolidate, reflect, close).",
    "Use only the transcript and the files; do not invent facts. No text around the JSON.",
  ].join("\n"),
};

const AFTER_COPY: Record<Locale, AfterCopy> = {
  ru: {
    sessionDate: "Дата занятия",
    nextLessonDate: "Дата следующего занятия",
    reason: "Причина завершения",
    lessonHeading: "=== план урока ===",
    noLesson: "План урока не найден.",
    transcriptHeading: "=== стенограмма занятия ===",
    outcomeHeading: "=== итог занятия ===",
    childRole: "Ребёнок",
    tutorRole: "Репетитор",
    beat: (beatId, outcome) => `Бит: ${beatId} — ${outcome}`,
    childAction: (kind, text) => `Действие ребёнка (${kind}): ${text}`,
    tool: (name, args) => `Инструмент: ${name} ${args}`,
    emptyTranscript: "(стенограмма пуста)",
    jsonInstruction:
      "Верни JSON-объект с ключами diary, report и planRevision. Всё по-русски.",
    cost: (usd) => `стоимость: $${usd}`,
    duration: (minutes) => `длительность: ${minutes} мин`,
    droppedFrames: (frames) => `потеряно аудиокадров: ${frames}`,
  },
  en: {
    sessionDate: "Session date",
    nextLessonDate: "Next session date",
    reason: "End reason",
    lessonHeading: "=== lesson plan ===",
    noLesson: "No lesson plan found.",
    transcriptHeading: "=== session transcript ===",
    outcomeHeading: "=== session outcome ===",
    childRole: "Child",
    tutorRole: "Tutor",
    beat: (beatId, outcome) => `Beat: ${beatId} — ${outcome}`,
    childAction: (kind, text) => `Child action (${kind}): ${text}`,
    tool: (name, args) => `Tool: ${name} ${args}`,
    emptyTranscript: "(transcript is empty)",
    jsonInstruction:
      "Return a JSON object with the keys diary, report and planRevision. Everything in English.",
    cost: (usd) => `cost: $${usd}`,
    duration: (minutes) => `duration: ${minutes} min`,
    droppedFrames: (frames) => `dropped audio frames: ${frames}`,
  },
};

interface WorkspaceTexts {
  readonly tutor: string;
  readonly curriculum: string;
  readonly child: string;
  readonly lessonPath: string | null;
  readonly lesson: string;
}

interface JournalRecord {
  readonly [key: string]: unknown;
}

export async function runAfterLoop(context: AfterContext): Promise<AfterResult> {
  const model = context.generateText ?? generateText;
  let skippedLines = 0;

  try {
    const locale = context.locale ?? currentLocale();
    const journal = readJournal(context.sessionFolder);
    skippedLines = journal.skipped;
    const now = context.now ?? (() => new Date());
    const sessionDate = sessionDateFor(context, now);
    const sessionTime = sessionTimeFor(context, now);
    const nextLessonDate = nextLessonDateFor(context.workspacePath, sessionDate, now);
    const workspace = readWorkspace(context.workspacePath);

    const prompt = buildPrompt(context, locale, {
      sessionDate,
      nextLessonDate,
      workspace,
      records: journal.records,
    });

    const raw = await model(prompt, SYSTEM_PROMPTS[locale]);
    const payload = parseAfterResponse(raw);
    const files = afterFiles(sessionDate, sessionTime, nextLessonDate, (relativePath) =>
      existsSync(join(context.workspacePath, relativePath)),
    );
    writeArtifacts(context.workspacePath, files, payload);

    const record: Record<string, unknown> = {
      status: "done",
      written: [...WRITTEN_KINDS],
      paths: files,
    };
    if (skippedLines > 0) {
      record.skippedLines = skippedLines;
    }
    appendAfterRecord(context.sessionFolder, record);
    return { status: "done", written: [...WRITTEN_KINDS] };
  } catch (error) {
    const record: Record<string, unknown> = {
      status: "error",
      written: [],
      error: errorMessage(error),
    };
    if (skippedLines > 0) {
      record.skippedLines = skippedLines;
    }
    // Finalize must return even if the session folder itself is unwritable.
    try {
      appendAfterRecord(context.sessionFolder, record);
    } catch {
      // Nothing further to record; the in-memory after status is still "error".
    }
    return { status: "error", written: [] };
  }
}

/**
 * Parse the model's JSON, tolerating markdown fences and leading/trailing prose.
 * Throws `AfterError` when no candidate contains all three non-empty strings.
 */
export function parseAfterResponse(raw: string): AfterPayload {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];

  const fence = /```[a-zA-Z]*\s*([\s\S]*?)```/.exec(trimmed);
  if (fence !== null) {
    candidates.push(fence[1].trim());
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      // Try the next candidate form (fenced or brace-delimited).
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const diary = parsed.diary;
    const report = parsed.report;
    const planRevision = parsed.planRevision;
    if (
      typeof diary === "string" &&
      diary.trim().length > 0 &&
      typeof report === "string" &&
      report.trim().length > 0 &&
      typeof planRevision === "string" &&
      planRevision.trim().length > 0
    ) {
      return { diary, report, planRevision };
    }
  }

  throw new AfterError(
    "text model response is not the expected JSON {diary, report, planRevision}",
  );
}

/**
 * Workspace-relative artefact paths.
 *
 * PROTOCOL §7 same-day naming: the plain date name is used when it is free;
 * otherwise the session time is inserted (`<date>-<hhmm>.md`,
 * `reports/<date>-<hhmm>-report.md`, `plans/lesson-<date>-<hhmm>.md`). The
 * plan can collide with a console `revise_plan`, so it follows the same rule.
 * `exists` is injected so the naming rule is a pure function over a temp
 * folder in tests.
 */
export function afterFiles(
  sessionDate: string,
  sessionTime: string,
  nextLessonDate: string,
  exists: (relativePath: string) => boolean,
): AfterFiles {
  return {
    diary: firstFreePath(
      `memory/diary/${sessionDate}.md`,
      `memory/diary/${sessionDate}-${sessionTime}.md`,
      exists,
    ),
    report: firstFreePath(
      `reports/${sessionDate}-report.md`,
      `reports/${sessionDate}-${sessionTime}-report.md`,
      exists,
    ),
    plan: firstFreePath(
      `plans/lesson-${nextLessonDate}.md`,
      `plans/lesson-${nextLessonDate}-${sessionTime}.md`,
      exists,
    ),
  };
}

/** Prefer `base`; if taken, `suffixed`; then `-b`, `-c`, … (never overwrite). */
export function firstFreePath(
  base: string,
  suffixed: string,
  exists: (relativePath: string) => boolean,
): string {
  if (!exists(base)) {
    return base;
  }
  if (!exists(suffixed)) {
    return suffixed;
  }
  const stem = suffixed.endsWith(".md") ? suffixed.slice(0, -3) : suffixed;
  for (let index = 1; ; index += 1) {
    const candidate = `${stem}-${String.fromCharCode("a".charCodeAt(0) + index)}.md`;
    if (!exists(candidate)) {
      return candidate;
    }
  }
}

/**
 * Next lesson date, shared by the after-loop and the console's `revise_plan`
 * (PROTOCOL §7): one day after the later of the session date and the newest
 * existing lesson plan; with no plans, today.
 */
export function nextLessonDateFor(
  workspacePath: string,
  sessionDate: string,
  now: () => Date = () => new Date(),
): string {
  const newest = findNewestLesson(workspacePath);
  // Same-day revisions carry a time suffix (`lesson-<date>-<hhmm>.md`), so the
  // date is not necessarily followed directly by `.md`.
  const match =
    newest === null ? null : /lesson-(\d{4}-\d{2}-\d{2})(?:-[^/]+)?\.md$/.exec(newest);
  const newestDate = match === null ? null : match[1];
  if (newestDate === null) {
    return formatLocalDate(now());
  }
  const base = newestDate > sessionDate ? newestDate : sessionDate;
  return addDays(base, 1);
}

function buildPrompt(
  context: AfterContext,
  locale: Locale,
  input: {
    readonly sessionDate: string;
    readonly nextLessonDate: string;
    readonly workspace: WorkspaceTexts;
    readonly records: readonly JournalRecord[];
  },
): string {
  const { sessionDate, nextLessonDate, workspace, records } = input;
  const copy = AFTER_COPY[locale];
  const sections: string[] = [
    `${copy.sessionDate}: ${sessionDate}`,
    `${copy.nextLessonDate}: ${nextLessonDate}`,
    `${copy.reason}: ${context.reason}`,
    "",
    `=== config/tutor.md ===\n${workspace.tutor.trimEnd()}`,
    `=== config/curriculum.md ===\n${workspace.curriculum.trimEnd()}`,
    workspace.lessonPath === null
      ? `${copy.lessonHeading}\n${copy.noLesson}`
      : `=== ${workspace.lessonPath} ===\n${workspace.lesson.trimEnd()}`,
    `=== memory/child.md ===\n${workspace.child.trimEnd()}`,
    copy.transcriptHeading,
    buildTranscript(records, copy),
    copy.outcomeHeading,
    buildOutcome(context, records, copy),
    "",
    copy.jsonInstruction,
  ];
  return sections.join("\n");
}

function buildTranscript(records: readonly JournalRecord[], copy: AfterCopy): string {
  const lines: string[] = [];
  for (const record of records) {
    const kind = typeof record.kind === "string" ? record.kind : "";
    if (kind === "transcript" && record.partial === false && typeof record.text === "string") {
      const role = record.role === "child" ? copy.childRole : copy.tutorRole;
      lines.push(`${role}: ${record.text}`);
      continue;
    }
    if (kind === "beat") {
      lines.push(copy.beat(String(record.beatId ?? "?"), String(record.outcome ?? "?")));
      continue;
    }
    // Current records are `kind:"child_action"` with the action kind in
    // `action`; the old payload-clobbered shape (`kind:"choice"`) is still
    // accepted so pre-U5 logs stay readable.
    if (kind === "child_action" || isChildActionKind(kind)) {
      const actionKind = typeof record.action === "string" ? record.action : kind;
      const text = typeof record.text === "string" ? record.text : JSON.stringify(record.value ?? null);
      lines.push(copy.childAction(actionKind, text));
      continue;
    }
    if (kind === "tool_call") {
      lines.push(copy.tool(String(record.name ?? "?"), JSON.stringify(record.args ?? {})));
    }
  }
  return lines.length > 0 ? lines.join("\n") : copy.emptyTranscript;
}

function buildOutcome(
  context: AfterContext,
  records: readonly JournalRecord[],
  copy: AfterCopy,
): string {
  const end = records.find((record) => record.kind === "session_end");
  if (end === undefined) {
    return `reason: ${context.reason}`;
  }
  const estimate = isRecord(end.estimate) ? end.estimate : null;
  const parts = [`reason: ${context.reason}`];
  if (estimate !== null && typeof estimate.usd === "number") {
    parts.push(copy.cost(estimate.usd.toFixed(4)));
  }
  if (estimate !== null && typeof estimate.minutes === "number") {
    parts.push(copy.duration(estimate.minutes.toFixed(1)));
  }
  if (typeof end.droppedAudioFrames === "number") {
    parts.push(copy.droppedFrames(String(end.droppedAudioFrames)));
  }
  return parts.join("; ");
}

function readWorkspace(workspacePath: string): WorkspaceTexts {
  const lessonPath = findNewestLesson(workspacePath);
  return {
    tutor: readRequired(workspacePath, "config/tutor.md"),
    curriculum: readRequired(workspacePath, "config/curriculum.md"),
    child: readRequired(workspacePath, "memory/child.md"),
    lessonPath,
    lesson: lessonPath === null ? "" : readRequired(workspacePath, lessonPath),
  };
}

function readRequired(workspacePath: string, relativePath: string): string {
  const absolutePath = join(workspacePath, relativePath);
  if (!existsSync(absolutePath)) {
    throw new AfterError(`workspace file missing: ${relativePath}`);
  }
  return readFileSync(absolutePath, "utf8");
}

interface Journal {
  readonly records: readonly JournalRecord[];
  readonly skipped: number;
}

function readJournal(sessionFolder: string): Journal {
  const path = join(sessionFolder, "session.jsonl");
  if (!existsSync(path)) {
    return { records: [], skipped: 0 };
  }
  const records: JournalRecord[] = [];
  let skipped = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated line (interrupted write) must not discard the rest of the
      // journal; the count is recorded in the `after` record.
      skipped += 1;
      continue;
    }
    if (isRecord(parsed)) {
      records.push(parsed);
    } else {
      skipped += 1;
    }
  }
  return { records, skipped };
}

function writeArtifacts(
  workspacePath: string,
  files: AfterFiles,
  payload: AfterPayload,
): void {
  const write = (relativePath: string, text: string): void => {
    const absolutePath = join(workspacePath, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  };
  write(files.diary, payload.diary);
  write(files.report, payload.report);
  write(files.plan, payload.planRevision);
}

function appendAfterRecord(sessionFolder: string, payload: Record<string, unknown>): void {
  const record = { ts: new Date().toISOString(), kind: "after", ...payload };
  appendFileSync(join(sessionFolder, "session.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}

function sessionDateFor(context: AfterContext, now: () => Date): string {
  const match =
    /^(\d{4}-\d{2}-\d{2})/.exec(context.sessionId) ??
    /(\d{4}-\d{2}-\d{2})/.exec(basename(context.sessionFolder));
  if (match !== null) {
    return match[1];
  }
  return formatLocalDate(now());
}

/** `hhmm` local time, the same-day artefact suffix shared with the console. */
export function formatTimeSuffix(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** `hhmm` from the session stamp (the folder name), else the injected clock. */
function sessionTimeFor(context: AfterContext, now: () => Date): string {
  const match =
    /^\d{4}-\d{2}-\d{2}-(\d{2})(\d{2})/.exec(context.sessionId) ??
    /\d{4}-\d{2}-\d{2}-(\d{2})(\d{2})/.exec(basename(context.sessionFolder));
  if (match !== null) {
    return `${match[1]}${match[2]}`;
  }
  return formatTimeSuffix(now());
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new AfterError(`invalid ISO date: ${date}`);
  }
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function formatLocalDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isChildActionKind(value: string): boolean {
  return value === "choice" || value === "tenframe" || value === "numberline";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
