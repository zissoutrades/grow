import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { firstFreePath, formatTimeSuffix, nextLessonDateFor } from "./after";
import { findNewestLesson } from "./package";
import { generateText } from "./text-model";

/**
 * Parent console: the manager agent chat plus the workspace file operations it
 * is allowed to perform. PROTOCOL §10 pins the HTTP shapes; the functions here
 * are the pure/effectful core the proxy routes call.
 *
 * The manager agent runs on `generateText(prompt, system)` (PROTOCOL §9), which
 * has no native function calling. The console therefore uses a tiny text
 * protocol: the model answers either with one JSON object
 * `{"tool":"<name>","args":{...}}` or with plain Russian text that ends the
 * turn. Tool results are appended to the prompt for the next round.
 */

export type GenerateText = (prompt: string, system?: string) => Promise<string>;

export class ConsoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleError";
  }
}

const CONFIG_PATHS = ["config/tutor.md", "config/curriculum.md"] as const;
export type ConfigPath = (typeof CONFIG_PATHS)[number];

const MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_RESULT_CHARS = 16_000;

/** The five tools the manager agent may call. */
export const CONSOLE_TOOLS = [
  "read_diary",
  "read_report",
  "read_plan",
  "edit_config",
  "revise_plan",
] as const;

export type ConsoleToolName = (typeof CONSOLE_TOOLS)[number];

export interface ConsoleToolCall {
  readonly tool: ConsoleToolName;
  readonly args: Record<string, unknown>;
}

export interface ConsoleAction {
  readonly tool: ConsoleToolName;
  readonly args: Record<string, unknown>;
  readonly result: unknown;
}

export interface ConsoleChatResult {
  readonly reply: string;
  readonly actions: readonly ConsoleAction[];
}

export interface ConsoleFileEntry {
  /** Path relative to the workspace folder, using forward slashes. */
  readonly path: string;
  readonly content: string;
}

export interface ConsoleFiles {
  readonly diary: ConsoleFileEntry | null;
  readonly report: ConsoleFileEntry | null;
  readonly lesson: ConsoleFileEntry | null;
}

export interface ConsoleConfig {
  readonly tutor: string | null;
  readonly curriculum: string | null;
  readonly permissions: string | null;
  /** Filenames under `config/presets/` (not paths). */
  readonly presets: readonly string[];
}

export interface ConsoleState {
  readonly activeSession: string | null;
  readonly workspace: string | null;
}

export interface ConsoleOptions {
  readonly workspacePath: string;
  /** Injected in tests; defaults to the U3 text-model module. */
  readonly generateText?: GenerateText;
  readonly maxToolRounds?: number;
  /** Injectable for the plan-revision date. */
  readonly now?: () => Date;
}

interface ToolContext {
  readonly workspacePath: string;
  readonly generateText: GenerateText;
  readonly now: () => Date;
  /** The parent's current chat message; plan revision must honour it. */
  readonly parentMessage: string;
}

// --- Workspace reads -------------------------------------------------------

/** Current parent-editable config plus the preset names. */
export function readConsoleConfig(workspacePath: string): ConsoleConfig {
  return {
    tutor: readWorkspaceText(workspacePath, "config/tutor.md"),
    curriculum: readWorkspaceText(workspacePath, "config/curriculum.md"),
    permissions: readWorkspaceText(workspacePath, "config/permissions.json"),
    presets: listPresets(workspacePath),
  };
}

/** Latest diary entry, latest report and newest lesson plan. */
export function readConsoleFiles(workspacePath: string): ConsoleFiles {
  return {
    diary: latestFile(workspacePath, "memory/diary", (name) => name.endsWith(".md")),
    report: latestFile(workspacePath, "reports", (name) => /-report\.md$/i.test(name)),
    lesson: newestLesson(workspacePath),
  };
}

export function listPresets(workspacePath: string): string[] {
  const presetsDir = join(workspacePath, "config/presets");
  if (!isDirectory(presetsDir)) {
    return [];
  }
  return readdirSync(presetsDir)
    .filter((name) => isFile(join(presetsDir, name)))
    .sort((a, b) => a.localeCompare(b));
}

// --- Workspace writes ------------------------------------------------------

/**
 * Parent's direct plain-text edit (PROTOCOL §10 `POST /api/console/config`).
 * Only `config/tutor.md` and `config/curriculum.md` are writable.
 */
export function writeConsoleConfig(
  workspacePath: string,
  path: string,
  content: string,
): { diff: string } {
  if (!isConfigPath(path)) {
    throw new ConsoleError(
      `config path must be one of: ${CONFIG_PATHS.join(", ")}`,
    );
  }
  const absolute = join(workspacePath, path);
  const before = readWorkspaceText(workspacePath, path) ?? "";
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  return { diff: unifiedDiff(before, content, path) };
}

/**
 * Preset switch (PROTOCOL §10 `POST /api/console/preset`): copy
 * `config/presets/<name>` over `config/tutor.md` and return the diff.
 */
export function applyPreset(
  workspacePath: string,
  name: string,
): { diff: string; applied: true } {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(name)
  ) {
    throw new ConsoleError(`invalid preset name: ${name}`);
  }
  const source = join(workspacePath, "config/presets", name);
  if (!isFile(source)) {
    throw new ConsoleError(`preset not found: ${name}`);
  }
  const content = readFileSync(source, "utf8");
  return { ...writeConsoleConfig(workspacePath, "config/tutor.md", content), applied: true };
}

/** State reported to the console UI; `activeSession` is supplied by the proxy. */
export function consoleState(
  activeSession: string | null,
  workspacePath: string | null,
): ConsoleState {
  return { activeSession, workspace: workspacePath };
}

export interface SessionStateEntry {
  readonly sessionId: string;
  readonly state: string;
}

/**
 * The session the console may close: the newest one that is starting or live.
 * Finalizing/done/error sessions are no longer closable.
 */
export function activeSessionFrom(entries: Iterable<SessionStateEntry>): string | null {
  let active: string | null = null;
  for (const entry of entries) {
    if (entry.state === "starting" || entry.state === "live") {
      active = entry.sessionId;
    }
  }
  return active;
}

// --- Chat loop -------------------------------------------------------------

/** Run one manager-agent turn: model ↔ tools, at most three tool rounds. */
export async function consoleChat(
  message: string,
  options: ConsoleOptions,
): Promise<ConsoleChatResult> {
  if (message.trim().length === 0) {
    throw new ConsoleError("message is empty");
  }
  const generate = options.generateText ?? generateText;
  const maxRounds = options.maxToolRounds ?? MAX_TOOL_ROUNDS;
  const context: ToolContext = {
    workspacePath: options.workspacePath,
    generateText: generate,
    now: options.now ?? (() => new Date()),
    parentMessage: message.trim(),
  };
  const system = managerSystemPrompt();
  const actions: ConsoleAction[] = [];

  let transcript = `Родитель: ${message.trim()}`;
  for (let round = 0; round < maxRounds; round += 1) {
    const raw = await generate(managerPrompt(transcript, round), system);
    const text = raw.trim();
    const call = parseToolCall(text);
    if (call === null) {
      return { reply: normalizeReply(text), actions };
    }
    const result = await executeToolSafely(call, context);
    actions.push({ tool: call.tool, args: call.args, result });
    transcript +=
      `\n\n[инструмент ${call.tool}]\n` +
      `аргументы: ${JSON.stringify(call.args)}\n` +
      `результат: ${serializeToolResult(result)}`;
  }

  // Three tool rounds used: one final call with tools explicitly forbidden.
  const closing = await generate(
    `${managerPrompt(transcript, maxRounds)}\n\n` +
      "Инструменты больше недоступны в этом ходе. Ответь родителю коротким текстом по-русски.",
    `${system}\n\nВ этом ответе не вызывай инструменты.`,
  );
  return { reply: normalizeReply(closing.trim()), actions };
}

async function executeToolSafely(
  call: ConsoleToolCall,
  context: ToolContext,
): Promise<unknown> {
  try {
    return await executeTool(call, context);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function executeTool(call: ConsoleToolCall, context: ToolContext): Promise<unknown> {
  switch (call.tool) {
    case "read_diary":
      return toolFile(readConsoleFiles(context.workspacePath).diary);
    case "read_report":
      return toolFile(readConsoleFiles(context.workspacePath).report);
    case "read_plan":
      return toolFile(readConsoleFiles(context.workspacePath).lesson);
    case "edit_config":
      return editConfigTool(call.args, context.workspacePath);
    case "revise_plan":
      return revisePlan(context);
  }
}

function toolFile(file: ConsoleFileEntry | null): unknown {
  return file === null ? { found: false } : { found: true, path: file.path, content: file.content };
}

function editConfigTool(
  args: Record<string, unknown>,
  workspacePath: string,
): { path: string; diff: string; changed: boolean } {
  const path = stringArg(args, "path");
  if (!isConfigPath(path)) {
    throw new ConsoleError(`config path must be one of: ${CONFIG_PATHS.join(", ")}`);
  }
  const before = readWorkspaceText(workspacePath, path) ?? "";
  let after: string;
  if (typeof args.content === "string") {
    after = args.content;
  } else if (
    typeof args.find === "string" &&
    args.find.length > 0 &&
    typeof args.replace === "string"
  ) {
    if (!before.includes(args.find)) {
      throw new ConsoleError("edit_config: фрагмент для замены не найден");
    }
    after = before.replace(args.find, args.replace);
  } else {
    throw new ConsoleError("edit_config: нужен content или find+replace");
  }
  const { diff } = writeConsoleConfig(workspacePath, path, after);
  return { path, diff, changed: before !== after };
}

/**
 * Revise the newest lesson plan from the latest session log. One text-model
 * call; writes `plans/lesson-<next-date>.md`, or a time-suffixed name when
 * that path is already taken (never overwrite a same-day plan).
 *
 * This deliberately duplicates the after-loop's revision prompt (U3 owns the
 * after-loop copy): the console must work even when the after-loop is
 * unavailable, and the two surfaces are independent by design.
 */
async function revisePlan(
  context: ToolContext,
): Promise<{ path: string; diff: string }> {
  const lessonPath = findNewestLesson(context.workspacePath);
  const plan =
    lessonPath === null
      ? "План урока пока не составлен."
      : (readWorkspaceText(context.workspacePath, lessonPath) ?? "План урока пока не составлен.");
  const session = latestSessionLog(context.workspacePath);
  const journal =
    session === null
      ? "Журнал последней сессии не найден."
      : `Журнал сессии (${session.path}):\n${tail(session.content, MAX_TOOL_RESULT_CHARS)}`;

  const prompt = [
    "Пересмотри план следующего занятия Grow с учётом журнала последней сессии.",
    `Запрос родителя из чата: ${context.parentMessage} — обязательно отрази его в плане.`,
    "Ребёнку шесть лет, тема — арифметика и состав числа 10.",
    "",
    `Текущий план${lessonPath === null ? "" : ` (${lessonPath})`}:`,
    plan,
    "",
    journal,
    "",
    "Верни ТОЛЬКО markdown нового плана занятия, без пояснений и без markdown-ограды.",
    "План короткий: цель, 5–7 шагов, чем закончить.",
  ].join("\n");

  // Pin the target date before the model call, as the after-loop does: the
  // date comes from the workspace, not the model output. The collision check
  // stays at write time, so a plan written during the call still wins.
  const nextLessonDate = nextLessonDateFor(
    context.workspacePath,
    sessionDateFromLog(session?.path ?? null, context.now()),
    context.now,
  );

  const revised = (await context.generateText(prompt, REVISION_SYSTEM)).trim();
  if (revised.length === 0) {
    throw new ConsoleError("модель вернула пустой план");
  }

  // Never overwrite an existing plan for the same date: the after-loop may
  // have written it already. Collide onto `lesson-<date>-<hhmm>.md` (rule 17).
  const path = firstFreePath(
    `plans/lesson-${nextLessonDate}.md`,
    `plans/lesson-${nextLessonDate}-${formatTimeSuffix(context.now())}.md`,
    (relativePath) => existsSync(join(context.workspacePath, relativePath)),
  );
  // The diff compares the revised plan against the plan it revises, not against
  // the (usually brand-new, therefore empty) target file. Diffing the target
  // path made every revision look like it replaced an empty file.
  const before =
    lessonPath === null ? "" : (readWorkspaceText(context.workspacePath, lessonPath) ?? "");
  const content = `${stripFences(revised)}\n`;
  const absolute = join(context.workspacePath, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  return { path, diff: unifiedDiff(before, content, path) };
}

/** Session date from `sessions/<yyyy-mm-dd>-<hhmm>/session.jsonl`; today if none. */
function sessionDateFromLog(relativePath: string | null, now: Date): string {
  const match = relativePath === null ? null : /(\d{4}-\d{2}-\d{2})/.exec(relativePath);
  if (match !== null) {
    return match[1];
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// --- Model text protocol ---------------------------------------------------

const REVISION_SYSTEM =
  "Ты — методист Grow. Пересматриваешь план занятия для ребёнка шести лет. " +
  "Пиши по-русски, конкретно и коротко; только markdown плана, без вступления.";

function managerSystemPrompt(): string {
  return [
    "Ты — менеджер Grow, помощник родителя. Родитель ведёт занятие ребёнка шести лет.",
    "Ты работаешь с папкой занятия только через инструменты. Не выдумывай содержимое файлов.",
    "",
    "Чтобы вызвать инструмент, ответь РОВНО одним JSON-объектом без пояснений:",
    '{"tool":"имя","args":{}}',
    "",
    "Инструменты:",
    "1. read_diary — последняя запись дневника (memory/diary/*.md). args: {}",
    "2. read_report — последний отчёт после занятия (reports/*-report.md). args: {}",
    "3. read_plan — новый план урока (plans/lesson-*.md). args: {}",
    '4. edit_config — правка config/tutor.md или config/curriculum.md. ' +
      'args: {"path":"config/tutor.md","find":"точный фрагмент","replace":"новый текст"} ' +
      'или {"path":"...","content":"весь новый текст"}',
    "5. revise_plan — пересмотреть последний план с учётом журнала последней сессии " +
      "и записать plans/lesson-<следующая дата>.md. args: {}",
    "",
    "Правила:",
    "- За один ответ — не больше одного инструмента.",
    "- Сначала прочитай то, что нужно, потом меняй.",
    "- Меняй конфиг маленькими точными правками (find+replace), а не переписывай всё без нужды.",
    "- Когда работа закончена, ответь родителю обычным текстом по-русски: коротко, что сделано.",
    "- Не выводи JSON, если это не вызов инструмента.",
  ].join("\n");
}

function managerPrompt(transcript: string, round: number): string {
  return [
    `Ход ${round + 1}. Состояние разговора:`,
    transcript,
    "",
    "Что дальше? Ответь вызовом инструмента (один JSON-объект) или обычным текстом родителю.",
  ].join("\n");
}

function parseToolCall(text: string): ConsoleToolCall | null {
  const trimmed = stripFences(text.trim());
  const candidates: string[] = [trimmed];
  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      candidates.push(candidate);
    }
  }
  const block = /\{[\s\S]*\}/.exec(trimmed);
  if (block !== null) {
    candidates.push(block[0]);
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.tool !== "string") {
      continue;
    }
    if (!isConsoleToolName(parsed.tool)) {
      continue;
    }
    const args = isRecord(parsed.args) ? parsed.args : {};
    return { tool: parsed.tool, args };
  }
  return null;
}

function normalizeReply(text: string): string {
  const trimmed = stripFences(text.trim());
  if (trimmed.length === 0) {
    return "Готово.";
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && typeof parsed.reply === "string" && parsed.reply.trim().length > 0) {
      return parsed.reply.trim();
    }
  } catch {
    // Not JSON: the model's plain text is the reply.
  }
  if (parseToolCall(trimmed) !== null) {
    return "Готово.";
  }
  return trimmed;
}

function stripFences(text: string): string {
  return text
    .replace(/^```(?:json|tool)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

function serializeToolResult(result: unknown): string {
  const text = JSON.stringify(result);
  if (text.length <= MAX_TOOL_RESULT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (результат обрезан)`;
}

/** Keep the end of a long log: the session's later turns matter most. */
function tail(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `… (начало журнала опущено)\n${text.slice(-limit)}`;
}

// --- Diff -----------------------------------------------------------------

interface DiffOp {
  readonly kind: "eq" | "del" | "add";
  readonly text: string;
}

/**
 * Minimal unified diff (no dependency): LCS over lines, 3 lines of context,
 * `---`/`+++` headers and `@@` hunks. Config files are small, so the LCS
 * table is cheap.
 */
export function unifiedDiff(before: string, after: string, path: string): string {
  if (before === after) {
    return "";
  }
  const ops = diffOps(splitLines(before), splitLines(after));
  const hunks = formatHunks(ops);
  if (hunks.length === 0) {
    return "";
  }
  return [`--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n") + "\n";
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function diffOps(before: string[], after: string[]): DiffOp[] {
  const rows = before.length;
  const cols = after.length;
  const table: Uint32Array[] = Array.from(
    { length: rows + 1 },
    () => new Uint32Array(cols + 1),
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] =
        before[i] === after[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      ops.push({ kind: "eq", text: before[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: "del", text: before[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", text: after[j] });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ kind: "del", text: before[i] });
    i += 1;
  }
  while (j < cols) {
    ops.push({ kind: "add", text: after[j] });
    j += 1;
  }
  return ops;
}

function formatHunks(ops: readonly DiffOp[], context = 3): string[] {
  const changed = ops
    .map((op, index) => (op.kind === "eq" ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) {
    return [];
  }

  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  const oldBefore = new Array<number>(ops.length + 1).fill(0);
  const newBefore = new Array<number>(ops.length + 1).fill(0);
  let oldLine = 0;
  let newLine = 0;
  for (let index = 0; index < ops.length; index += 1) {
    oldBefore[index] = oldLine;
    newBefore[index] = newLine;
    if (ops[index].kind !== "add") {
      oldLine += 1;
    }
    if (ops[index].kind !== "del") {
      newLine += 1;
    }
  }
  oldBefore[ops.length] = oldLine;
  newBefore[ops.length] = newLine;

  const lines: string[] = [];
  for (const [start, end] of ranges) {
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((op) => op.kind !== "add").length;
    const newCount = slice.filter((op) => op.kind !== "del").length;
    const oldStart = oldCount === 0 ? oldBefore[start] : oldBefore[start] + 1;
    const newStart = newCount === 0 ? newBefore[start] : newBefore[start] + 1;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) {
      const prefix = op.kind === "eq" ? " " : op.kind === "del" ? "-" : "+";
      lines.push(`${prefix}${op.text}`);
    }
  }
  return lines;
}

// --- Small helpers ---------------------------------------------------------

function latestFile(
  workspacePath: string,
  relativeDir: string,
  include: (name: string) => boolean,
): ConsoleFileEntry | null {
  const directory = join(workspacePath, relativeDir);
  if (!isDirectory(directory)) {
    return null;
  }
  const matches = readdirSync(directory)
    .filter((name) => include(name) && isFile(join(directory, name)))
    .sort((a, b) => b.localeCompare(a));
  if (matches.length === 0) {
    return null;
  }
  const relativePath = `${relativeDir}/${matches[0]}`;
  return {
    path: relativePath,
    content: readFileSync(join(workspacePath, relativePath), "utf8"),
  };
}

function newestLesson(workspacePath: string): ConsoleFileEntry | null {
  const relativePath = findNewestLesson(workspacePath);
  if (relativePath === null) {
    return null;
  }
  const content = readWorkspaceText(workspacePath, relativePath);
  return content === null ? null : { path: relativePath, content };
}

function latestSessionLog(workspacePath: string): ConsoleFileEntry | null {
  const sessionsDir = join(workspacePath, "sessions");
  if (!isDirectory(sessionsDir)) {
    return null;
  }
  const matches = readdirSync(sessionsDir)
    .filter(
      (name) =>
        isDirectory(join(sessionsDir, name)) &&
        isFile(join(sessionsDir, name, "session.jsonl")),
    )
    .sort((a, b) => b.localeCompare(a));
  if (matches.length === 0) {
    return null;
  }
  const relativePath = `sessions/${matches[0]}/session.jsonl`;
  return {
    path: relativePath,
    content: readFileSync(join(workspacePath, relativePath), "utf8"),
  };
}

function readWorkspaceText(workspacePath: string, relativePath: string): string | null {
  const absolute = join(workspacePath, relativePath);
  return isFile(absolute) ? readFileSync(absolute, "utf8") : null;
}

function isConfigPath(path: string): path is ConfigPath {
  return (CONFIG_PATHS as readonly string[]).includes(path);
}

function isConsoleToolName(value: string): value is ConsoleToolName {
  return (CONSOLE_TOOLS as readonly string[]).includes(value);
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ConsoleError(`${key} is required`);
  }
  return value;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
