import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { parseMistralPrices } = await import("../dist/mistral-prices.js");

type MistralPrices = import("../src/mistral-prices.ts").MistralPrices;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = "/mistral-api-pricing-2026";
const DATA_FILE = path.join(REPO, "data", "mistral_api_prices.json");
const committed: MistralPrices = JSON.parse(readFileSync(DATA_FILE, "utf8"));

function startServer(env: Record<string, string> = {}, clockAt?: string): Promise<{ child: ChildProcess; base: string }> {
  const clockPreload = clockAt === undefined ? [] : ["--import", path.join(REPO, "scripts", "shifted-clock.mjs")];
  const clockShift: Record<string, string> = clockAt === undefined ? {} : { AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(clockAt) - Date.now()) };
  return new Promise((resolve, reject) => {
    const child = spawn("node", [...clockPreload, path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env, ...clockShift },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, base: `http://localhost:${m[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const decoded = (html: string) =>
  html.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const cellText = (html: string) => decoded(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

const prose = (html: string) =>
  decoded(html.replace(/<\/(?:td|th|p|h1|h2|li)>/g, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

const articleOf = (page: string) => {
  const start = page.indexOf('<article class="mistral-guide">');
  const end = page.indexOf("</article>");
  assert.ok(start > -1 && end > start, "the page holds its guide in one article");
  return page.slice(start, end);
};

const tableText = (page: string, tableClass: string) => {
  const table = articleOf(page).match(new RegExp(`<table class="pricing-table ${tableClass}">[\\s\\S]*?</table>`))?.[0] ?? "";
  assert.ok(table, `the page has no ${tableClass} table`);
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) => [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(([, inner]) => cellText(inner)));
};

const sectionsOf = (page: string) => {
  const article = articleOf(page);
  const headings = [...article.matchAll(/<h2>([\s\S]*?)<\/h2>/g)];
  return headings.map((heading, n) => ({
    heading: cellText(heading[1]),
    paragraphs: [...article.slice(heading.index!, headings[n + 1]?.index ?? article.length).matchAll(/<p class="section-intro">([\s\S]*?)<\/p>/g)].map(([, inner]) => cellText(inner)),
  }));
};

const priceTable = (prices: MistralPrices) => [
  prices.prices.columns,
  ...prices.prices.rows.map((row) => [row.model, `$${row.input}`, `$${row.cached_input}`, `$${row.output}`]),
];

const retirementTable = (prices: MistralPrices) => [
  prices.retirements.columns,
  ...prices.retirements.rows.map((row) => [row.model, row.retired, row.replacement]),
];

const otherNumbersParagraph = (prices: MistralPrices) =>
  [...prices.other_numbers.retired_terms.map((terms) => terms.text), prices.other_numbers.text].join(" ");

const FIGURE = /\d{4}-\d{2}-\d{2}|\$\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?%|\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?/g;

const PRICE_FIELDS = new Set(["input", "cached_input", "output"]);

function proseStrings(value: unknown, key = ""): string[] {
  if (typeof value === "string") return PRICE_FIELDS.has(key) ? [`$${value}`] : [value];
  if (Array.isArray(value)) return value.flatMap((item) => proseStrings(item, key));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([field, item]) => proseStrings(item, field));
  return [];
}

function figuresHeld(prices: MistralPrices): Set<string> {
  return new Set(proseStrings(prices).flatMap((text) => text.match(FIGURE) ?? []));
}

function servedFrom(dataFile: string | null) {
  const state = { page: "", status: 0, sitemap: "", guides: "", hub: "", llms: "", vendor: "" };
  let server: ChildProcess | null = null;
  before(async () => {
    const { child, base } = await startServer(dataFile ? { AGENTDEALS_MISTRAL_PRICES_PATH: dataFile } : {});
    server = child;
    const res = await fetch(`${base}${ROUTE}`);
    state.status = res.status;
    state.page = await res.text();
    state.sitemap = await (await fetch(`${base}/sitemap-pages.xml`)).text();
    state.guides = await (await fetch(`${base}/guides`)).text();
    state.hub = await (await fetch(`${base}/alternatives`)).text();
    state.llms = await (await fetch(`${base}/llms.txt`)).text();
    state.vendor = await (await fetch(`${base}/vendor/mistral-ai`)).text();
  });
  after(() => { if (server) server.kill(); });
  return state;
}

describe("the Mistral API pricing guide, built from data/mistral_api_prices.json", () => {
  const served = servedFrom(null);

  it("answers 200 with the title, meta description and lead the data file gives", () => {
    assert.strictEqual(served.status, 200);
    assert.ok(served.page.includes(`<title>${committed.title} — AgentDeals</title>`));
    const meta = decoded(served.page.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "");
    assert.strictEqual(meta, committed.meta_description);
    assert.strictEqual(cellText(articleOf(served.page).match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? ""), committed.title);
    assert.strictEqual(cellText(articleOf(served.page).match(/<\/h1>\s*<p class="section-intro">([\s\S]*?)<\/p>/)?.[1] ?? ""), committed.lead);
  });

  it("prints the eight sections in the data file's order, each with the file's words", () => {
    assert.deepStrictEqual(sectionsOf(served.page), [
      { heading: committed.prices.heading, paragraphs: [committed.prices.intro, committed.prices.note.text] },
      ...committed.answers.map((answer) => ({ heading: answer.heading, paragraphs: [answer.text] })),
      { heading: committed.retirements.heading, paragraphs: [committed.retirements.intro] },
      { heading: committed.other_numbers.heading, paragraphs: [otherNumbersParagraph(committed), committed.see_also.text] },
    ]);
  });

  it("prints every price row from the file, each price in dollars", () => {
    assert.deepStrictEqual(tableText(served.page, "mistral-prices"), priceTable(committed));
  });

  it("prints every retirement row from the file", () => {
    assert.deepStrictEqual(tableText(served.page, "mistral-retirements"), retirementTable(committed));
  });

  it("prints no dollar amount, percentage, count or date that the data file does not hold", () => {
    const held = figuresHeld(committed);
    const printed = prose(articleOf(served.page)).match(FIGURE) ?? [];
    assert.ok(printed.length > 0, "the scan read no figure off the page");
    assert.deepStrictEqual(printed.filter((figure) => !held.has(figure)), []);
  });

  it("links the price note's source as a citation in a new tab, and the See also pages on this site", () => {
    const article = articleOf(served.page);
    const anchors = [...article.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, inner]) => ({ attributes, text: cellText(inner) }));
    assert.deepStrictEqual(anchors.map((anchor) => [decoded(anchor.attributes.match(/href="([^"]+)"/)?.[1] ?? ""), anchor.text]), [
      ...committed.prices.note.links.map((link) => [link.url, link.text]),
      ...committed.see_also.links.map((link) => [link.path, link.text]),
    ]);
    const citations = anchors.slice(0, committed.prices.note.links.length);
    assert.deepStrictEqual(citations.filter((anchor) => !/ target="_blank" rel="nofollow noopener"/.test(` ${anchor.attributes}`)), []);
    assert.doesNotMatch(article, /href="\/go\/|sponsored/);
  });

  it("is listed in the pages sitemap, on /guides, on the guide hub and in /llms.txt, and /vendor/mistral-ai links to it", () => {
    assert.ok(served.sitemap.includes(`<loc>http://localhost${ROUTE}</loc>`), "not in /sitemap-pages.xml");
    assert.ok(served.guides.includes(`href="${ROUTE}"`), "not on /guides");
    assert.ok(served.hub.includes(`href="${ROUTE}"`), "not on /alternatives");
    assert.ok(served.llms.includes(`- [${committed.title}](http://localhost${ROUTE})`), "not in /llms.txt");
    assert.ok(served.vendor.includes(`href="${ROUTE}"`), "/vendor/mistral-ai does not link the guide");
  });

  it("is dated by the page-dates ledger like every other page", () => {
    const ledger = JSON.parse(readFileSync(path.join(REPO, "data", "page-lastmod.json"), "utf8"));
    const entry = ledger.pages[ROUTE];
    assert.ok(entry, `${ROUTE} has no entry in data/page-lastmod.json`);
    assert.match(entry.hash, /^[0-9a-f]{16}$/);
  });

  it("states its headline, description and publication day in its JSON-LD", () => {
    const jsonLd = JSON.parse(served.page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "{}");
    assert.strictEqual(jsonLd["@type"], "Article");
    assert.strictEqual(jsonLd.headline, committed.title);
    assert.strictEqual(jsonLd.description, committed.meta_description);
    assert.strictEqual(jsonLd.datePublished, committed.published);
  });
});

describe("the pages that link a vendor's alternatives guide", () => {
  const SERVED_ON = "2026-10-11T12:00:00Z";
  const MISTRAL_SHUTDOWN = {
    vendor: "Mistral AI",
    change_type: "product_deprecated",
    date: "2026-12-15",
    date_source: "vendor_page",
    summary: "A Mistral AI model leaves the API on 2026-12-15.",
    previous_state: "The model could be called through the API.",
    current_state: "The model cannot be called through the API.",
    impact: "medium",
    source_url: "https://docs.mistral.ai/getting-started/models/",
    category: "AI / ML",
    alternatives: [],
    recorded_date: "2026-10-01",
    listing_effect: "none",
  };
  const scratch = mkdtempSync(path.join(tmpdir(), "mistral-guide-links-"));
  const changesPath = path.join(scratch, "deal_changes.json");
  const pages = { "/stability": "", "/shutdowns": "", "/alternative-to/mistral-ai": "" };
  let server: ChildProcess | null = null;

  before(async () => {
    const committedChanges = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));
    writeFileSync(changesPath, JSON.stringify({ ...committedChanges, changes: [...committedChanges.changes, MISTRAL_SHUTDOWN] }));
    const { child, base } = await startServer({ AGENTDEALS_CHANGES_PATH: changesPath }, SERVED_ON);
    server = child;
    for (const route of Object.keys(pages) as (keyof typeof pages)[]) pages[route] = await (await fetch(`${base}${route}`)).text();
  });
  after(() => {
    if (server) server.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  const anchorTextsLinking = (page: string, href: string) =>
    [...page.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].filter(([, attributes]) => attributes.includes(`href="${href}"`)).map(([, , inner]) => cellText(inner));

  it("print Mistral AI's stability row and a card for its scheduled shutdown", () => {
    assert.ok(pages["/stability"].includes('href="/vendor/mistral-ai"'), "/stability prints no Mistral AI row");
    assert.ok(pages["/shutdowns"].includes(MISTRAL_SHUTDOWN.summary), "/shutdowns prints no card for the Mistral AI shutdown");
    assert.ok(pages["/alternative-to/mistral-ai"].includes("<h1>"), "/alternative-to/mistral-ai did not render");
  });

  it("never offer the Mistral API pricing guide as alternatives or as a migration guide, since it recommends no alternative", () => {
    for (const [route, page] of Object.entries(pages)) {
      assert.deepStrictEqual(anchorTextsLinking(page, ROUTE).filter((text) => /alternatives|migration/i.test(text)), [], route);
    }
    assert.doesNotMatch(pages["/alternative-to/mistral-ai"], /class="editorial-cta"/);
  });
});

describe("the Mistral API pricing guide, built from another data file", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "mistral-prices-"));
  const file = path.join(scratch, "mistral_api_prices.json");
  const changed: MistralPrices = JSON.parse(JSON.stringify(committed));
  changed.prices.rows[1] = { ...changed.prices.rows[1], input: "0.55", output: "1.65" };
  changed.prices.rows.push({ model: "A model only this scratch file holds", input: "9.25", cached_input: "0.925", output: "18.5", source: "https://docs.mistral.ai/inference/pricing", read_on: "2026-11-02" });
  changed.retirements.rows.unshift({ model: "A retirement only this scratch file holds", retired: "2027-02-28 (scheduled)", replacement: "Its successor", source: "https://docs.mistral.ai/models", read_on: "2026-11-02" });
  changed.answers[3] = { ...changed.answers[3], text: "Mistral now publishes 7 requests per second for each Workspace." };
  changed.published = "2026-11-02";
  writeFileSync(file, JSON.stringify(changed));
  const served = servedFrom(file);
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it("prints that file's prices and retirements, with the rows it adds", () => {
    assert.deepStrictEqual(tableText(served.page, "mistral-prices"), priceTable(changed));
    assert.deepStrictEqual(tableText(served.page, "mistral-retirements"), retirementTable(changed));
  });

  it("prints that file's words in each section, and its publication day in the JSON-LD", () => {
    assert.ok(sectionsOf(served.page).some((section) => section.paragraphs.includes("Mistral now publishes 7 requests per second for each Workspace.")));
    const jsonLd = JSON.parse(served.page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "{}");
    assert.strictEqual(jsonLd.datePublished, "2026-11-02");
  });
});

describe("a data file the Mistral API pricing guide can be built from", () => {
  const variant = (change: (prices: MistralPrices) => void) => {
    const prices: MistralPrices = JSON.parse(JSON.stringify(committed));
    change(prices);
    return JSON.stringify(prices);
  };
  const refused = (change: (prices: MistralPrices) => void, problem: RegExp) =>
    assert.throws(() => parseMistralPrices(variant(change), "scratch.json"), problem);

  it("is the committed file", () => {
    assert.doesNotThrow(() => parseMistralPrices(readFileSync(DATA_FILE, "utf8"), DATA_FILE));
  });

  it("gives every row of both tables a source address and a read date", () => {
    const rows = [...committed.prices.rows, ...committed.retirements.rows];
    assert.ok(rows.length > 0);
    assert.deepStrictEqual(rows.filter((row) => !/^https:\/\//.test(row.source) || !/^\d{4}-\d{2}-\d{2}$/.test(row.read_on)).map((row) => row.model), []);
  });

  it("is refused when a table row has no source address or no read date", () => {
    refused((prices) => { delete (prices.prices.rows[0] as Partial<MistralPrices["prices"]["rows"][number]>).source; }, /prices\.rows\[0\]\.source is not an https address/);
    refused((prices) => { prices.prices.rows[2].read_on = "2026-10-32"; }, /prices\.rows\[2\]\.read_on is not a calendar day/);
    refused((prices) => { prices.retirements.rows[1].source = "docs.mistral.ai/models"; }, /retirements\.rows\[1\]\.source is not an https address/);
    refused((prices) => { delete (prices.retirements.rows[0] as Partial<MistralPrices["retirements"]["rows"][number]>).read_on; }, /retirements\.rows\[0\]\.read_on is not a calendar day/);
  });

  it("is refused when a price is not a plain dollar figure", () => {
    refused((prices) => { prices.prices.rows[1].input = "$0.50"; }, /prices\.rows\[1\]\.input is not a price in dollars/);
    refused((prices) => { prices.prices.rows[3].cached_input = "0,015"; }, /prices\.rows\[3\]\.cached_input is not a price in dollars/);
  });

  it("is refused when a retirement is not dated with a calendar day", () => {
    refused((prices) => { prices.retirements.rows[0].retired = "October 31, 2026"; }, /retirements\.rows\[0\]\.retired is not a calendar day/);
    refused((prices) => { prices.retirements.rows[2].retired = "2026-02-30"; }, /retirements\.rows\[2\]\.retired is not a calendar day/);
  });

  it("is refused when retired terms do not name a dated web.archive.org capture", () => {
    refused((prices) => { prices.other_numbers.retired_terms[0].source = "https://help.mistral.ai/en/articles/225174-what-are-the-limits-of-the-free-tier"; }, /other_numbers\.retired_terms\[0\]\.source is not a dated web\.archive\.org capture/);
  });

  it("is refused when the price note links words it does not hold, or a See also link is not words of its line on a path of this site", () => {
    refused((prices) => { prices.prices.note.links[0].text = "Mistral's price list"; }, /prices\.note\.links\[0\]\.text is not words of prices\.note\.text/);
    refused((prices) => { prices.see_also.links[0].text = "Free AI APIs"; }, /see_also\.links\[0\]\.text is not words of see_also\.text/);
    refused((prices) => { prices.see_also.links[1].path = "https://agentdeals.dev/llm-api-pricing"; }, /see_also\.links\[1\]\.path is not a path on this site/);
  });

  it("is refused when the publication day is not a calendar day", () => {
    refused((prices) => { prices.published = "11 October 2026"; }, /published is not a calendar day/);
  });
});
