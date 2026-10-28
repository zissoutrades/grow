# Grow

A parent-administered AI tutor for young children: a voice-first session on an adaptive canvas, a planner that thinks between sessions, and a workspace the parent owns as plain files.

**Grow is one executable and a folder.** The child session is a realtime voice conversation (Gemini Live) with a canvas the tutor drives through tool calls. Every session ends with a diary entry, a report, and a revised lesson plan written into the workspace. The parent can rewrite the tutor's instructions in plain text and watch the next session change.

## Run

```bash
export GEMINI_API_KEY=...   # from Google AI Studio
bun run src/proxy/index.ts  # http://localhost:8787 — child session at /, parent console at /console
```

Requires [Bun](https://bun.sh). No dependencies, no database, no server beyond the local process — the workspace folder is the storage.

## Layout

- `src/proxy/` — the single Bun process: Gemini Live relay, session package builder, tool calls, JSONL session log, WAV recording, timers, billing accounting, after-loop, parent console
- `src/ui/` — the browser client (child session at `/`, parent console at `/console`); static ES modules, no build step
- `scripts/` — probes, mock proxy, `compile.sh` (single self-contained executable)
- `test/` — bun tests (104 passing)
- `docs/agent/` — coding conventions, protocol contract, status

## Workspace format

```
grow/
  config/    tutor.md, curriculum.md, permissions.json, presets/
  memory/    child.md, diary/
  plans/     season-*.md, week-*.md, lesson-*.md
  sessions/  <date>-<time>/ (session.jsonl, mic.wav, tutor.wav)
  reports/   <date>-report.md
```

Everything human-readable; nothing binary except stored audio; every file hand-editable; no hidden state outside the folder.

License: Apache-2.0.
