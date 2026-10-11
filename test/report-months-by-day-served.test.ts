import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const MID_OCTOBER = "2026-10-11T12:00:00Z";
const LAST_DAY_OF_OCTOBER = "2026-10-31T12:00:00Z";
const FIRST_DAY_OF_NOVEMBER = "2026-11-01T00:30:00Z";

const TIED_MONTH = "2026-08";
const UNTIED_CUT_MONTH = "2026-07";
const PAST_MONTH = "2026-09";
const OCTOBER = "2026-10";
const NOVEMBER = "2026-11";
const DECEMBER = "2026-12";

function record(vendor: string, changeType: string, date: string) {
  return {
    vendor,
    change_type: changeType,
    date,
    date_source: "vendor_page",
    summary: `${vendor} made a ${changeType.replace(/_/g, " ")} change dated ${date}.`,
    previous_state: `${vendor} before ${date}.`,
    current_state: `${vendor} from ${date}.`,
    impact: "medium",
    source_url: `https://example.com/${vendor.toLowerCase().replace(/\W+/g, "-")}`,
    category: "AI / ML",
    alternatives: [],
    recorded_date: "2026-06-01",
    listing_effect: "none",
  };
}

const numbered = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix} ${String(i + 1).padStart(2, "0")}`);

const CHANGE_LOG = {
  changes: [
    ...numbered("Cut Vendor", 10).flatMap((vendor) => [record(vendor, "free_tier_removed", "2026-07-03"), record(vendor, "limits_reduced", "2026-07-04")]),
    ...numbered("Below The Cut Vendor", 2).map((vendor) => record(vendor, "free_tier_removed", "2026-07-05")),
    record("Twice Vendor", "free_tier_removed", "2026-08-03"),
    record("Twice Vendor", "limits_reduced", "2026-08-04"),
    ...numbered("Tied Loser", 12).map((vendor) => record(vendor, "free_tier_removed", "2026-08-05")),
    ...numbered("Tied Winner", 11).map((vendor) => record(vendor, "limits_increased", "2026-08-06")),
    record("Past Loser", "free_tier_removed", "2026-09-10"),
    record("Removed Early Vendor", "free_tier_removed", "2026-10-05"),
    record("Limits Up Vendor", "limits_increased", "2026-10-08"),
    record("Shutdown Late Vendor", "product_deprecated", "2026-10-23"),
    record("Removed Late Vendor", "free_tier_removed", "2026-10-31"),
    record("November Shutdown Two", "product_deprecated", "2026-11-30"),
    record("November Shutdown One", "product_deprecated", "2026-11-17"),
    record("December Shutdown", "product_deprecated", "2026-12-11"),
  ],
};

function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["--import", path.join(REPO, "scripts", "shifted-clock.mjs"), path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${match[1]}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function servingAt(changesPath: string, instant: string): Record<string, string> {
  return { AGENTDEALS_CHANGES_PATH: changesPath, AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(instant) - Date.now()) };
}

interface ReportPage {
  html: string;
  metaDescription: string;
  lineUnderTheHeading: string;
  statCards: string[];
  headings: string[];
  losers: string[];
  winners: string[];
  scheduled: string[];
}

function vendorsUnder(html: string, heading: string): string[] {
  const start = html.indexOf(`<h2>${heading}</h2>`);
  if (start < 0) return [];
  const next = html.indexOf("<h2>", start + heading.length + 9);
  const section = html.slice(start, next < 0 ? html.indexOf('<div class="report-nav">', start) : next);
  return [...section.matchAll(/<li><strong>([^<]*)<\/strong> \(([^)<]*)/g)].map(([, vendor, after]) => (heading === "Scheduled" ? `${vendor} (${after})` : vendor));
}

function readReport(html: string): ReportPage {
  return {
    html,
    metaDescription: html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "",
    lineUnderTheHeading: html.match(/<div class="editorial">([^<]*)<\/div>/)?.[1] ?? "",
    statCards: [...html.matchAll(/<div class="stat-value[^"]*">(\d+)<\/div><div class="stat-label">([A-Za-z ]+)/g)].map(([, n, label]) => `${n} ${label.trim()}`),
    headings: [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map(([, heading]) => heading),
    losers: vendorsUnder(html, "Biggest Losers"),
    winners: vendorsUnder(html, "Biggest Winners"),
    scheduled: vendorsUnder(html, "Scheduled"),
  };
}

interface ReportCard {
  badge: string;
  stats: string;
}

function readCards(html: string): Map<string, ReportCard> {
  const cards = new Map<string, ReportCard>();
  for (const [, month, card] of html.matchAll(/<a href="\/reports\/(\d{4}-\d{2})" class="report-card">([\s\S]*?)<\/a>/g)) {
    cards.set(month, {
      badge: card.match(/<span class="report-badge [^"]*">([^<]*)<\/span>/)?.[1] ?? "",
      stats: [...card.matchAll(/<span class="stat-[a-z]+">([^<]*)<\/span>/g)].map(([, stat]) => stat).join(", "),
    });
  }
  return cards;
}

const MONTHS = [UNTIED_CUT_MONTH, TIED_MONTH, PAST_MONTH, OCTOBER, NOVEMBER, DECEMBER];
const reports = new Map<string, Map<string, ReportPage>>();
const cards = new Map<string, Map<string, ReportCard>>();
const monthsServedToday = new Map<string, ReportPage>();
let today = "";
const servers: ChildProcess[] = [];
let scratch = "";

before(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "report-months-"));
  const changesPath = path.join(scratch, "deal_changes.json");
  writeFileSync(changesPath, JSON.stringify(CHANGE_LOG, null, 2));
  for (const instant of [MID_OCTOBER, LAST_DAY_OF_OCTOBER, FIRST_DAY_OF_NOVEMBER]) {
    const { proc, base } = await startServer(servingAt(changesPath, instant));
    servers.push(proc);
    const served = new Map<string, ReportPage>();
    for (const month of MONTHS) {
      const res = await fetch(`${base}/reports/${month}`);
      assert.strictEqual(res.status, 200, `/reports/${month} at ${instant}`);
      served.set(month, readReport(await res.text()));
    }
    reports.set(instant, served);
    cards.set(instant, readCards(await (await fetch(`${base}/reports`)).text()));
  }
  const { proc, base } = await startServer({});
  servers.push(proc);
  today = new Date().toISOString().slice(0, 10);
  const index = await (await fetch(`${base}/reports`)).text();
  for (const [route] of index.matchAll(/\/reports\/\d{4}-\d{2}/g)) {
    if (monthsServedToday.has(route)) continue;
    const res = await fetch(base + route);
    assert.strictEqual(res.status, 200, route);
    monthsServedToday.set(route, readReport(await res.text()));
  }
});

after(() => {
  for (const proc of servers) proc.kill();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const report = (instant: string, month: string) => reports.get(instant)!.get(month)!;
const card = (instant: string, month: string) => cards.get(instant)!.get(month)!;

describe("a monthly report for a month that has not started", () => {
  it("says the month has not started, how many changes are scheduled, and that each service still works until its date", () => {
    for (const instant of [MID_OCTOBER, LAST_DAY_OF_OCTOBER]) {
      assert.strictEqual(
        report(instant, NOVEMBER).lineUnderTheHeading,
        "November 2026 has not started. 2 changes are scheduled; each service below still works until its date.",
        instant,
      );
    }
  });

  it("says the same of a single scheduled change in the singular", () => {
    assert.strictEqual(
      report(MID_OCTOBER, DECEMBER).lineUnderTheHeading,
      "December 2026 has not started. 1 change is scheduled; the service below still works until its date.",
    );
  });

  it("describes its changes as scheduled, not tracked, for the days the month covers in the meta description", () => {
    assert.ok(report(MID_OCTOBER, NOVEMBER).metaDescription.startsWith("2 pricing changes scheduled for November 1\u201330, 2026 "), report(MID_OCTOBER, NOVEMBER).metaDescription);
    assert.ok(report(MID_OCTOBER, DECEMBER).metaDescription.startsWith("1 pricing changes scheduled for December 1\u201331, 2026 "), report(MID_OCTOBER, DECEMBER).metaDescription);
  });

  it("counts its changes as scheduled, with no month-on-month deltas and no section but Scheduled", () => {
    const november = report(MID_OCTOBER, NOVEMBER);
    assert.deepStrictEqual(november.statCards, ["2 Scheduled"]);
    assert.ok(!november.html.includes("vs last month"), "a month that has not started is compared with the month before it");
    assert.deepStrictEqual(november.headings, ["Scheduled"]);
  });

  it("lists each scheduled change under Scheduled with its date, soonest first", () => {
    assert.deepStrictEqual(report(MID_OCTOBER, NOVEMBER).scheduled, [
      "November Shutdown One (effective 2026-11-17)",
      "November Shutdown Two (effective 2026-11-30)",
    ]);
  });

  it("is badged Scheduled on /reports and counts its changes as scheduled there", () => {
    assert.deepStrictEqual(card(MID_OCTOBER, NOVEMBER), { badge: "Scheduled", stats: "2 scheduled" });
    assert.deepStrictEqual(card(MID_OCTOBER, DECEMBER), { badge: "Scheduled", stats: "1 scheduled" });
  });
});

describe("the monthly report for the month under way", () => {
  it("says how many changes the month has had through the day served and how many more are scheduled, never that the month was", () => {
    assert.strictEqual(
      report(MID_OCTOBER, OCTOBER).lineUnderTheHeading,
      "October 2026 so far: 2 changes through October 11. 2 more are scheduled before the month ends.",
    );
  });

  it("says in its meta description that its count is so far, through the day served, and how many more are scheduled for later in the month", () => {
    assert.strictEqual(
      report(MID_OCTOBER, OCTOBER).metaDescription,
      "2 pricing changes so far in October 2026 (through 2026-10-11), and 2 scheduled for later in the month \u2014 free tier removals, new additions, and trend analysis for developer tools.",
    );
    assert.ok(report(FIRST_DAY_OF_NOVEMBER, NOVEMBER).metaDescription.startsWith("0 pricing changes so far in November 2026 (through 2026-11-01), and 2 scheduled for later in the month \u2014 "), report(FIRST_DAY_OF_NOVEMBER, NOVEMBER).metaDescription);
  });

  it("drops the scheduled clause from its meta description once none is left, and says tracked in the month once it has ended", () => {
    assert.ok(report(LAST_DAY_OF_OCTOBER, OCTOBER).metaDescription.startsWith("4 pricing changes so far in October 2026 (through 2026-10-31) \u2014 "), report(LAST_DAY_OF_OCTOBER, OCTOBER).metaDescription);
    assert.ok(report(FIRST_DAY_OF_NOVEMBER, OCTOBER).metaDescription.startsWith("4 pricing changes tracked in October 2026 "), report(FIRST_DAY_OF_NOVEMBER, OCTOBER).metaDescription);
  });

  it("drops the sentence about scheduled changes once none is left", () => {
    assert.strictEqual(report(LAST_DAY_OF_OCTOBER, OCTOBER).lineUnderTheHeading, "October 2026 so far: 4 changes through October 31.");
  });

  it("counts only the changes dated on or before the day served in its totals", () => {
    assert.deepStrictEqual(report(MID_OCTOBER, OCTOBER).statCards, ["2 Total Changes", "1 Negative", "1 Positive", "0 Neutral"]);
    assert.deepStrictEqual(report(LAST_DAY_OF_OCTOBER, OCTOBER).statCards, ["4 Total Changes", "2 Negative", "1 Positive", "1 Neutral"]);
    assert.deepStrictEqual(card(MID_OCTOBER, OCTOBER).stats, "2 changes, 1 negative, 1 positive");
  });

  it("keeps a loss out of Biggest Losers until its date, and names it from that day", () => {
    assert.deepStrictEqual(report(MID_OCTOBER, OCTOBER).losers, ["Removed Early Vendor"]);
    assert.deepStrictEqual(report(LAST_DAY_OF_OCTOBER, OCTOBER).losers, ["Removed Early Vendor", "Removed Late Vendor"]);
  });

  it("lists the changes dated after the day served under Scheduled with their dates, and none once every date has come", () => {
    assert.deepStrictEqual(report(MID_OCTOBER, OCTOBER).scheduled, [
      "Shutdown Late Vendor (effective 2026-10-23)",
      "Removed Late Vendor (effective 2026-10-31)",
    ]);
    assert.deepStrictEqual(report(LAST_DAY_OF_OCTOBER, OCTOBER).scheduled, []);
  });

  it("starts a month on its first day with nothing in effect yet, no section but Scheduled, and every change still scheduled", () => {
    const november = report(FIRST_DAY_OF_NOVEMBER, NOVEMBER);
    assert.strictEqual(november.lineUnderTheHeading, "November 2026 so far: 0 changes through November 1. 2 more are scheduled before the month ends.");
    assert.deepStrictEqual(november.headings, ["Scheduled"]);
    assert.strictEqual(november.scheduled.length, 2);
  });
});

describe("the monthly report for a month that has ended", () => {
  it("returns to the trend sentence and counts every change once the month is over", () => {
    const october = report(FIRST_DAY_OF_NOVEMBER, OCTOBER);
    assert.ok(!october.lineUnderTheHeading.includes("so far"), october.lineUnderTheHeading);
    assert.ok(october.lineUnderTheHeading.startsWith("October 2026 "), october.lineUnderTheHeading);
    assert.deepStrictEqual(october.statCards.slice(0, 1), ["4 Total Changes"]);
    assert.deepStrictEqual(october.scheduled, []);
  });

  it("serves the same page on every day after it", () => {
    assert.strictEqual(report(MID_OCTOBER, PAST_MONTH).html, report(FIRST_DAY_OF_NOVEMBER, PAST_MONTH).html);
    assert.strictEqual(report(MID_OCTOBER, PAST_MONTH).html, report(LAST_DAY_OF_OCTOBER, PAST_MONTH).html);
  });
});

describe("Biggest Losers and Biggest Winners keep every vendor tied at the cut", () => {
  it("lists every vendor tied with the tenth", () => {
    const tied = report(MID_OCTOBER, TIED_MONTH);
    assert.deepStrictEqual(tied.losers, ["Twice Vendor", ...numbered("Tied Loser", 12)]);
    assert.deepStrictEqual(tied.winners, numbered("Tied Winner", 11));
  });

  it("still stops at ten where the tenth and eleventh are not tied", () => {
    assert.deepStrictEqual(report(MID_OCTOBER, UNTIED_CUT_MONTH).losers, numbered("Cut Vendor", 10));
  });
});

describe("every monthly report served today", () => {
  it("says a month has not started exactly while its first day is after the day served", () => {
    assert.ok(monthsServedToday.size > 0, "/reports links no monthly report");
    const wrong = [...monthsServedToday]
      .filter(([route, page]) => page.lineUnderTheHeading.includes(" has not started. ") !== `${route.slice("/reports/".length)}-01` > today)
      .map(([route, page]) => `${route}: ${page.lineUnderTheHeading}`);
    assert.deepStrictEqual(wrong, []);
  });

  it("says a month was something only once it has ended", () => {
    const wrong = [...monthsServedToday]
      .filter(([route, page]) => / was /.test(page.lineUnderTheHeading) && route.slice("/reports/".length) >= today.slice(0, 7))
      .map(([route, page]) => `${route}: ${page.lineUnderTheHeading}`);
    assert.deepStrictEqual(wrong, []);
  });
});
