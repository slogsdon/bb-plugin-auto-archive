import { createRequire as __createRequire } from "node:module";
import { dirname as __pathDirname } from "node:path";
import { fileURLToPath as __fileURLToPath } from "node:url";
const require = __createRequire(import.meta.url);
var __filename = __fileURLToPath(import.meta.url);
var __dirname = __pathDirname(__filename);

// sweep.ts
var HOUR_MS = 60 * 6e4;
var DAY_MS = 24 * HOUR_MS;
function selectThreadsToArchive(threads, config, now) {
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
    if (thread.status !== "idle" && thread.status !== "error" && !config.archiveRunning) {
      return false;
    }
    if (thread.latestAttentionAt < since) {
      return false;
    }
    return thread.latestAttentionAt <= cutoff;
  });
}
function parseInactivityDays(raw) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 2;
}
function msUntilNextHour(now = /* @__PURE__ */ new Date()) {
  return (60 - now.getMinutes()) * 6e4 - now.getSeconds() * 1e3 - now.getMilliseconds();
}
function sleep(ms, signal) {
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

// server.ts
var PAGE_SIZE = 100;
async function runSweep(bb, config, options = {}) {
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? config.dryRun;
  const stats = {
    scanned: 0,
    candidates: 0,
    archived: 0,
    errors: 0,
    dryRun
  };
  const candidates = [];
  let offset = 0;
  while (!options.signal?.aborted) {
    const page = await bb.sdk.threads.list({
      archived: false,
      includeHidden: true,
      hasParent: false,
      limit: PAGE_SIZE,
      offset
    });
    stats.scanned += page.length;
    candidates.push(
      ...selectThreadsToArchive(page, config, now).map((thread) => ({
        id: thread.id,
        label: threadTitle(thread)
      }))
    );
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  stats.candidates = candidates.length;
  for (const candidate of candidates) {
    if (options.signal?.aborted) break;
    if (dryRun) {
      bb.log.info(`[dry-run] would archive ${candidate.id} \u2014 ${candidate.label}`);
      continue;
    }
    try {
      await bb.sdk.threads.archive({ threadId: candidate.id });
      stats.archived += 1;
      bb.log.info(`archived ${candidate.id} \u2014 ${candidate.label}`);
    } catch (error) {
      stats.errors += 1;
      bb.log.error(
        `failed to archive ${candidate.id} \u2014 ${errorMessage(error)}`
      );
    }
  }
  await bb.storage.kv.set("last-sweep", { at: now, ...stats });
  return stats;
}
function threadTitle(thread) {
  return thread.title ?? thread.titleFallback ?? "untitled";
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
async function plugin(bb) {
  bb.log.info("loaded");
  const settings = bb.settings.define({
    inactivityDays: {
      type: "string",
      label: "Inactivity threshold (days)",
      description: "Archive threads whose last activity is older than this many days. Only threads that went idle AFTER this plugin was installed are ever archived \u2014 a pre-existing backlog is left untouched, and nothing happens until the threshold has elapsed since install.",
      default: "2"
    },
    archivePinned: {
      type: "boolean",
      label: "Archive pinned threads",
      description: "Also archive pinned threads that meet the inactivity threshold.",
      default: false
    },
    archiveHidden: {
      type: "boolean",
      label: "Archive hidden threads",
      description: "Also archive hidden background-worker threads. Off by default \u2014 their owners manage their lifecycle.",
      default: false
    },
    archiveRunning: {
      type: "boolean",
      label: "Archive threads with work in flight",
      description: "Also archive threads that are starting, active, or stopping. Archiving stops running work, so this is off by default.",
      default: false
    },
    dryRun: {
      type: "boolean",
      label: "Dry run",
      description: "Report what would be archived without archiving anything.",
      default: false
    }
  });
  async function resolveConfig() {
    const values = await settings.get();
    const installedAt = await ensureInstalledAt(bb);
    return {
      inactivityDays: parseInactivityDays(values.inactivityDays),
      archivePinned: values.archivePinned,
      archiveHidden: values.archiveHidden,
      archiveRunning: values.archiveRunning,
      dryRun: values.dryRun,
      sinceInstallAt: installedAt
    };
  }
  bb.background.service("sweeper", {
    async start(signal) {
      while (!signal.aborted) {
        const config = await resolveConfig();
        try {
          const stats = await runSweep(bb, config, { signal });
          bb.log.info(
            `sweep complete \u2014 scanned ${stats.scanned}, archived ${stats.archived}, errors ${stats.errors}${stats.dryRun ? " (dry run)" : ""}`
          );
        } catch (error) {
          bb.log.error(`sweep failed: ${errorMessage(error)}`);
        }
        await sleep(msUntilNextHour(), signal);
      }
    }
  });
  bb.cli.register({
    name: "auto-archive",
    summary: "Auto-archive threads with no recent activity",
    commands: [
      {
        name: "run",
        summary: "Run an archive sweep now",
        usage: "bb auto-archive run [--dry-run]"
      },
      {
        name: "status",
        summary: "Show the last sweep result and current configuration",
        usage: "bb auto-archive status"
      }
    ],
    async run(argv, ctx) {
      const [sub, ...rest] = argv;
      if (sub === "run") {
        const config = await resolveConfig();
        const stats = await runSweep(
          bb,
          {
            ...config,
            dryRun: rest.includes("--dry-run") ? true : config.dryRun
          },
          { signal: ctx.signal }
        );
        return {
          exitCode: 0,
          stdout: formatStats(stats)
        };
      }
      if (sub === "status") {
        const config = await resolveConfig();
        const last = await bb.storage.kv.get("last-sweep");
        const lines = [
          `threshold: ${config.inactivityDays} day(s)`,
          `archive pinned: ${config.archivePinned}`,
          `archive hidden: ${config.archiveHidden}`,
          `archive running: ${config.archiveRunning}`,
          `dry run: ${config.dryRun}`,
          `installed: ${new Date(config.sinceInstallAt).toISOString()}`
        ];
        if (last) {
          lines.push(
            `last sweep: ${new Date(last.at).toISOString()}`,
            formatStats(last)
          );
        } else {
          lines.push("last sweep: never");
        }
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      return {
        exitCode: 2,
        stderr: "usage: bb auto-archive <run|status>"
      };
    }
  });
}
function formatStats(stats) {
  const suffix = stats.dryRun ? " (dry run)" : "";
  return `scanned ${stats.scanned}, candidates ${stats.candidates}, archived ${stats.archived}, errors ${stats.errors}${suffix}`;
}
var INSTALLED_AT_KEY = "installed-at";
async function ensureInstalledAt(bb) {
  const existing = await bb.storage.kv.get(INSTALLED_AT_KEY);
  if (typeof existing === "number") {
    return existing;
  }
  const now = Date.now();
  await bb.storage.kv.set(INSTALLED_AT_KEY, now);
  bb.log.info(
    `first run \u2014 recording install time ${new Date(now).toISOString()}; threads that were already idle before install will never be auto-archived`
  );
  return now;
}
export {
  plugin as default,
  runSweep,
  threadTitle
};
//# sourceMappingURL=server.js.map
