// bb-plugin-auto-archive — backend entry.
//
// Sweeps all root threads on load and then hourly, archiving any that have
// had no activity for the configured number of days. Activity is bb's
// `latestAttentionAt` (last turn completion / error / creation) — reads and
// metadata edits never count. Child threads are never archived directly:
// archiving a parent cascades to its children.
//
// Everything destructive is configurable: pinned/hidden/running threads are
// skipped by default, and a dry-run mode logs candidates without touching
// them.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  HOUR_MS,
  msUntilNextHour,
  parseInactivityDays,
  selectThreadsToArchive,
  sleep,
  type SweepConfig,
  type SweepStats,
} from "./sweep.js";

export interface ResolvedSweepConfig extends SweepConfig {
  /** Log candidates without archiving anything. */
  dryRun: boolean;
}

export interface RunSweepOptions {
  /** Injectable clock for tests. */
  now?: number;
  /** Override the config's dry-run for this sweep (CLI `--dry-run`). */
  dryRun?: boolean;
  /** Abort the sweep between pages/archives when the caller disconnects. */
  signal?: AbortSignal;
}

const PAGE_SIZE = 100;

/**
 * Run one archive sweep: page through non-archived root threads (hidden
 * included so the config can decide), select stale ones, archive them, and
 * record the outcome in kv for `bb auto-archive status`.
 */
export async function runSweep(
  bb: BbPluginApi,
  config: ResolvedSweepConfig,
  options: RunSweepOptions = {},
): Promise<SweepStats> {
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? config.dryRun;
  const stats: SweepStats = {
    scanned: 0,
    candidates: 0,
    archived: 0,
    errors: 0,
    dryRun,
  };

  // Collect candidates first, then archive: the list is offset-paged, and
  // archiving mid-scan would shift the page window.
  const candidates: { id: string; label: string }[] = [];
  let offset = 0;
  while (!options.signal?.aborted) {
    const page = await bb.sdk.threads.list({
      archived: false,
      includeHidden: true,
      hasParent: false,
      limit: PAGE_SIZE,
      offset,
    });
    stats.scanned += page.length;
    candidates.push(
      ...selectThreadsToArchive(page, config, now).map((thread) => ({
        id: thread.id,
        label: threadTitle(thread),
      })),
    );
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  stats.candidates = candidates.length;

  for (const candidate of candidates) {
    if (options.signal?.aborted) break;
    if (dryRun) {
      bb.log.info(`[dry-run] would archive ${candidate.id} — ${candidate.label}`);
      continue;
    }
    try {
      await bb.sdk.threads.archive({ threadId: candidate.id });
      stats.archived += 1;
      bb.log.info(`archived ${candidate.id} — ${candidate.label}`);
    } catch (error) {
      stats.errors += 1;
      bb.log.error(
        `failed to archive ${candidate.id} — ${errorMessage(error)}`,
      );
    }
  }

  await bb.storage.kv.set("last-sweep", { at: now, ...stats });
  return stats;
}

export function threadTitle(thread: {
  title: string | null;
  titleFallback: string | null;
}): string {
  return thread.title ?? thread.titleFallback ?? "untitled";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    inactivityDays: {
      type: "string",
      label: "Inactivity threshold (days)",
      description:
        "Archive threads whose last activity is older than this many days.",
      default: "2",
    },
    archivePinned: {
      type: "boolean",
      label: "Archive pinned threads",
      description:
        "Also archive pinned threads that meet the inactivity threshold.",
      default: false,
    },
    archiveHidden: {
      type: "boolean",
      label: "Archive hidden threads",
      description:
        "Also archive hidden background-worker threads. Off by default — " +
        "their owners manage their lifecycle.",
      default: false,
    },
    archiveRunning: {
      type: "boolean",
      label: "Archive threads with work in flight",
      description:
        "Also archive threads that are starting, active, or stopping. " +
        "Archiving stops running work, so this is off by default.",
      default: false,
    },
    dryRun: {
      type: "boolean",
      label: "Dry run",
      description:
        "Report what would be archived without archiving anything.",
      default: false,
    },
  });

  async function resolveConfig(): Promise<ResolvedSweepConfig> {
    const values = await settings.get();
    return {
      inactivityDays: parseInactivityDays(values.inactivityDays),
      archivePinned: values.archivePinned,
      archiveHidden: values.archiveHidden,
      archiveRunning: values.archiveRunning,
      dryRun: values.dryRun,
    };
  }

  // Sweep once on load, then at the top of every hour. Settings are re-read
  // per sweep so a `bb plugin config` change applies on the next run.
  bb.background.service("sweeper", {
    async start(signal) {
      while (!signal.aborted) {
        const config = await resolveConfig();
        try {
          const stats = await runSweep(bb, config, { signal });
          bb.log.info(
            `sweep complete — scanned ${stats.scanned}, archived ${stats.archived}, ` +
              `errors ${stats.errors}${stats.dryRun ? " (dry run)" : ""}`,
          );
        } catch (error) {
          bb.log.error(`sweep failed: ${errorMessage(error)}`);
        }
        await sleep(msUntilNextHour(), signal);
      }
    },
  });

  bb.cli.register({
    name: "auto-archive",
    summary: "Auto-archive threads with no recent activity",
    commands: [
      {
        name: "run",
        summary: "Run an archive sweep now",
        usage: "bb auto-archive run [--dry-run]",
      },
      {
        name: "status",
        summary: "Show the last sweep result and current configuration",
        usage: "bb auto-archive status",
      },
    ],
    async run(argv, ctx) {
      const [sub, ...rest] = argv;
      if (sub === "run") {
        const config = await resolveConfig();
        const stats = await runSweep(
          bb,
          {
            ...config,
            dryRun: rest.includes("--dry-run") ? true : config.dryRun,
          },
          { signal: ctx.signal },
        );
        return {
          exitCode: 0,
          stdout: formatStats(stats),
        };
      }
      if (sub === "status") {
        const config = await resolveConfig();
        const last = await bb.storage.kv.get<
          SweepStats & { at: number }
        >("last-sweep");
        const lines = [
          `threshold: ${config.inactivityDays} day(s)`,
          `archive pinned: ${config.archivePinned}`,
          `archive hidden: ${config.archiveHidden}`,
          `archive running: ${config.archiveRunning}`,
          `dry run: ${config.dryRun}`,
        ];
        if (last) {
          lines.push(
            `last sweep: ${new Date(last.at).toISOString()}`,
            formatStats(last),
          );
        } else {
          lines.push("last sweep: never");
        }
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      return {
        exitCode: 2,
        stderr: "usage: bb auto-archive <run|status>",
      };
    },
  });
}

function formatStats(stats: SweepStats): string {
  const suffix = stats.dryRun ? " (dry run)" : "";
  return (
    `scanned ${stats.scanned}, candidates ${stats.candidates}, ` +
    `archived ${stats.archived}, errors ${stats.errors}${suffix}`
  );
}
