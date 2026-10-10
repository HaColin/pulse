# pulse

See what everyone on your repo is doing, live.

Each teammate runs `pulse start` in their clone. Every minute pulse snapshots their work-in-progress, pushes it to GitHub, and has Claude write one line about what they are working on. Everyone sees the same feed in their terminal and on a local dashboard, with a warning when two people have unmerged changes in the same file.

```
14:18  you          Adding per-user login rate limiting to authentication  · 1 file +8 -0
14:18  Alice Chen   Adding cart tax calculation and a checkout flow  · main · 4 files +22 -1
       ! you and Alice Chen both have unmerged changes in src/auth.js
```

## Setup (each teammate)

Needs Node 18+, git 2.29+, push access to the shared repo, and the `claude` CLI signed in (Claude Code). No API key.

```bash
npm install -g github:HaColin/pulse
```

Then, inside your clone of the project you are all working on:

```bash
pulse start
```

The dashboard is at http://localhost:4747. Press Ctrl+C to sign off.

## Commands

| Command | What it does |
|---|---|
| `pulse start` | Snapshot + push every minute, show the feed and dashboard |
| `pulse watch` | Feed and dashboard only; publishes nothing |
| `pulse status` | Print what everyone is doing, then exit |
| `pulse install-hook` | Tell your Claude Code sessions in this repo what teammates are doing |
| `pulse uninstall-hook` | Remove that hook |
| `pulse clear` | Delete your snapshots locally and on the remote |

Options: `--interval <seconds>`, `--name <name>`, `--model <model>`, `--no-ai`, `--port <n>`, `--no-web`, `--remote <name>`, `--once`, `-C <dir>`.

## How it works

- **Snapshots do not touch your work.** pulse builds a commit of your working directory through a private index and stores it at `refs/pulse/<you>`. Your branch, staging area and history stay exactly as they are.
- **They are not branches.** `refs/pulse/*` is pushed to the remote but lives outside `refs/heads/`, so it does not show up as a branch, open PR banners, or trigger CI.
- **Claude narrates.** When your files change, the diff since the last snapshot goes to `claude -p` (tools disabled, run outside the project) and the one-line reply becomes the snapshot's commit message. Teammates read it with a plain `git fetch`; nobody runs Claude on anyone else's code.
- **The Claude Code hook** (`pulse install-hook`) adds a short "what teammates are doing" note to each prompt in this repo, so your Claude knows who else is in a file before it edits it. It is written to `.claude/settings.local.json`, which is per-machine and kept out of git.

## What gets shared

Everything git would track, plus new files that are not ignored, **except** new files that look like secrets (`.env`, `*.pem`, `*.key`, `credentials.json`, ...), dependency folders (`node_modules`, `.venv`, ...), and new files over 1 MB. pulse says so the first time it skips one. Anyone with read access to the repo can fetch the snapshots, so treat them like a pushed branch.

## Notes

- The narrator uses your Claude Code default model and only runs when something changed. A call takes about 10 seconds; `--model haiku` is lighter on your usage if you run pulse all day.
- Very large diffs are capped before they reach the narrator (it still sees the full file list and is told what was cut).
- Snapshot pushes skip the project's `pre-push` hook, so a test suite does not run every minute.
- The "active / idle" labels compare timestamps from each person's machine, so a badly wrong clock skews them.
