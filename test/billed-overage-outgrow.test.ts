import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { statesUsageBeyondTheFreeTierIsBilled, usageBeyondTheFreeTierBillingSentence, listingStatements } = await import("../dist/overage-billing.js");
const { toSlug } = await import("../dist/vendor-slug.js");

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const offers: Array<{ vendor: string; category: string; description: string; conditions?: Array<{ text: string }> }> =
  JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

const UPGRADE = /you(?:'|&#39;|\\u0027)ll need to upgrade/g;

const LISTINGS_THAT_BILL_USAGE_PAST_THE_FREE_TIER = [
  "Google Cloud Run", "Google Compute Engine", "Google Cloud Build", "Google Cloud BigQuery", "Google Cloud Storage",
  "Google Cloud Pub/Sub", "Google Artifact Registry", "Google Cloud Logging", "Google Secret Manager", "Google Cloud Monitoring",
  "Cloudflare R2", "Modal", "Parallel",
];

const LISTINGS_THAT_STOP_AT_A_HARD_LIMIT = ["Formspree", "Vercel", "Grafana Cloud"];

describe("reading whether a listing bills usage past its free tier", () => {
  it("reads each way a listing says the usage past its free tier is billed", () => {
    for (const sentence of [
      "Usage beyond the Free Tier's monthly limits is billed at standard rates.",
      "It includes 10k active series, with usage above that billed.",
      "Usage beyond the free tier is charged monthly to the payment method on file.",
      "Beyond the free allowance you pay $0.02 per GB.",
      "Pay-as-you-go beyond the included credit.",
      "Requests are charged at $1 per 1,000 beyond the free 5,000.",
    ]) {
      assert.ok(statesUsageBeyondTheFreeTierIsBilled([sentence]), sentence);
      assert.equal(usageBeyondTheFreeTierBillingSentence(["A free tier is available. " + sentence + " Terms apply."]), sentence);
    }
  });

  it("does not read a billed overage into a listing that stops, pauses or blocks at its limit", () => {
    const billed = "Usage beyond the free tier is billed at standard rates.";
    for (const stops of [
      "Processing stops at the limit.",
      "When monthly free credits are used up, requests stop until credits reset.",
      "Reaching a usage limit pauses the service until the limit is changed.",
      "Once the quota is exhausted, requests are blocked.",
    ]) {
      assert.ok(!statesUsageBeyondTheFreeTierIsBilled([billed, stops]), stops);
      assert.equal(usageBeyondTheFreeTierBillingSentence([billed, stops]), null, stops);
    }
  });

  it("reads nothing billed into a listing that only states its limits", () => {
    assert.ok(!statesUsageBeyondTheFreeTierIsBilled(["Free plan: 50 submissions a month, unlimited forms."]));
  });

  it("returns the first complete billing sentence, keeping decimal prices and leaving surrounding sentences behind", () => {
    const first = "Usage beyond the $30 is billed per second: T4 $0.000164 per second; H100 $0.001097 per second.";
    assert.equal(usageBeyondTheFreeTierBillingSentence(["Free compute is included. " + first + " Terms apply.", "Beyond the free allowance you pay $0.02 per GB."]), first);
    assert.equal(usageBeyondTheFreeTierBillingSentence(["Free allowance only."]), null);
    assert.equal(usageBeyondTheFreeTierBillingSentence(["  "]), null);
  });

  it("keeps a hard stop authoritative even when it precedes the billed sentence", () => {
    assert.equal(usageBeyondTheFreeTierBillingSentence(["Requests stop at the quota.", "Usage beyond the free tier is billed at standard rates."]), null);
  });

  it("distinguishes Grafana's Pro usage sentence from its Free plan", () => {
    const grafana = offers.find(offer => offer.vendor === "Grafana Cloud")!;
    assert.ok(grafana.description.includes("Pro costs $19 a month plus usage, includes 10k active series and 50 GB each of logs and traces, and bills usage above them."));
    assert.equal(usageBeyondTheFreeTierBillingSentence(listingStatements(grafana)), null);
  });

  it("finds every listing named in the census among the catalogue's, and neither listing that stops at a hard limit", () => {
    const billed = new Set(offers.filter((o) => statesUsageBeyondTheFreeTierIsBilled(listingStatements(o))).map((o) => o.vendor));
    for (const vendor of LISTINGS_THAT_BILL_USAGE_PAST_THE_FREE_TIER) assert.ok(billed.has(vendor), `${vendor} is not read as billing usage past its free tier`);
    for (const vendor of LISTINGS_THAT_STOP_AT_A_HARD_LIMIT) assert.ok(!billed.has(vendor), `${vendor} is read as billing usage past its free tier`);
  });
});

describe("a vendor page whose listing bills usage past the free tier", () => {
  let proc: ChildProcess | null = null;
  const pages = new Map<string, string>();
  const billedVendors = offers.filter((o) => statesUsageBeyondTheFreeTierIsBilled(listingStatements(o))).map((o) => o.vendor);

  before(async () => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    proc = child;
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    for (const vendor of [...new Set([...billedVendors, ...LISTINGS_THAT_STOP_AT_A_HARD_LIMIT])]) {
      const response = await fetch(`http://localhost:${port}/vendor/${toSlug(vendor)}`);
      assert.strictEqual(response.status, 200, `/vendor/${toSlug(vendor)} answered ${response.status}`);
      pages.set(vendor, await response.text());
    }
  });

  after(() => { if (proc) proc.kill(); });

  it("tells no reader they will need to upgrade, in the outgrow section, the FAQ or its structured data", () => {
    const telling = billedVendors.filter((vendor) => (pages.get(vendor)!.match(UPGRADE) ?? []).length > 0);
    assert.ok(billedVendors.length >= LISTINGS_THAT_BILL_USAGE_PAST_THE_FREE_TIER.length);
    assert.deepStrictEqual(telling, []);
  });

  it("still answers when the reader will outgrow the free tier, without opening on the list of alternatives", () => {
    for (const vendor of LISTINGS_THAT_BILL_USAGE_PAST_THE_FREE_TIER) {
      const answer = pages.get(vendor)!.match(/When will I outgrow [^<]*<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>/)?.[1];
      assert.ok(answer, `${vendor}'s page has no outgrow question`);
      const listing = offers.find(offer => offer.vendor === vendor)!;
      const sentence = usageBeyondTheFreeTierBillingSentence(listingStatements(listing))!;
      const plain = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
      const growth = pages.get(vendor)!.match(/<ul class="growth-list">([\s\S]*?)<\/ul>/)?.[1] ?? "";
      const bullets = [...growth.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, item]) => plain(item));
      assert.equal(bullets[0], sentence, vendor);
      assert.ok(plain(answer).startsWith(sentence), `${vendor}'s outgrow answer: ${answer}`);
      assert.doesNotMatch(answer, /evaluate paid plans/);
      const structured = [...pages.get(vendor)!.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map(([, json]) => JSON.parse(json)).find(item => item["@type"] === "FAQPage");
      const structuredAnswer = structured.mainEntity.find((item: { name: string }) => item.name.startsWith("When will I outgrow ")).acceptedAnswer.text;
      assert.equal(structuredAnswer, plain(answer), vendor);
      const count = pages.get(vendor)!.match(/compares against every one of the (\d+) we list/)?.[1];
      assert.equal(plain(answer), sentence + (count ? ` The ${count} alternatives in ${listing.category} are each listed above with the free tier they offer.` : ""));
      assert.ok(!answer.startsWith("At that point"), `${vendor}'s outgrow answer opens on the list of alternatives: ${answer}`);
    }
  });

  it("starts Cloud Run's outgrow list and both FAQ answers with its stated billing sentence", () => {
    const body = pages.get("Google Cloud Run")!;
    const sentence = "Usage beyond the Free Tier's monthly limits is billed at standard rates.";
    const firstBullet = body.match(/<ul class="growth-list">\s*<li>([^<]*)<\/li>/)?.[1] ?? "";
    assert.equal(firstBullet.replace(/&#39;/g, "'"), sentence);
    assert.ok(body.includes(`"text":"${sentence} The `));
  });

  it("keeps the upgrade sentence on a page whose listing stops at a hard limit", () => {
    for (const vendor of LISTINGS_THAT_STOP_AT_A_HARD_LIMIT) {
      assert.ok((pages.get(vendor)!.match(UPGRADE) ?? []).length >= 2, `${vendor} no longer says the reader will need to upgrade`);
    }
  });
});
