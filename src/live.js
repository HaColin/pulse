import fs from 'node:fs';
import path from 'node:path';

// A running `pulse start` leaves a small marker in the clone's .git folder, so other commands
// (and the /team skill) can tell whether this clone is being shared and where its dashboard is.
const HEARTBEAT_LIMIT_MS = 5 * 60 * 1000;
const liveFile = (repo) => path.join(repo.gitDir, 'pulse-live.json');
const stopFile = (repo) => path.join(repo.gitDir, 'pulse-stop');

export function markLive(repo, info) {
  fs.writeFileSync(liveFile(repo), JSON.stringify({ ...info, pid: process.pid, beat: Date.now() }));
}

export function clearLive(repo) {
  fs.rmSync(liveFile(repo), { force: true });
  fs.rmSync(stopFile(repo), { force: true });
}

export function readLive(repo) {
  try {
    const info = JSON.parse(fs.readFileSync(liveFile(repo), 'utf8'));
    // Signal 0 only checks that the process exists; the heartbeat covers a recycled pid after a crash.
    process.kill(info.pid, 0);
    return Date.now() - info.beat < HEARTBEAT_LIMIT_MS ? info : null;
  } catch {
    return null;
  }
}

// Windows cannot deliver Ctrl+C to another process, so `pulse stop` leaves a note the running loop looks for.
export function requestStop(repo) {
  fs.writeFileSync(stopFile(repo), '');
}

export function stopRequested(repo) {
  return fs.existsSync(stopFile(repo));
}
