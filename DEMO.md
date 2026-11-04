# Demo runbook — English session

The demo path is the same product, switched to English by one environment
variable. `GROW_LOCALE` unset (or set to anything other than exactly `en`)
runs the Russian build unchanged.

## Launch

```bash
export GEMINI_API_KEY=...          # from Google AI Studio
export GROW_LOCALE=en
bun run src/proxy/index.ts
```

- Child session: <http://localhost:8787/>
- Parent console: <http://localhost:8787/console>

`PORT` changes the port (default `8787`). The running proxy tells both pages
which locale it uses (`GET /api/locale`), so restart the proxy after changing
`GROW_LOCALE`.

## Reset the demo workspace

The template lives in `templates/demo-en/`. Copy it to a fresh folder and
open that folder in the app — the recent-workspaces dropdown on both pages
makes this one click:

```bash
cp -R templates/demo-en "$HOME/grow-demo-en"
```

Then open <http://localhost:8787/>, put that folder in **Session folder**, and
press **Start session**. To reset mid-rehearsal, close the session, copy the
template to a *new* folder (e.g. `grow-demo-en-2`), and open that instead; the
after-loop writes diary, report and next plan into the folder it just used, so
never reuse a folder you have already filmed.

The template contains:

```
config/tutor.md              policy paragraph under "## Method"
config/rules.md              house rules — shown in the console Rules tab (read-only)
config/curriculum.md         make-ten arithmetic, age 6
memory/child.md              Ivan, age 6
plans/lesson-2026-11-02.md   the first filmed lesson (8 + 5)
memory/diary/                empty; the after-loop fills it
reports/                     empty; the after-loop fills it
```

## Force a fresh session (config-change beats)

Config edits only reach the tutor at **session start** — the package is built
once and never rebuilt mid-session. Every config beat is therefore:

1. In the child view, press **End session** (or **End session** in the console).
2. Wait until the closed screen says `after session: done (diary, report, plan)`
   (the console's side panel shows the same files).
3. Edit and save the config in the console (`/console`, **Configuration →
   tutor → Save**) — or with an editor, directly in the folder.
4. Press **New session** (child view) and start the session again.

### Beat: the config reaches the tutor

Add this line to `config/tutor.md` (for example under `## Voice`) and save:

```
Praise correct answers with the word "excellent".
```

Start a new session, let Ivan answer a question correctly, and the tutor
should use that word - proof that the parent's edit reached the tutor.

### Beat: Socratic method

In `config/tutor.md`, replace the one paragraph under `## Method` with exactly:

```
Method: ask, don't tell. When Ivan answers, ask "How did you get that?" before saying whether it is right. If he is unsure, ask what would help him check: the ten-frame, counting on his fingers, or a smaller step. Never give the answer; let him find it and name it himself.
```

Start a new session: the tutor asks how Ivan got his answer instead of telling
him the step.

## Pre-flight

```bash
bun test                                   # all green
bun build --target=bun src/proxy/index.ts  # compile smoke
bun build --target=browser src/ui/app.js   # compile smoke
grep -r '[А-Яа-я]' "$HOME/grow-demo-en"    # must print nothing
```
