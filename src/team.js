import { git, gitTry } from './git.js';
import { REMOTE_NS, parseMeta } from './snapshot.js';

const ACTIVE_SECONDS = 3 * 60;
const OVERLAP_WINDOW_SECONDS = 8 * 60 * 60;
const HISTORY_COMMITS = 60;
const HISTORY_SHOWN = 10;

export function fetchTeam(repo, remote) {
  // --no-write-fetch-head: a background fetch must not clobber the FETCH_HEAD a `git pull` in progress relies on.
  return gitTry(repo, ['fetch', '--quiet', '--no-tags', '--prune', '--no-write-fetch-head', remote, `+refs/pulse/*:${REMOTE_NS}/*`], { timeout: 45_000 });
}

async function readChain(repo, ref) {
  const out = await git(repo, ['log', '--first-parent', '-n', String(HISTORY_COMMITS), '--format=%H%x1f%ct%x1f%B%x1e', ref]);
  const entries = [];
  for (const record of out.split('\x1e')) {
    const [sha, time, body] = record.trimStart().split('\x1f');
    if (!sha) continue;
    const meta = parseMeta(body);
    // A snapshot chain is rooted on an ordinary project commit; stop when we walk off the end of it.
    if (!meta) break;
    entries.push({ sha, ts: Number(time), headline: body.split('\n')[0].trim(), meta });
  }
  return entries;
}

// Collapses a run of identical headlines into one entry dated from when that activity began.
function timeline(entries) {
  const runs = [];
  for (const entry of entries) {
    const run = runs.at(-1);
    if (run && run.headline === entry.headline) run.since = entry.ts;
    else runs.push({ headline: entry.headline, since: entry.ts });
  }
  return runs.slice(0, HISTORY_SHOWN);
}

function findOverlaps(people, now) {
  const holders = new Map();
  for (const person of people) {
    if (now - person.ts > OVERLAP_WINDOW_SECONDS) continue;
    for (const file of person.inflight) holders.set(file, [...(holders.get(file) ?? []), person.slug]);
  }
  return [...holders]
    .filter(([, slugs]) => slugs.length > 1)
    .map(([file, slugs]) => ({ file, people: slugs }))
    .sort((a, b) => a.file.localeCompare(b.file))
    .slice(0, 50);
}

export async function readTeam(repo, me) {
  const refs = (await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/pulse', REMOTE_NS])).split('\n').map((s) => s.trim()).filter(Boolean);
  const chosen = new Map();
  for (const ref of refs) {
    const local = !ref.startsWith(`${REMOTE_NS}/`);
    const slug = ref.split('/').slice(2).join('/');
    // Your own local ref is fresher than the copy that came back from the remote.
    if (local && slug !== me.slug) continue;
    if (local || !chosen.has(slug)) chosen.set(slug, ref);
  }

  const now = Math.floor(Date.now() / 1000);
  const people = [];
  for (const [slug, ref] of chosen) {
    const entries = await readChain(repo, ref);
    if (!entries.length) continue;
    const { sha, ts, headline, meta } = entries[0];
    people.push({
      slug,
      name: meta.name || slug,
      me: slug === me.slug,
      sha,
      ts,
      status: meta.status === 'left' ? 'offline' : now - ts <= ACTIVE_SECONDS ? 'active' : 'idle',
      headline,
      branch: meta.branch ?? null,
      ai: Boolean(meta.ai),
      stats: meta.stats ?? null,
      files: meta.changed ?? [],
      inflight: meta.inflight ?? [],
      history: timeline(entries),
    });
  }
  const rank = { active: 0, idle: 1, offline: 2 };
  people.sort((a, b) => rank[a.status] - rank[b.status] || b.ts - a.ts);
  return { now, people, overlaps: findOverlaps(people, now) };
}

export function ago(ts, now = Math.floor(Date.now() / 1000)) {
  const seconds = Math.max(0, now - ts);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function nameList(team, slugs, meSlug) {
  const names = slugs.map((slug) => (slug === meSlug ? 'you' : team.people.find((p) => p.slug === slug)?.name ?? slug));
  names.sort((a, b) => (a === 'you' ? -1 : b === 'you' ? 1 : 0));
  return names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(' and ');
}
