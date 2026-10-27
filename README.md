# Grow

A parent-administered AI tutor for young children: a voice-first session on an
adaptive canvas, a planner that thinks between sessions, and a workspace the
parent owns as plain files.

- **One executable and a folder.** A single local proxy serves the web UI and
  the API — the browser tab is a client that holds no keys and touches no
  files; the workspace lives in a folder beside the executable.
- **Files are the database.** Everything the parent can own is a plain,
  hand-editable file: tutor config, curriculum, memory, diary, plans, session
  logs, reports.
- **A pedagogy is a config file.** The tutor's instructions live in
  `config/tutor.md` in plain language; editing that line changes the next
  session.

Specs and project knowledge live in the sibling vault
(`~/Cuba/grow/grow-vault`); this repo implements only what its
`coding-instructions` notes specify. Agent pipeline docs: `docs/agent/`
(CONVENTIONS is the standing rulebook).

Status: seeded, no code yet — see `docs/agent/STATUS.md`.

License: Apache-2.0 (repo private until 2026-10-31, then published).