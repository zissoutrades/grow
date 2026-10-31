/**
 * Recent-workspace store (PROTOCOL §2): `/api/workspaces/recent` and the
 * workspace-recents pickers on both pages.
 *
 * Persistence is a human-readable JSON file, `recents.json`, next to the
 * compiled executable (the task's double-click layout: exe and workspace folder
 * share a directory). In dev (`bun run`) the process cwd is used instead; the
 * `GROW_RECENTS_FILE` env override exists for tests and unusual layouts.
 *
 * All read/write failures are logged and swallowed: a broken recents file must
 * never fail a session start or the route. Functions take the file path
 * explicitly so tests can run them over a temp folder (CONVENTIONS rule 8).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface RecentWorkspace {
  /** Absolute workspace folder path, as recorded by a successful start. */
  readonly path: string;
  /** ISO-8601 timestamp of the last successful start. */
  readonly lastUsed: string;
}

export const MAX_RECENTS = 5;

export interface RecentsFileLocation {
  readonly env?: Record<string, string | undefined>;
  readonly execPath?: string;
  readonly cwd?: string;
  /** Override for tests; defaults to Bun's standalone-executable flag. */
  readonly standalone?: boolean;
}

/** Where `recents.json` lives for the current process (or the given options). */
export function recentsFilePath(options: RecentsFileLocation = {}): string {
  const env = options.env ?? process.env;
  const override = env.GROW_RECENTS_FILE;
  if (override !== undefined && override.trim().length > 0) {
    return resolve(override.trim());
  }
  const standalone = options.standalone ?? Bun.isStandaloneExecutable;
  if (standalone) {
    return join(dirname(options.execPath ?? process.execPath), "recents.json");
  }
  return resolve(options.cwd ?? process.cwd(), "recents.json");
}

/** Read and normalise the store; a missing or corrupt file is an empty list. */
export function readRecents(filePath: string): RecentWorkspace[] {
  try {
    if (!existsSync(filePath)) {
      return [];
    }
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return normalizeRecents(parsed);
  } catch (error) {
    console.warn(`could not read recents file ${filePath}: ${errorMessage(error)}`);
    return [];
  }
}

/**
 * Record a successful start: dedupe by path (move to front), refresh
 * `lastUsed`, cap at `MAX_RECENTS`. Returns the new list.
 */
export function recordRecent(
  filePath: string,
  workspacePath: string,
  now: Date = new Date(),
): RecentWorkspace[] {
  const entry: RecentWorkspace = { path: workspacePath, lastUsed: now.toISOString() };
  const recents = [
    entry,
    ...readRecents(filePath).filter((recent) => recent.path !== workspacePath),
  ].slice(0, MAX_RECENTS);
  writeRecents(filePath, recents);
  return recents;
}

function writeRecents(filePath: string, recents: RecentWorkspace[]): void {
  try {
    writeFileSync(filePath, `${JSON.stringify({ recents }, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn(`could not write recents file ${filePath}: ${errorMessage(error)}`);
  }
}

function normalizeRecents(parsed: unknown): RecentWorkspace[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.recents)) {
    return [];
  }
  const seen = new Set<string>();
  const recents: RecentWorkspace[] = [];
  for (const value of parsed.recents) {
    if (!isRecord(value)) {
      continue;
    }
    if (typeof value.path !== "string" || value.path.length === 0) {
      continue;
    }
    if (typeof value.lastUsed !== "string" || Number.isNaN(Date.parse(value.lastUsed))) {
      continue;
    }
    if (seen.has(value.path)) {
      continue;
    }
    seen.add(value.path);
    recents.push({ path: value.path, lastUsed: value.lastUsed });
  }
  // The contract is most-recent-first even for a hand-edited file.
  recents.sort((left, right) => right.lastUsed.localeCompare(left.lastUsed));
  return recents.slice(0, MAX_RECENTS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
