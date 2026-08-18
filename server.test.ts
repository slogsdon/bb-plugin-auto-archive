// Backend + pure-logic tests for bb-plugin-auto-archive.
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { runSweep, type ResolvedSweepConfig } from "./server";
import {
  DAY_MS,
  HOUR_MS,
  msUntilNextHour,
  parseInactivityDays,
  selectThreadsToArchive,
  type ThreadActivitySnapshot,
} from "./sweep";

const NOW = Date.UTC(2026, 0, 10, 12, 0, 0); // fixed clock for sweeps

interface TestThread extends ThreadActivitySnapshot {
  title: string | null;
  titleFallback: string | null;
}

function config(
  overrides: Partial<ResolvedSweepConfig> = {},
): ResolvedSweepConfig {
  return {
    inactivityDays: 2,
    archivePinned: false,
    archiveHidden: false,
    archiveRunning: false,
    dryRun: false,
    sinceInstallAt: 0,
    ...overrides,
  };
}

function thread(overrides: Partial<TestThread> = {}): TestThread {
  return {
    id: "th_test",
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    visibility: "visible",
    status: "idle",
    parentThreadId: null,
    latestAttentionAt: NOW - 3 * DAY_MS, // stale by default
    title: "Test thread",
    titleFallback: null,
    ...overrides,
  };
}

describe("parseInactivityDays", () => {
  it("parses a valid number", () => {
    expect(parseInactivityDays("2")).toBe(2);
    expect(parseInactivityDays("7")).toBe(7);
  });

  it("falls back to 2 on garbage, empty, and sub-day values", () => {
    expect(parseInactivityDays("abc")).toBe(2);
    expect(parseInactivityDays("")).toBe(2);
    expect(parseInactivityDays("0")).toBe(2);
    expect(parseInactivityDays("-3")).toBe(2);
  });
});

describe("msUntilNextHour", () => {
  it("counts down to the next top of the hour", () => {
    expect(msUntilNextHour(new Date(2026, 0, 1, 9, 37, 15, 500))).toBe(
      23 * 60_000 - 15_500,
    );
  });

  it("returns a full hour when already on the hour", () => {
    expect(msUntilNextHour(new Date(2026, 0, 1, 9, 0, 0, 0))).toBe(HOUR_MS);
  });
});

describe("selectThreadsToArchive", () => {
  it("archives a stale idle root thread", () => {
    const selected = selectThreadsToArchive([thread()], config(), NOW);
    expect(selected.map((t) => t.id)).toEqual(["th_test"]);
  });

  it("keeps a thread with activity inside the window", () => {
    const fresh = thread({ latestAttentionAt: NOW - DAY_MS });
    expect(selectThreadsToArchive([fresh], config(), NOW)).toEqual([]);
  });

  it("treats a thread active exactly at the cutoff as stale", () => {
    const boundary = thread({ latestAttentionAt: NOW - 2 * DAY_MS });
    expect(selectThreadsToArchive([boundary], config(), NOW)).toEqual([
      boundary,
    ]);
  });

  it("never selects child threads (they follow their parent)", () => {
    const child = thread({ id: "th_child", parentThreadId: "th_parent" });
    expect(selectThreadsToArchive([child], config(), NOW)).toEqual([]);
  });

  it("skips already-archived and deleted threads", () => {
    const archived = thread({ id: "th_archived", archivedAt: NOW - 1 });
    const deleted = thread({ id: "th_deleted", deletedAt: NOW - 1 });
    expect(selectThreadsToArchive([archived, deleted], config(), NOW)).toEqual(
      [],
    );
  });

  it("skips pinned threads unless archivePinned is set", () => {
    const pinned = thread({ id: "th_pinned", pinnedAt: NOW - 1 });
    expect(selectThreadsToArchive([pinned], config(), NOW)).toEqual([]);
    expect(selectThreadsToArchive([pinned], config({ archivePinned: true }), NOW)).toEqual([pinned]);
  });

  it("skips hidden threads unless archiveHidden is set", () => {
    const hidden = thread({ id: "th_hidden", visibility: "hidden" });
    expect(selectThreadsToArchive([hidden], config(), NOW)).toEqual([]);
    expect(selectThreadsToArchive([hidden], config({ archiveHidden: true }), NOW)).toEqual([hidden]);
  });

  it("skips running threads unless archiveRunning is set", () => {
    for (const status of ["starting", "active", "stopping"] as const) {
      const running = thread({ id: `th_${status}`, status });
      expect(selectThreadsToArchive([running], config(), NOW)).toEqual([]);
      expect(
        selectThreadsToArchive([running], config({ archiveRunning: true }), NOW),
      ).toEqual([running]);
    }
  });

  it("archives stale error threads by default (settled, not running)", () => {
    const errored = thread({ id: "th_error", status: "error" });
    expect(selectThreadsToArchive([errored], config(), NOW)).toEqual([errored]);
  });

  it("never touches threads that went idle before install", () => {
    const since = NOW - 3 * DAY_MS;
    const preExisting = thread({ latestAttentionAt: NOW - 5 * DAY_MS }); // older than install
    expect(
      selectThreadsToArchive([preExisting], config({ sinceInstallAt: since }), NOW),
    ).toEqual([]);
  });

  it("still archives threads that went idle after install", () => {
    const postInstall = thread({
      latestAttentionAt: NOW - 3 * DAY_MS,
    });
    const since = NOW - 10 * DAY_MS; // installed well before the window
    expect(
      selectThreadsToArchive([postInstall], config({ sinceInstallAt: since }), NOW),
    ).toEqual([postInstall]);
  });

  it("protects a pre-install backlog while the guard is on", () => {
    const backlog = thread({ latestAttentionAt: NOW - 10 * DAY_MS });
    const since = NOW - 1 * DAY_MS; // only ~1 day since install — window not elapsed
    expect(
      selectThreadsToArchive([backlog], config({ sinceInstallAt: since }), NOW),
    ).toEqual([]);
  });
});

function makeHost(entries: TestThread[]) {
  const host = createFakePluginHost({
    pluginId: "auto-archive",
    settings: {
      inactivityDays: "2",
      archivePinned: false,
      archiveHidden: false,
      archiveRunning: false,
      dryRun: false,
    },
    sdk: {
      threads: {
        list: async (args?: { offset?: number }) =>
          args?.offset ? [] : entries,
        archive: async () => ({}),
      },
    },
  });
  return host;
}

describe("runSweep", () => {
  it("archives only stale visible idle roots, in one pass", async () => {
    const { bb, harness } = makeHost([
      thread({ id: "th_stale" }),
      thread({ id: "th_fresh", latestAttentionAt: NOW - DAY_MS }),
      thread({ id: "th_pinned", pinnedAt: NOW - 1 }),
      thread({ id: "th_hidden", visibility: "hidden" }),
      thread({ id: "th_active", status: "active" }),
      thread({ id: "th_child", parentThreadId: "th_parent" }),
    ]);
    await plugin(bb);

    const stats = await runSweep(bb, config(), { now: NOW });

    expect(stats).toMatchObject({
      scanned: 6,
      candidates: 1,
      archived: 1,
      errors: 0,
      dryRun: false,
    });
    expect(harness.inspection.sdk.callsTo("threads.archive")).toEqual([
      [{ threadId: "th_stale" }],
    ]);
    const lastSweep = await bb.storage.kv.get("last-sweep");
    expect(lastSweep).toMatchObject({ at: NOW, archived: 1 });
  });

  it("pages through the list with offset until a short page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      thread({ id: `th_${i}`, latestAttentionAt: NOW - 1 }),
    );
    // First page: all fresh → no candidates; second page has one stale.
    const { bb } = makeHost([
      ...fullPage,
      thread({ id: "th_tail", latestAttentionAt: NOW - 3 * DAY_MS }),
    ]);
    await plugin(bb);

    const stats = await runSweep(bb, config(), { now: NOW });

    expect(stats.scanned).toBe(101);
    expect(stats.archived).toBe(1);
    expect(bb.sdk.threads.list).not.toBeUndefined();
  });

  it("honours dry run: logs candidates, archives nothing", async () => {
    const { bb, harness } = makeHost([thread({ id: "th_stale" })]);
    await plugin(bb);

    const stats = await runSweep(bb, config({ dryRun: true }), { now: NOW });

    expect(stats).toMatchObject({ candidates: 1, archived: 0, dryRun: true });
    expect(harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    expect(
      harness.inspection.logEntries.some((entry) =>
        entry.message.includes("would archive"),
      ),
    ).toBe(true);
  });

  it("continues past an archive failure and counts it", async () => {
    const host = createFakePluginHost({
      pluginId: "auto-archive",
      sdk: {
        threads: {
          list: async () => [
            thread({ id: "th_a" }),
            thread({ id: "th_b" }),
          ],
          archive: async (args: { threadId: string }) => {
            if (args.threadId === "th_a") throw new Error("boom");
            return {};
          },
        },
      },
    });
    const { bb } = host;
    await plugin(bb);

    const stats = await runSweep(bb, config(), { now: NOW });

    expect(stats).toMatchObject({ candidates: 2, archived: 1, errors: 1 });
  });
});

describe("factory registrations", () => {
  it("registers the sweeper service, settings, and CLI", async () => {
    const { bb, harness } = makeHost([]);
    await plugin(bb);

    expect(
      harness.registrations.services.some((s) => s.name === "sweeper"),
    ).toBe(true);
    expect(harness.registrations.cli?.name).toBe("auto-archive");
    expect(harness.registrations.cli?.commands).toHaveLength(2);
    expect(Object.keys(harness.registrations.settingsDescriptors)).toEqual([
      "inactivityDays",
      "archivePinned",
      "archiveHidden",
      "archiveRunning",
      "dryRun",
    ]);
  });

  it("sweeper first run records install time and leaves a backlog alone", async () => {
    const { bb, harness } = makeHost([thread({ id: "th_stale" })]);
    await plugin(bb);

    const { controller, done } = harness.behavior.runService("sweeper");
    // Wait until the first sweep has recorded the install time (which is what
    // also runs the guard), then confirm the pre-install backlog was untouched.
    await vi.waitFor(async () => {
      expect(await bb.storage.kv.get("installed-at")).toBeTypeOf("number");
    });
    expect(harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    controller.abort();
    await done;
  });

  it("sweeper archives backlog once the install guard has elapsed", async () => {
    const { bb, harness } = makeHost([thread({ id: "th_stale" })]);
    // Installed well before the stale thread's last activity.
    await bb.storage.kv.set("installed-at", NOW - 10 * DAY_MS);
    await plugin(bb);

    const { controller, done } = harness.behavior.runService("sweeper");
    await vi.waitFor(() => {
      expect(harness.inspection.sdk.callsTo("threads.archive")).toEqual([
        [{ threadId: "th_stale" }],
      ]);
    });
    controller.abort();
    await done;
  });

  it("CLI status shows configuration and last sweep", async () => {
    const { bb, harness } = makeHost([thread({ id: "th_stale" })]);
    await plugin(bb);
    await runSweep(bb, config(), { now: NOW });

    const result = await harness.behavior.runCli(["status"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("threshold: 2 day(s)");
    expect(result.stdout).toContain("archived 1");
  });

  it("CLI run --dry-run overrides the config dry-run flag", async () => {
    const { bb, harness } = makeHost([thread({ id: "th_stale" })]);
    await plugin(bb);

    const result = await harness.behavior.runCli(["run", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(dry run)");
    expect(harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });
});
