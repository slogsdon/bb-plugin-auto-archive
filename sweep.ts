// Pure sweep logic for bb-plugin-auto-archive.
//
// Kept free of the plugin API so it is unit-testable without a bb server.
// The factory in server.ts wires these functions to settings, the background
// sweeper, and the CLI.

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;

/** Thread fields the sweep reads. Structurally compatible with bb's thread
 * list entries, so full entries satisfy this shape. */
export interface ThreadActivitySnapshot {
  id: string;
  archivedAt: number | null;
  pinnedAt: number | null;
  deletedAt: number | null;
  visibility: "visible" | "hidden";
  status: "error" | "stopping" | "idle" | "starting" | "active";
  parentThreadId: string | null;
  latestAttentionAt: number;
}

export interface SweepConfig {
  /** Days of inactivity before a thread becomes a candidate. */
  inactivityDays: number;
  /** Also archive pinned threads that meet the threshold. */
  archivePinned: boolean;
  /** Also archive hidden (background-worker) threads. */
  archiveHidden: boolean;
  /** Also archive threads with work in flight (starting/active/stopping). */
  archiveRunning: boolean;
  /**
   * Epoch ms of the initial install. Threads whose last activity predates
   * this (i.e. a pre-existing backlog that was already idle when the plugin
   * was installed) are never auto-archived. 0 disables the guard.
   */
  sinceInstallAt: number;
}

export interface SweepStats {
  scanned: number;
  candidates: number;
  archived: number;
  errors: number;
  dryRun: boolean;
}

/**
 * Which threads to archive, in sweep order.
 *
 * A thread is a candidate when it has been completely quiet for the full
 * inactivity window:
 * - `latestAttentionAt` is bb's last-activity marker: the most recent turn
 *   completion, error, or creation time. It does not move on read-state or
 *   metadata changes, so opening a thread never counts as activity.
 * - Child threads are never selected directly: archiving a parent cascades
 *   to its children, and a child's attention timestamp does not advance on
 *   turn completion, so selecting children independently would misjudge
 *   them.
 * - Threads with work in flight (starting/active/stopping) are skipped
 *   unless `archiveRunning`, because archiving stops running work.
 * - Pinned and hidden threads are skipped unless opted in.
 * - A fresh install never nukes a pre-existing backlog: threads whose last
 *   activity (`latestAttentionAt`) predates `sinceInstallAt` are skipped,
 *   so only threads that become idle after install are ever candidates.
 *   Combined with the inactivity cutoff this also means nothing is archived
 *   until the full window has elapsed since install.
 */
export function selectThreadsToArchive<T extends ThreadActivitySnapshot>(
  threads: readonly T[],
  config: SweepConfig,
  now: number,
): T[] {
  const cutoff = now - config.inactivityDays * DAY_MS;
  const since = config.sinceInstallAt ?? 0;
  return threads.filter((thread) => {
    if (thread.archivedAt !== null || thread.deletedAt !== null) {
      return false;
    }
    if (thread.parentThreadId !== null) {
      return false;
    }
    if (thread.visibility === "hidden" && !config.archiveHidden) {
      return false;
    }
    if (thread.pinnedAt !== null && !config.archivePinned) {
      return false;
    }
    if (
      thread.status !== "idle" &&
      thread.status !== "error" &&
      !config.archiveRunning
    ) {
      return false;
    }
    if (thread.latestAttentionAt < since) {
      return false;
    }
    return thread.latestAttentionAt <= cutoff;
  });
}

/** Parse the string `inactivityDays` setting; falls back to 2 on garbage. */
export function parseInactivityDays(raw: string): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 2;
}

/** Milliseconds until the next top-of-hour; exactly on the hour → a full hour. */
export function msUntilNextHour(now: Date = new Date()): number {
  return (
    (60 - now.getMinutes()) * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds()
  );
}

/** Abort-aware sleep: resolves early (without clearing the caller's timer
 * state) when `signal` aborts, so services stop promptly on reload. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
