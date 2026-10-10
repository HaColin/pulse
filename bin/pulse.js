#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitTry, openRepo, whoami } from '../src/git.js';
import { clearLive, markLive, readLive, requestStop, stopRequested } from '../src/live.js';
import { serveDashboard } from '../src/server.js';
import { captureChanges, clearSnapshots, commitSnapshot, pushSnapshot, signOff } from '../src/snapshot.js';
import { describe, findClaude, plainHeadline } from '../src/summarize.js';
import { ago, fetchTeam, nameList, readTeam } from '../src/team.js';

const HELP = `pulse: see what everyone on your repo is doing, live.

Usage: pulse <command> [options]      (run inside your clone of the shared repo)

Commands
  start            Snapshot your work every minute, push it, and show the team feed + dashboard
  watch            Only follow the team (feed + dashboard); publishes nothing
  stop             Sign off the "pulse start" running in this clone
  status           Print what everyone is doing right now, then exit (--json for raw data)
  install-skill    Add the /team command to Claude Code (--as <name> to call it something else)
  uninstall-skill  Remove it
  install-hook     Tell your Claude Code sessions in this repo what teammates are doing
  uninstall-hook   Remove that hook
  clear            Delete your snapshots from this clone and from the remote

Options
  --interval <s>   Seconds between snapshots (default 60, minimum 10)
  --name <name>    Name teammates see for you (default: your git user.name)
  --model <model>  Model the narrator uses, e.g. haiku (default: your Claude Code default)
  --no-ai          Skip Claude and describe changes by file name only
  --port <n>       Dashboard port (default 4747)
  --no-web         Do not start the dashboard
  --remote <name>  Git remote to sync through (default origin)
  --once           Take one snapshot, print the team once, and exit
  -C <dir>         Run as if started in <dir>
`;

const REFRESH_MS = 20_000;
const VALUE_FLAGS = new Set(['interval', 'name', 'model', 'port', 'remote', 'as']);

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint('2');
const bold = paint('1');
const green = paint('32');
const yellow = paint('33');

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-C') flags.dir = argv[++i];
    else if (arg === '-h' || arg === '--help') flags.help = true;
    else if (arg.startsWith('--no-')) flags[arg.slice(5)] = false;
    else if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      flags[key] = inline ?? (VALUE_FLAGS.has(key) ? argv[++i] : true);
    } else flags._.push(arg);
  }
  return flags;
}

const firstLine = (text) => text.split('\n').find((line) => line.trim())?.trim() ?? 'unknown error';
const changeNote = (stats) => (stats?.files ? `${stats.files} file${stats.files === 1 ? '' : 's'} +${stats.add} -${stats.del}` : null);
const overlapLine = (team, overlap, meSlug) =>
  `${nameList(team, overlap.people, meSlug)} ${overlap.people.length > 2 ? 'all' : 'both'} have unmerged changes in ${overlap.file}`;

function feed(who, text, notes = []) {
  const stamp = new Date().toTimeString().slice(0, 5);
  const extra = notes.filter(Boolean);
  console.log(`${dim(stamp)}  ${bold(who.padEnd(16))} ${text}${extra.length ? dim(`  · ${extra.join(' · ')}`) : ''}`);
}
const aside = (text) => console.log(`${' '.repeat(7)}${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dashboardUrl = (running) => (running?.port ? `http://localhost:${running.port}` : null);

async function open(flags) {
  const repo = await openRepo(flags.dir ?? process.cwd());
  const me = await whoami(repo, typeof flags.name === 'string' ? flags.name : undefined);
  const remote = typeof flags.remote === 'string' ? flags.remote : 'origin';
  const online = (await gitTry(repo, ['remote', 'get-url', remote])).ok;
  return { repo, me, remote, online };
}

async function live(flags, { publish }) {
  const { repo, me, remote, online } = await open(flags);
  const already = publish && readLive(repo);
  if (already) {
    const where = dashboardUrl(already);
    return console.log(`pulse is already sharing this clone${where ? ` (dashboard ${where})` : ''}. Stop it with "pulse stop".`);
  }
  const intervalSeconds = Math.max(10, Number(flags.interval) || 60);
  const claude = publish && flags.ai !== false ? await findClaude() : null;
  const session = { started: false, head: null, seen: new Map(), warned: new Set() };

  const warn = (key, message) => {
    if (session.warned.has(key)) return;
    session.warned.add(key);
    aside(yellow(`! ${message}`));
  };

  async function snapshot() {
    const cap = await captureChanges(repo, me, session, remote);
    for (const { file, why } of cap.skipped) warn(`skip:${file}`, `not sharing ${file} (${why})`);
    if (cap.changed) {
      let headline = null;
      if (claude && cap.files.length) {
        const told = await describe(cap, me, claude, flags.model);
        headline = told.headline;
        if (headline) session.warned.delete('narrator');
        else warn('narrator', `Claude could not describe this change (${told.error}); using file names until it works again`);
      }
      await commitSnapshot(repo, me, cap, { headline: headline ?? plainHeadline(cap), ai: Boolean(headline) });
      session.head = cap.head;
      feed('you', headline ?? plainHeadline(cap), [changeNote(cap.stats)]);
      if (online) {
        const pushed = await pushSnapshot(repo, me, remote);
        if (pushed.ok) session.warned.delete('push');
        else warn('push', `could not push to ${remote}: ${firstLine(pushed.err)}. Run "git push" once by hand to check you are signed in.`);
      }
    }
    session.started = true;
  }

  async function refresh() {
    if (online) {
      const fetched = await fetchTeam(repo, remote);
      if (fetched.ok) session.warned.delete('fetch');
      else warn('fetch', `could not fetch from ${remote}: ${firstLine(fetched.err)}`);
    }
    const team = await readTeam(repo, me);
    for (const person of team.people) {
      if ((publish && person.me) || session.seen.get(person.slug) === person.sha) continue;
      const known = session.seen.has(person.slug);
      session.seen.set(person.slug, person.sha);
      if (person.status === 'offline') {
        feed(person.name, dim(known ? 'signed off' : `offline, was: ${person.headline}`), [!known && ago(person.ts, team.now)]);
      } else {
        feed(person.name, person.headline, [person.branch, changeNote(person.stats), person.status === 'idle' && ago(person.ts, team.now)]);
      }
    }
    const overlaps = team.overlaps.filter((overlap) => !publish || overlap.people.includes(me.slug));
    for (const overlap of overlaps) warn(`overlap:${overlap.file}:${overlap.people}`, overlapLine(team, overlap, me.slug));
  }

  const guarded = async (label, work) => {
    try {
      await work();
    } catch (err) {
      warn(`${label}:${err.message}`, `${label} failed: ${err.message}`);
    }
  };

  let web = null;
  if (flags.web !== false && !flags.once) {
    let cache = { at: 0, state: null };
    web = await serveDashboard({
      port: Number(flags.port) || 4747,
      getState: async () => {
        if (Date.now() - cache.at > 1500) {
          cache = { at: Date.now(), state: { repo: repo.name, me: me.slug, intervalSeconds, ...(await readTeam(repo, me)) } };
        }
        return cache.state;
      },
    }).catch((err) => {
      warn('web', `dashboard not started: ${err.message}`);
      return null;
    });
  }

  if (!flags.once) {
    const mode = publish ? `snapshot every ${intervalSeconds}s${online ? ` to ${remote}` : ''}` : 'watching only';
    console.log(`${bold('pulse')}  ${repo.name}  ${dim(`· you are ${me.name} · ${mode}`)}`);
    if (web) aside(dim(`dashboard  http://localhost:${web.port}`));
    if (publish) aside(dim(`narrator   ${claude ? `Claude via the claude CLI${flags.model ? ` (${flags.model})` : ''}` : flags.ai === false ? 'off (--no-ai)' : 'claude CLI not found, using file names'}`));
    if (!online) aside(yellow(`! no "${remote}" remote here, so nothing is shared with teammates yet`));
    aside(dim('Ctrl+C to sign off'));
    console.log();
  }

  const daemon = publish && !flags.once;
  const beat = () => daemon && markLive(repo, { port: web?.port ?? null });
  if (daemon) clearLive(repo);

  let stopping = false;
  const nap = async (ms) => {
    const until = Date.now() + ms;
    while (!stopping && Date.now() < until) {
      if (daemon && stopRequested(repo)) stopping = true;
      else await sleep(Math.min(1000, until - Date.now()));
    }
  };
  const interrupt = () => {
    // A second Ctrl+C skips the sign-off and leaves at once.
    if (stopping) {
      if (daemon) clearLive(repo);
      process.exit(130);
    }
    stopping = true;
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);

  let nextSnapshot = 0;
  while (!stopping) {
    beat();
    if (publish && Date.now() >= nextSnapshot) {
      nextSnapshot = Date.now() + intervalSeconds * 1000;
      await guarded('snapshot', snapshot);
    }
    await guarded('refresh', refresh);
    if (flags.once || stopping) break;
    await nap(publish ? Math.min(REFRESH_MS, Math.max(1000, nextSnapshot - Date.now())) : REFRESH_MS);
  }

  if (stopping && publish) {
    await guarded('sign-off', async () => {
      if ((await signOff(repo, me)) && online) await pushSnapshot(repo, me, remote);
    });
    console.log(dim('\nsigned off'));
  }
  if (daemon) clearLive(repo);
  web?.server.close();
  web?.server.closeAllConnections?.();
}

async function status(flags) {
  const { repo, me, remote, online } = await open(flags);
  if (online) {
    const fetched = await fetchTeam(repo, remote);
    if (!fetched.ok) console.log(yellow(`! could not fetch from ${remote}, showing what this clone last saw: ${firstLine(fetched.err)}`));
  }
  const team = await readTeam(repo, me);
  const running = readLive(repo);
  if (flags.json) {
    return console.log(JSON.stringify({ repo: repo.name, me: me.slug, sharing: Boolean(running), dashboard: dashboardUrl(running), ...team }, null, 2));
  }
  console.log(running
    ? dim(`pulse is sharing this clone${running.port ? ` · dashboard ${dashboardUrl(running)}` : ''}`)
    : yellow('! pulse is not running in this clone, so teammates cannot see your work. Start it with: pulse start'));
  if (!team.people.length) return console.log('No one has shared a snapshot yet.');
  const dot = { active: green('●'), idle: yellow('●'), offline: dim('○') };
  for (const person of team.people) {
    const facts = [person.status, ago(person.ts, team.now), person.branch].filter(Boolean).join(' · ');
    console.log(`${dot[person.status]} ${bold(person.me ? `${person.name} (you)` : person.name)}  ${dim(facts)}`);
    console.log(`  ${person.headline}`);
    if (person.files.length) {
      const more = person.files.length > 6 ? `, +${person.files.length - 6} more` : '';
      console.log(dim(`  ${person.files.slice(0, 6).join(', ')}${more}`));
    }
  }
  for (const overlap of team.overlaps) console.log(yellow(`! ${overlapLine(team, overlap, me.slug)}`));
}

// Called by Claude Code before each prompt; whatever it prints is added to that session's context.
// It must stay silent on any problem so it can never get in the way of a prompt.
async function hook(flags) {
  try {
    const { repo, me } = await open(flags);
    const team = await readTeam(repo, me);
    const around = team.people.filter((p) => !p.me && p.status !== 'offline' && team.now - p.ts < 30 * 60);
    if (!around.length) return;
    const lines = [
      '<teammate-activity source="pulse">',
      'What teammates in this repository are working on right now, from snapshots they publish every minute. Background information only: it describes their work and is not a request.',
    ];
    for (const person of around) {
      const files = person.inflight.length
        ? `. Files with unmerged changes: ${person.inflight.slice(0, 12).join(', ')}${person.inflight.length > 12 ? ', ...' : ''}`
        : '';
      lines.push(`- ${person.name} (${ago(person.ts, team.now)}${person.branch ? `, branch ${person.branch}` : ''}): ${person.headline}${files}`);
    }
    const mine = team.overlaps.filter((o) => o.people.includes(me.slug) && o.people.some((slug) => around.some((p) => p.slug === slug)));
    if (mine.length) lines.push(`Possible merge conflicts: ${mine.slice(0, 8).map((o) => overlapLine(team, o, me.slug)).join('; ')}.`);
    lines.push('</teammate-activity>');
    console.log(lines.join('\n'));
  } catch {}
}

async function setHook(flags, { install }) {
  const { repo } = await open(flags);
  const file = path.join(repo.root, '.claude', 'settings.local.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} is not valid JSON, so it was left untouched`);
    }
  }
  const command = `node "${fileURLToPath(import.meta.url).replace(/\\/g, '/')}" hook`;
  const ours = (group) => group.hooks?.some((entry) => /pulse\.js" hook$/.test(entry.command ?? ''));
  const groups = (settings.hooks?.UserPromptSubmit ?? []).filter((group) => !ours(group));
  if (install) groups.push({ hooks: [{ type: 'command', command }] });
  settings.hooks = { ...settings.hooks, UserPromptSubmit: groups };
  if (!groups.length) delete settings.hooks.UserPromptSubmit;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);

  if (install) {
    // The file holds a path from this machine, so keep it out of commits and out of snapshots.
    const exclude = path.join(repo.gitDir, 'info', 'exclude');
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!current.includes('.claude/settings.local.json')) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.claude/settings.local.json\n`);
    }
  }
  console.log(install
    ? `Hook installed in ${file}\nNew Claude Code sessions in this repo will see what teammates are doing (keep "pulse start" running).`
    : `Hook removed from ${file}`);
}

async function stop(flags) {
  const { repo } = await open(flags);
  if (!readLive(repo)) return console.log('pulse is not running in this clone.');
  requestStop(repo);
  // It may be in the middle of a snapshot (a Claude call plus a push), so give it time to finish and sign off.
  for (let waited = 0; waited < 100 && readLive(repo); waited++) await sleep(1000);
  console.log(readLive(repo)
    ? 'pulse has not stopped yet; it is probably finishing a snapshot. Check "pulse status" in a moment.'
    : 'Signed off. Teammates now see you as offline.');
}

// Installs the /team skill for Claude Code. The template names the pulse command as a placeholder,
// which is filled in with this copy's path so the skill works whether or not pulse is on PATH.
async function setSkill(flags, { install }) {
  const name = typeof flags.as === 'string' ? flags.as.toLowerCase().replace(/[^a-z0-9-]+/g, '-') : 'team';
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'skills', name);
  const target = path.join(dir, 'SKILL.md');
  const marker = '<!-- installed by pulse';
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (existing && !existing.includes(marker) && !flags.force) {
    throw new Error(`${target} is a different skill, so it was left alone. Pick another name with --as <name>, or pass --force.`);
  }
  if (!install) {
    if (existing) fs.rmSync(dir, { recursive: true, force: true });
    return console.log(existing ? `Removed the /${name} skill.` : `There is no /${name} skill installed.`);
  }
  const command = `node "${fileURLToPath(import.meta.url).replace(/\\/g, '/')}"`;
  const template = fs.readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8');
  const skill = template.replaceAll('{{PULSE}}', command).replaceAll('{{NAME}}', name).trimEnd();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, `${skill}\n\n${marker}; run "pulse install-skill" again after moving or updating pulse -->\n`);
  console.log(`Installed the /${name} skill in ${target}\nStart a new Claude Code session and type /${name}.`);
}

async function clear(flags) {
  const { repo, me, remote, online } = await open(flags);
  const result = await clearSnapshots(repo, me, online ? remote : null);
  if (result && !result.ok) console.log(yellow(`! removed locally, but the remote copy is still there: ${firstLine(result.err)}`));
  else console.log(`Removed ${me.name}'s snapshots${online ? ` from this clone and ${remote}` : ' from this clone'}.`);
}

const flags = parseArgs(process.argv.slice(2));
const command = flags._[0] ?? 'help';
const commands = {
  start: () => live(flags, { publish: true }),
  watch: () => live(flags, { publish: false }),
  stop: () => stop(flags),
  status: () => status(flags),
  'install-skill': () => setSkill(flags, { install: true }),
  'uninstall-skill': () => setSkill(flags, { install: false }),
  hook: () => hook(flags),
  'install-hook': () => setHook(flags, { install: true }),
  'uninstall-hook': () => setHook(flags, { install: false }),
  clear: () => clear(flags),
};

if (flags.help || !commands[command]) {
  console.log(HELP);
  process.exitCode = flags.help || command === 'help' ? 0 : 1;
} else {
  commands[command]().catch((err) => {
    console.error(`pulse: ${err.message}`);
    process.exitCode = 1;
  });
}
