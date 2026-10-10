import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const winQuote = (arg) => `"${String(arg).replace(/"/g, '\\"')}"`;

// Runs a command to completion and never rejects: callers branch on `ok`.
export function run(cmd, args = [], { cwd, env, input, timeout, shell = false } = {}) {
  return new Promise((resolve) => {
    const done = (code, stdout = '', stderr = '') => resolve({ ok: code === 0, code, stdout, stderr });
    let child;
    try {
      child = shell
        ? spawn([cmd, ...args].map(winQuote).join(' '), { cwd, env, shell: true, windowsHide: true })
        : spawn(cmd, args, { cwd, env, windowsHide: true });
    } catch (err) {
      return done(-1, '', err.message);
    }
    const out = [];
    const errOut = [];
    let timedOut = false;
    const timer = timeout && setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => errOut.push(chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      done(-1, '', err.message);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return done(-2, '', `timed out after ${Math.round(timeout / 1000)}s`);
      done(code ?? -1, Buffer.concat(out).toString('utf8'), Buffer.concat(errOut).toString('utf8'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

// pulse works in the background, so git must fail fast instead of opening a credential prompt.
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

export async function gitTry(repo, args, { env, input, timeout } = {}) {
  const r = await run('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: repo.root,
    env: { ...process.env, ...NO_PROMPT, ...env },
    input,
    timeout,
  });
  return { ok: r.ok, out: r.stdout, err: r.stderr.trim() };
}

export async function git(repo, args, opts) {
  const r = await gitTry(repo, args, opts);
  if (!r.ok) {
    const verb = args.find((a) => !a.startsWith('-')) ?? '';
    throw new Error(`git ${verb} failed: ${r.err || 'unknown error'}`);
  }
  return r.out;
}

export async function openRepo(dir) {
  const r = await run('git', ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { cwd: dir });
  if (!r.ok) throw new Error(`${dir} is not inside a git repository`);
  const [root, gitDir] = r.stdout.trim().split(/\r?\n/);
  return { root, gitDir, name: path.basename(root) };
}

export async function whoami(repo, override) {
  const config = async (key) => (await gitTry(repo, ['config', key])).out.trim();
  // Remember an explicit name so `pulse hook` and later runs agree on who "you" is.
  if (override) await gitTry(repo, ['config', '--local', 'pulse.name', override]);
  const userName = await config('user.name');
  const userEmail = await config('user.email');
  const name = override || process.env.PULSE_NAME || (await config('pulse.name')) || userName || os.userInfo().username;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'someone';
  // commit-tree refuses to run without an identity, so lend it one when git has none configured.
  const identity = {};
  if (!userName) identity.GIT_AUTHOR_NAME = identity.GIT_COMMITTER_NAME = name;
  if (!userEmail) identity.GIT_AUTHOR_EMAIL = identity.GIT_COMMITTER_EMAIL = `${slug}@pulse.invalid`;
  return { name, slug, identity };
}
