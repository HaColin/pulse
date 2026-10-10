---
name: {{NAME}}
description: See what teammates on this repo are doing right now, and share your own work-in-progress with them, using pulse (per-minute git snapshots that Claude summarises). Use when the user types /{{NAME}}, asks who is working on what, whether anyone else is touching a file or area before editing or merging it, what a teammate has changed, or wants to start or stop sharing their work or open the team dashboard.
argument-hint: "[start | stop | dashboard | a question about the team]"
allowed-tools: Bash({{PULSE}} *), PowerShell({{PULSE}} *)
---

# Team check-in with pulse

pulse lets everyone working on the same git repo see what the others are doing. Each person runs it in their own clone: once a minute it snapshots their uncommitted work, pushes it to the shared remote under `refs/pulse/<name>` (hidden refs, not branches), and Claude writes one line about what changed. This skill is the front end for it.

The pulse command on this machine is:

    {{PULSE}}

Run it from inside the project the user is working on (the shared repo), or add `-C <path>` to point at it. If the current folder is not a git repo and it is not obvious which project they mean, ask.

What the user typed after `/{{NAME}}`: $ARGUMENTS

Pick the matching section below. With nothing typed, or a question, do the check-in.

## Check-in (the default)

1. Run `{{PULSE}} status`. It fetches from the remote first, so what it prints is current.
2. Tell the user what is going on, briefly: one line per teammate saying who, what they are doing, how long ago and on which branch. People who are offline or have been idle for hours only need a passing mention.
3. Lead with overlap warnings that involve the user. Two people with unmerged changes in the same file is the thing pulse exists to catch, and it matters most when this session has been editing that file. Say so plainly and suggest they talk before either of them pushes. "Unmerged" covers both uncommitted edits and local commits that are not on the remote's main branch yet, so a file can be listed even when `git status` shows it clean.
4. If the first line says pulse is not running in this clone, mention that teammates cannot see the user's work right now and that `/{{NAME}} start` fixes it. Do not start it unasked, because starting publishes their uncommitted work.

When the user asked a question ("is anyone in the auth code?", "what has Alice changed?"), answer that first.

- `{{PULSE}} status --json` gives the full data: each person's `slug`, the files in their latest snapshot (`files`), every file where they have unmerged work (`inflight`), and their recent `history`.
- After a status call, each teammate's actual work-in-progress is in this clone at `refs/pulse-remote/<slug>`. Read it with ordinary git, for example `git diff origin/main refs/pulse-remote/<slug> -- path/to/file` or `git show refs/pulse-remote/<slug>:path/to/file`. Reach for this when the one-line summary is not enough, such as checking whether their change will collide with what the user is about to do.

## start

1. Run `{{PULSE}} status` first. If it says pulse is already sharing this clone, say so and stop there.
2. Tell the user in a sentence what starting does: their uncommitted work in this repo gets pushed to the remote every minute, where anyone with access to the repo can fetch it. Files that look like secrets, dependency folders and large new files are skipped.
3. Start `{{PULSE}} start` as a long-running process. It never exits on its own, so do not run it in the foreground and wait for it. Prefer a terminal tab the user can see if this session has a tool for that; otherwise run it as a background shell command. Started either way, it ends when its tab or this Claude session closes, so let the user know that running `pulse start` in a terminal of their own keeps it going independently.
4. Run `{{PULSE}} install-hook`. From then on, Claude Code sessions in this repo get a short note about teammates' activity with every prompt, which is how you find out mid-task that someone else is in the file you are editing. It only affects this clone on this machine, and `uninstall-hook` removes it.
5. After a few seconds run `{{PULSE}} status` again and report that sharing is on, the dashboard address, and who else is around. If nobody else shows up, the teammates probably have not set pulse up yet; give the user the setup lines at the end of this file to pass on.

Options to pass through when the user asks for them: `--name "<name>"` (how they appear to others), `--interval <seconds>`, `--model haiku` (lighter on Claude usage for the per-minute summaries), `--no-ai` (file names only, no Claude calls).

## stop

Run `{{PULSE}} stop`. It lets the current snapshot finish, marks the user offline for teammates and ends the background process, which can take up to a minute. If you opened a terminal tab for pulse, close it afterwards. The hook can stay installed: it goes quiet on its own once its data is stale.

## dashboard

The status output shows the dashboard address while pulse is running (normally http://localhost:4747; it moves to the next free port if that one is taken). Open it in the browser if this session can, otherwise give the user the link. If pulse is not running, `{{PULSE}} watch` serves the same dashboard without publishing anything; start it as a long-running process the same way.

## When something is off

- "is not inside a git repository": the command ran outside the shared project. Point it there with `-C`.
- A warning about no remote: snapshots stay on this machine, so nobody else sees them. The project needs a shared remote first.
- "could not push": the user's git is not signed in for background pushes. Have them run `git push` once by hand in that repo.
- To remove everything the user has published: `{{PULSE}} clear`.

Teammate setup, for the user to pass on (each person, once):

    npm install -g github:HaColin/pulse
    pulse install-skill

Then `/{{NAME}} start` inside their clone of the project. They need push access to the project's remote and the `claude` CLI signed in.
