import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { serviceStopsAtItsLimitSentence } = await import("../dist/overage-billing.js");
const { toSlug } = await import("../dist/vendor-slug.js");
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const offers = JSON.parse(readFileSync(path.join(REPO, "data/index.json"), "utf8")).offers;
const statements: Record<string, string> = {
  "Cloudflare Workers": "Free includes 0.5 GB of ingestion per day and seven-day retention; ingestion stops at the daily limit and resumes at 00:00 UTC.",
  Mixpanel: "Pauses tracking when limit reached",
  Rollbar: "Processing stops at limit (no surprise charges)",
  Composio: "On the free Hobby plan, calls stop at the monthly limit and Composio does not charge overage.",
  Zep: "When the credits run out, Episodes stop processing until the next billing cycle and the account's rate limit drops to 5 requests a minute.",
  Kaggle: "Once Kaggle's weekly GPU quota is used, no more GPU time is available until the quota resets.",
  Formspree: "Forms keep working for visitors, but Formspree stops processing new submissions when the monthly limit is reached.",
  "Brave Search API": "Once the free $5 and any bought credits are used up, requests are rejected until funds are added.",
  "Tavily AI": "When monthly free credits are used up, requests stop until credits reset or the account upgrades.",
  Turso: "On the Free plan, or on a paid plan with Overages off, your databases are blocked once you exceed the limit on any single metric.",
};
const plain = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();

it("reads a free-limit stop from either a description or a condition, preserving the complete sentence", () => {
  for (const sentence of Object.values(statements)) {
    const punctuated = /[.!?]$/.test(sentence) ? sentence : sentence + ".";
    assert.equal(serviceStopsAtItsLimitSentence([`Other terms. ${punctuated} More terms.`]), punctuated);
    assert.equal(serviceStopsAtItsLimitSentence(["Other terms.", sentence]), sentence);
  }
  assert.equal(serviceStopsAtItsLimitSentence(["", "No free-limit rule."]), null);
  assert.equal(serviceStopsAtItsLimitSentence(["Requests stop at the quota.", statements.Kaggle]), "Requests stop at the quota.");
});

it("does not present inactivity or a paid-plan stop as the free-limit outcome", () => {
  for (const text of [
    "Free projects are paused after 1 week of inactivity, with a limit of 2 active projects.",
    "When usage credit runs out on Hobbyist, endpoints stop working until the end of the billing cycle, when the credit resets.",
    "On Chroma Cloud, reaching a usage limit pauses the service until the limit is changed.",
    "When the Prepay balance reaches $0, every API key stops working until credits are added.",
    "When the prepaid balance reaches zero, API access is suspended until credits are added.",
    "On a paid plan, requests stop at the limit.",
  ]) {
    assert.equal(serviceStopsAtItsLimitSentence([text]), null, text);
    assert.equal(serviceStopsAtItsLimitSentence([text, statements.Kaggle]), statements.Kaggle, text);
  }
});

describe("vendor guidance follows the stated free-limit rule", () => {
  let proc: ChildProcess;
  const pages = new Map<string, string>();
  before(async () => {
    proc = spawn("node", [path.join(REPO, "dist/serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 60000);
      proc.stderr!.on("data", data => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      proc.on("error", error => { clearTimeout(timer); reject(error); });
    });
    for (const vendor of Object.keys(statements)) {
      const response = await fetch(`http://localhost:${port}/vendor/${toSlug(vendor)}`);
      assert.equal(response.status, 200, vendor);
      pages.set(vendor, await response.text());
    }
  });
  after(() => { proc?.kill(); });

  for (const [vendor, sentence] of Object.entries(statements)) {
    it(`publishes ${vendor}'s rule in its outgrow list, visible FAQ and structured answer`, () => {
      const html = pages.get(vendor)!;
      const listing = offers.find((offer: { vendor: string }) => offer.vendor === vendor);
      const stored = [listing.description, ...(listing.conditions ?? []).map((c: { text: string }) => c.text)].join(" ");
      assert.ok(stored.includes(sentence), vendor);
      const growth = html.match(/<ul class="growth-list">([\s\S]*?)<\/ul>/)?.[1];
      assert.ok(growth, vendor);
      const bullets = [...growth.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, item]) => plain(item));
      assert.equal(bullets[0], sentence, vendor);
      assert.doesNotMatch(html, /you(?:'|&#39;)ll need to upgrade|evaluate paid plans/);
      const visible = html.match(/When will I outgrow [^<]*<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>/)?.[1];
      assert.ok(visible, vendor);
      const structured = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map(([, json]) => JSON.parse(json)).find(item => item["@type"] === "FAQPage");
      const answer = structured.mainEntity.find((item: { name: string }) => item.name.startsWith("When will I outgrow ")).acceptedAnswer.text;
      const count = html.match(/compares against every one of the (\d+) we list/)?.[1];
      assert.equal(plain(visible), sentence + (count ? ` The ${count} alternatives in ${listing.category} are each listed above with the free tier they offer.` : ""));
      assert.equal(answer, plain(visible));
    });
  }
});
