import fs from 'node:fs';
import path from 'node:path';
import { git, gitTry } from './git.js';

// Snapshots live under refs/pulse/* rather than refs/heads/*: GitHub stores them like any ref,
// but they are not branches, so they never trigger CI, PR banners or branch-protection rules.
export const localRef = (slug) => `refs/pulse/${slug}`;
export const REMOTE_NS = 'refs/pulse-remote';

const MAX_UNTRACKED_BYTES = 1024 * 1024;
const MAX_CHAIN = 240;
const MAX_LISTED = 300;

const SECRET_RE = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.json)?|[^/]*secrets?[^/]*\.(json|ya?ml|toml|txt))$|\.(pem|key|p12|pfx|jks|keystore)$/i;
const ENV_TEMPLATE_RE = /\.env\.(example|sample|template)$/i;
const VENDOR_RE = /(^|\/)(node_modules|\.venv|venv|__pycache__)\//;
// Lockfiles and build output tell the narrator nothing, so they stay out of the diff it reads.
const NOISE = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Cargo.lock', '*.min.js', '*.min.css', '*.map']
  .map((name) => `:(exclude,glob)**/${name}`);

const zlist = (out) => out.split('\0').filter(Boolean);
const rev = async (repo, spec) => (await gitTry(repo, ['rev-parse', '-q', '--verify', spec])).out.trim() || null;

export function parseMeta(body) {
  const match = /^Pulse-Meta: (\{.*\})\s*$/m.exec(body ?? '');
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function readSnapshot(repo, commit) {
  const body = await git(repo, ['log', '-1', '--format=%B', commit]);
  return { headline: body.split('\n')[0].trim(), meta: parseMeta(body) };
}

// Tracked files are shared as-is (they are headed for the remote anyway); new files are screened
// first because nobody chose to publish them yet.
function screenUntracked(root, files) {
  const keep = [];
  const skipped = [];
  for (const file of files) {
    const vendor = VENDOR_RE.exec(file);
    if (vendor) {
      skipped.push({ file: file.slice(0, vendor.index + vendor[0].length), why: 'dependency folder' });
    } else if (SECRET_RE.test(file) && !ENV_TEMPLATE_RE.test(file)) {
      skipped.push({ file, why: 'looks like a secret' });
    } else {
      let size = -1;
      try {
        size = fs.statSync(path.join(root, file)).size;
      } catch {}
      if (size < 0) skipped.push({ file, why: 'unreadable' });
      else if (size > MAX_UNTRACKED_BYTES) skipped.push({ file, why: 'over 1 MB' });
      else keep.push(file);
    }
  }
  return { keep, skipped };
}

// Builds a tree of the working directory through a private index, so the user's branch,
// staging area and stashes are never touched.
async function buildTree(repo) {
  const scratch = path.join(repo.gitDir, 'pulse-index');
  const real = path.resolve(repo.root, (await git(repo, ['rev-parse', '--git-path', 'index'])).trim());
  // Starting from a copy of the real index keeps git's stat cache, so unchanged files are not re-hashed.
  if (fs.existsSync(real)) fs.copyFileSync(real, scratch);
  else fs.rmSync(scratch, { force: true });
  const env = { GIT_INDEX_FILE: scratch };
  await git(repo, ['add', '-u'], { env });
  const untracked = zlist(await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'], { env }))
    .filter((file) => !file.endsWith('/'));
  const { keep, skipped } = screenUntracked(repo.root, untracked);
  if (keep.length) {
    await git(repo, ['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      env,
      input: `${keep.join('\0')}\0`,
    });
  }
  return { tree: (await git(repo, ['write-tree'], { env })).trim(), skipped };
}

async function mainline(repo, remote) {
  const remoteHead = (await gitTry(repo, ['symbolic-ref', '-q', '--short', `refs/remotes/${remote}/HEAD`])).out.trim();
  for (const ref of [remoteHead, `${remote}/main`, `${remote}/master`]) {
    if (ref && (await rev(repo, `${ref}^{commit}`))) return ref;
  }
  return null;
}

// Everything this person has that the shared mainline does not: unpushed commits plus uncommitted edits.
async function unmergedFiles(repo, remote, head, headTree, tree) {
  let from = headTree;
  const trunk = head && (await mainline(repo, remote));
  if (trunk) from = (await gitTry(repo, ['merge-base', head, trunk])).out.trim() || headTree;
  return zlist(await git(repo, ['diff', '--name-only', '-z', '--no-renames', from, tree])).slice(0, MAX_LISTED);
}

export async function captureChanges(repo, me, session, remote) {
  const { tree, skipped } = await buildTree(repo);
  const prev = await rev(repo, `${localRef(me.slug)}^{commit}`);
  const head = await rev(repo, 'HEAD^{commit}');
  const prevTree = prev && (await rev(repo, `${prev}^{tree}`));
  // The first tick of a run always publishes, so teammates see you arrive even with a clean tree.
  const first = !session.started;
  if (!first && prevTree === tree) return { changed: false, head, skipped };

  const headTree = head ? await rev(repo, `${head}^{tree}`) : (await git(repo, ['hash-object', '-t', 'tree', '--stdin'])).trim();
  // First tick: everything uncommitted right now. Later ticks: what changed since the last snapshot.
  const from = first || !prevTree ? headTree : prevTree;
  const range = [from, tree];
  const files = zlist(await git(repo, ['diff', '--name-only', '-z', '--no-renames', ...range]));
  const shortstat = await git(repo, ['diff', '--shortstat', ...range]);
  const count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(shortstat)?.[1] ?? 0);
  const last = prev ? await readSnapshot(repo, prev) : null;
  const moved = session.head && head && session.head !== head;

  return {
    changed: true,
    first,
    tree,
    prev,
    head,
    skipped,
    files,
    stats: { files: files.length, add: count('insertion'), del: count('deletion') },
    stat: await git(repo, ['diff', '--stat=120', '--no-renames', ...range]),
    patch: await git(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U2', ...range, '--', '.', ...NOISE]),
    branch: (await gitTry(repo, ['symbolic-ref', '-q', '--short', 'HEAD'])).out.trim() || 'detached',
    commits: moved ? (await gitTry(repo, ['log', '--format=%s', '-n', '8', `${session.head}..${head}`])).out.split('\n').filter(Boolean) : [],
    inflight: await unmergedFiles(repo, remote, head, headTree, tree),
    prevHeadline: last?.meta && last.meta.status !== 'left' ? last.headline : null,
    seq: (last?.meta?.seq ?? 0) + 1,
  };
}

async function writeCommit(repo, me, tree, parents, headline, meta) {
  const message = `${headline}\n\nPulse-Meta: ${JSON.stringify(meta)}\n`;
  const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '--no-gpg-sign', '-F', '-'];
  const commit = (await git(repo, args, { input: message, env: me.identity })).trim();
  await git(repo, ['update-ref', localRef(me.slug), commit]);
  return commit;
}

export async function commitSnapshot(repo, me, cap, { headline, ai }) {
  // Each person's snapshots form their own chain; restarting it now and then lets old ones be garbage-collected.
  const restart = !cap.prev || cap.seq % MAX_CHAIN === 0;
  const parents = restart ? (cap.head ? [cap.head] : []) : [cap.prev];
  const meta = {
    v: 1,
    name: me.name,
    seq: cap.seq,
    status: 'active',
    branch: cap.branch,
    head: cap.head?.slice(0, 10) ?? null,
    ai,
    stats: cap.stats,
    changed: cap.files.slice(0, 60),
    inflight: cap.inflight,
  };
  return writeCommit(repo, me, cap.tree, parents, headline, meta);
}

// Marks you as offline for teammates while keeping the last thing you were doing.
export async function signOff(repo, me) {
  const prev = await rev(repo, `${localRef(me.slug)}^{commit}`);
  if (!prev) return false;
  const last = await readSnapshot(repo, prev);
  if (!last.meta || last.meta.status === 'left') return false;
  const meta = { ...last.meta, seq: (last.meta.seq ?? 0) + 1, status: 'left', changed: [] };
  await writeCommit(repo, me, await rev(repo, `${prev}^{tree}`), [prev], last.headline, meta);
  return true;
}

export function pushSnapshot(repo, me, remote) {
  const ref = localRef(me.slug);
  // --no-verify: a project's pre-push hook (tests, lint) is meant for real pushes, not a snapshot every minute.
  return gitTry(repo, ['push', '--quiet', '--no-verify', remote, `+${ref}:${ref}`], { timeout: 45_000 });
}

export async function clearSnapshots(repo, me, remote) {
  const ref = localRef(me.slug);
  const remoteResult = remote ? await gitTry(repo, ['push', '--quiet', '--no-verify', remote, `:${ref}`], { timeout: 45_000 }) : null;
  await gitTry(repo, ['update-ref', '-d', ref]);
  await gitTry(repo, ['update-ref', '-d', `${REMOTE_NS}/${me.slug}`]);
  fs.rmSync(path.join(repo.gitDir, 'pulse-index'), { force: true });
  return remoteResult;
}
