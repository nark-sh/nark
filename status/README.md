# status/

Daily-recorded Socket.dev supply-chain score history for `nark`.

- **`history.json`** — append-only record of Socket scores, written by the `socket-score-history` workflow once per day. The public status page at https://nark.sh/status reads this file (via raw.githubusercontent.com) and renders the timeline.
- **Workflow:** `.github/workflows/socket-score-history.yml`
- **Recorder:** `record-score.mjs` (repo root)
- **Required secret:** `SOCKET_SECURITY_API_KEY` — create at https://socket.dev/dashboard, add as a repo secret.

The committed history file is itself the proof that the numbers aren't hand-edited — every entry traces back to a public workflow run.
