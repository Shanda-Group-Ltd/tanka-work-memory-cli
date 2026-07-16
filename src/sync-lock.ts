/**
 * Cross-process advisory lock for `runSync`.
 *
 * The manifest and the all-mode project-map are both whole-file
 * read-modify-write stores. If a cron-scheduled sync and an interactive Board
 * sync (or two overlapping cron runs) execute concurrently, the last writer
 * wins and silently drops the other's records — and in all mode two processes
 * can each lazily create a remote project for the same new cwd, leaving a
 * duplicate. A single advisory lock around the whole run avoids both.
 *
 * The lock is a file created with `O_EXCL`. A crashed run can leave the file
 * behind, so the holder records its pid + a random `token` + start time, and a
 * lock is considered *stale* (and stolen) when its pid is no longer alive or it
 * has outlived `STALE_MS` — no real sync should ever run that long. Release
 * matches on the `token`, not just the pid, AND abstains a safety margin before
 * `STALE_MS` (see {@link RELEASE_SAFETY_MARGIN_MS}), so a holder that was about
 * to be (or already) stolen can't delete the new owner's lock.
 *
 * Guarantee & limits: mutual exclusion holds as long as a holder finishes within
 * `STALE_MS`; past that the lock degrades to "stealable" by design. Because the
 * filesystem offers no compare-and-delete, release is fundamentally a non-atomic
 * check-then-delete — the margin shrinks the residual race to "needs a
 * multi-minute stall between two adjacent syscalls" (never observed) rather than
 * eliminating it. The only provably-atomic alternative is a kernel advisory lock
 * (flock/fcntl), which the stdlib-only / no-native-deps constraint rules out.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { scienceExportLockPath, syncLockPath } from './config/paths';

/** A sync should never legitimately run longer than this; older = crashed. */
const STALE_MS = 30 * 60 * 1000;

/**
 * Release abstains this much *before* STALE_MS. `release` reads the lock then
 * `rmSync`s it (a non-atomic check-then-delete), so if the process were
 * descheduled between the read and the delete and real time crossed the steal
 * threshold in that gap, it could delete a new owner's lock. Abstaining a margin
 * early means the gap would have to last the whole margin for that to happen —
 * minutes between two adjacent syscalls, which a normally-scheduled process
 * never hits (a SIGSTOP / debugger pause / VM freeze / host sleep could, but
 * those are out of scope). This shrinks the window to effectively zero but does
 * NOT make it provably atomic; only a kernel advisory lock (flock/fcntl, held on
 * the fd, auto-released on exit) would, and that's outside this project's
 * stdlib-only constraint.
 *
 * Time-basis note: release measures elapsed via `acquiredAt` (wall-clock
 * `Date.now()`) while stealers use the file `mtime`; a large clock step during a
 * run could skew the two thresholds, but the margin absorbs anything short of a
 * minutes-long jump, and a single host shares one clock so they move together.
 */
const RELEASE_SAFETY_MARGIN_MS = 5 * 60 * 1000;

export interface SyncLock {
  /** Release the lock. Idempotent and best-effort (never throws). */
  release(): void;
}

interface LockBody {
  pid?: number;
  token?: string;
  startedAt?: string;
}

function isAlive(pid: number): boolean {
  try {
    // signal 0 probes existence without actually signalling.
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** True iff an existing lock file may be safely stolen (crashed / timed out). */
function isStale(path: string): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // Can't even stat it (vanished / unreadable) — let the caller's retry try
    // to recreate it rather than declaring it stealable.
    return true;
  }
  // A timed-out lock is always stealable, parseable or not.
  if (Date.now() - mtimeMs > STALE_MS) return true;
  // Fresh lock: steal ONLY when we can read a *dead* holder's pid. A fresh but
  // empty/unparseable file means another process is mid-creation (it called
  // openSync('wx') but hasn't written the body yet) — must NOT steal it, or two
  // runs would both enter the critical section. Back off instead.
  try {
    const body = JSON.parse(readFileSync(path, 'utf8')) as LockBody;
    if (typeof body.pid === 'number' && body.pid !== process.pid) {
      return !isAlive(body.pid);
    }
    return false;
  } catch {
    return false;
  }
}

function writeLock(path: string): SyncLock {
  const token = randomUUID();
  const acquiredAt = Date.now();
  // `wx` = O_CREAT | O_EXCL — fails if the file already exists.
  const fd = openSync(path, 'wx');
  try {
    writeFileSync(
      fd,
      `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`,
    );
  } finally {
    closeSync(fd);
  }
  return {
    release(): void {
      // If we've held the lock near STALE_MS, another process may have judged it
      // stale and stolen it — and the "read token → rmSync" below is a non-atomic
      // check-then-delete, so deleting now could remove the new owner's lock. We
      // can only be stolen once age > STALE_MS (a stealer needs that, or our pid
      // dead — but our pid is alive, we're running this), so we abstain a safety
      // margin early: the steal threshold can't be crossed between this check and
      // the rmSync unless the process stalls for the whole margin (minutes — a
      // normally-scheduled process won't). Past the threshold we abstain and let
      // the next sweep reclaim it — so a holder finishing in [25,30)min leaves a
      // lingering lock that's only stealable at the 30min mark or once its pid
      // dies; an acceptable availability tradeoff, not a mutual-exclusion hole.
      if (Date.now() - acquiredAt >= STALE_MS - RELEASE_SAFETY_MARGIN_MS)
        return;
      try {
        // Match on the token, not just the pid: belt-and-suspenders for the same
        // ownership check (a different token means the file is no longer ours).
        const body = JSON.parse(readFileSync(path, 'utf8')) as LockBody;
        if (body.token === token) rmSync(path);
      } catch {
        /* already gone or unreadable — nothing to do */
      }
    },
  };
}

/**
 * Try to acquire the advisory lock at `path`. Returns a {@link SyncLock} on
 * success, or `null` if another live holder already has it (caller should skip).
 * A stale lock (crashed holder / timed out) is stolen transparently. Generic so
 * the same steal/margin machinery guards both the sync lock and the
 * science-export lock — see {@link acquireSyncLock} / {@link acquireScienceExportLock}.
 */
export function acquireLock(path: string): SyncLock | null {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return writeLock(path);
    } catch {
      // Exists — steal it if stale, then retry once; otherwise give up.
      if (!isStale(path)) return null;
      try {
        rmSync(path);
      } catch {
        /* someone else may have just cleaned it — retry will tell */
      }
    }
  }
  return null;
}

/**
 * Try to acquire the sync lock. Returns a {@link SyncLock} on success, or
 * `null` if another live sync already holds it (caller should skip this run).
 */
export function acquireSyncLock(): SyncLock | null {
  return acquireLock(syncLockPath());
}

/**
 * Try to acquire the science-export lock (distinct from the sync lock). Held
 * only for the export's duration by whichever writer runs it — an interactive
 * refresh or a sync's export step — so the two can't `rmtree`+rewrite the same
 * session dirs at once. `null` means another export is mid-write; skip (the
 * discovery reader tolerates a half-written tree and the next run self-heals).
 */
export function acquireScienceExportLock(): SyncLock | null {
  return acquireLock(scienceExportLockPath());
}
