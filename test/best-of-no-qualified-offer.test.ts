import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const DAYS_PAST_EVERY_CONFIRMATION = 100;

const offers: { verifiedDate?: string }[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

function dayPastEveryConfirmation(): string {
  const today = new Date().toISOString().slice(0, 10);
  const newest = offers.map(o => o.verifiedDate ?? "").reduce((a, b) => (b > a ? b : a), today);
  return new Date(Date.parse(`${newest}T00:00:00Z`) + DAYS_PAST_EVERY_CONFIRMATION * 86_400_000).toISOString().slice(0, 10);
}

function startServer(atDay?: string): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const args = atDay ? ["--import", path.join(REPO, "scripts", "shifted-clock.mjs")] : [];
    const child = spawn("node", [...args, path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost",
        TZ: "UTC",
        ...(atDay ? { AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(`${atDay}T12:00:00Z`) - Date.now()) } : {}),
      },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 90000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function get(port: number, route: string): Promise<{ status: number; html: string }> {
  const res = await fetch(`http://localhost:${port}${route}`, { redirect: "manual" });
  return { status: res.status, html: await res.text() };
}

async function bestOfPaths(port: number): Promise<string[]> {
  const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]!.replace(/^https?:\/\/[^/]+/, ""));
  const paths: string[] = [];
  for (const child of locs((await get(port, "/sitemap.xml")).html)) {
    paths.push(...locs((await get(port, child)).html).filter(p => p.startsWith("/best/")));
  }
  return [...new Set(paths)].sort();
}

function tieNote(html: string): string {
  const inner = /<div class="tie-note">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  return inner.replace(/<[^>]+>/g, " ").replace(/&mdash;/g, "—").replace(/\s+/g, " ").trim();
}

function demotedCards(html: string): string[] {
  return html
    .split(/(?=<div class="best-pick(?: best-pick-demoted)?">)/)
    .filter(card => card.startsWith('<div class="best-pick best-pick-demoted">'))
    .map(card => card.split(/<h2\b/)[0]!);
}

let today: { child: ChildProcess; port: number };
let ahead: { child: ChildProcess; port: number };
let todayPaths: string[] = [];
let aheadPaths: string[] = [];
const aheadPages = new Map<string, { status: number; html: string }>();

before(async () => {
  [today, ahead] = await Promise.all([startServer(), startServer(dayPastEveryConfirmation())]);
  [todayPaths, aheadPaths] = await Promise.all([bestOfPaths(today.port), bestOfPaths(ahead.port)]);
  for (const route of aheadPaths) aheadPages.set(route, await get(ahead.port, route));
});

after(() => {
  today?.child.kill();
  ahead?.child.kill();
});

describe("a best-of page that no offer qualifies for, read when every confirmation we hold is past the window", () => {
  it("says no offer meets its criteria, and describes no order for a list it does not show", () => {
    const wrong: string[] = [];
    for (const [route, page] of aheadPages) {
      const note = tieNote(page.html);
      if (!/^No offer meets our criteria (?:for this category|on this page|here) today\. There is no durability split to publish\.$/.test(note)) {
        wrong.push(`${route}: ${note.slice(0, 200)}`);
      }
    }
    assert.deepStrictEqual(wrong, [], `pages that do not state an empty verdict alone:\n${wrong.join("\n")}`);
    assertPopulationFloor(aheadPages.size, 50, "best-of pages read with no offer qualifying");
  });

  it("keeps its demoted band, and names the reason on every demoted offer", () => {
    const unexplained: string[] = [];
    let withDemoted = 0;
    for (const [route, page] of aheadPages) {
      const cards = demotedCards(page.html);
      if (cards.length === 0) continue;
      withDemoted++;
      if (!page.html.includes("Demoted &mdash; and exactly why")) unexplained.push(`${route} lists demoted offers under no heading`);
      cards.forEach((card, at) => {
        if (!card.includes('class="demerit-code"')) unexplained.push(`${route} demoted card ${at + 1} names no reason`);
      });
    }
    assert.deepStrictEqual(unexplained, [], unexplained.join("\n"));
    assertPopulationFloor(withDemoted, 50, "best-of pages keeping a demoted band with no offer qualifying");
  });

  it("keeps its address and its sitemap entry", () => {
    assert.deepStrictEqual(aheadPaths, todayPaths, "the sitemap's best-of paths changed when no offer qualified");
    const missing = [...aheadPages].filter(([, page]) => page.status !== 200).map(([route, page]) => `${route} answers ${page.status}`);
    assert.deepStrictEqual(missing, []);
  });
});
