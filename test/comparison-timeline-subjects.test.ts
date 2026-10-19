import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUBJECTS = [
  { slug: "email", category: "Email", compared: "Resend", prefix: "Resend Other Product", keywords: ["email", "smtp", "transactional"] },
  { slug: "monitoring", category: "Monitoring", compared: "Datadog", prefix: "Elastic Other Product", keywords: ["monitoring", "observability", "apm", "uptime"] },
  { slug: "storage", category: "Storage", compared: "Storj", prefix: "Cloudflare Other Product", keywords: ["storage", "egress", "object storage"] },
];

type RunningServer = { process: ChildProcess; base: string };

async function startServer(env: NodeJS.ProcessEnv = {}): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, "dist/serve.js")], {
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off", ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 40000);
    child.stderr!.on("data", (chunk: Buffer) => {
      const match = chunk.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ process: child, base: `http://localhost:${match[1]}` });
      }
    });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited with ${code}`)); });
  });
}

function timelineRows(html: string): string[][] {
  const section = html.match(/<h2 id="changes">[\s\S]*?(?=<h2|$)/)?.[0];
  assert.ok(section, "the comparison has a change timeline section");
  const body = section.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
  assert.notEqual(body, undefined, "the timeline has a table body");
  return [...body!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) =>
      cell.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
    ),
  );
}

async function readTimeline(server: RunningServer, slug: string): Promise<string[][]> {
  const response = await fetch(`${server.base}/${slug}-comparison-2026`, { redirect: "error" });
  assert.equal(response.status, 200);
  return timelineRows(await response.text());
}

function data(file: string) {
  return JSON.parse(readFileSync(path.join(REPO, "data", file), "utf8"));
}

describe("comparison timeline membership", () => {
  let live: RunningServer;
  let fixture: RunningServer;
  let categoryEmpty: RunningServer;
  let dir = "";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "comparison-timeline-subjects-"));
    const index = data("index.json");
    const changes = data("deal_changes.json");
    const template = changes.changes.find((c: { vendor: string; change_type: string; resolution?: unknown }) =>
      c.vendor === "Resend" && c.change_type === "limits_increased" && !c.resolution,
    ) ?? changes.changes.find((c: { change_type: string; resolution?: unknown }) => c.change_type === "limits_increased" && !c.resolution);
    assert.ok(template);
    const date = new Date().toISOString().slice(0, 10);
    const records: object[] = [];
    for (const subject of SUBJECTS) {
      for (const offer of index.offers) if (offer.vendor === subject.compared) offer.category = "Dev Utilities";
      const categoryVendor = `Category Only ${subject.category}`;
      const offer = index.offers.find((o: { vendor: string }) => o.vendor === subject.compared);
      assert.ok(offer);
      index.offers.push({ ...offer, vendor: categoryVendor, category: "Dev Utilities", url: `https://example.com/${subject.slug}/other` });
      index.offers.push({ ...offer, vendor: categoryVendor, category: subject.category, url: `https://example.com/${subject.slug}` });
      const record = (vendor: string, summary: string) => ({ ...template, vendor, summary, date, recorded_date: date, category: "Dev Utilities", source_url: `https://example.com/${subject.slug}/change` });
      records.push(record(subject.compared, `Compared ${subject.slug} terms changed`));
      records.push(record(categoryVendor, `Category ${subject.slug} terms changed`));
      for (const keyword of subject.keywords) records.push(record(`Unrelated ${subject.slug} ${keyword}`, `Another product mentions ${keyword}`));
      records.push(record(subject.prefix, `Another product has revised its terms`));
      records.push(record(`Unknown ${subject.slug}`, `Uncatalogued terms changed`));
    }
    const write = (name: string, value: unknown) => {
      const file = path.join(dir, name);
      writeFileSync(file, JSON.stringify(value));
      return file;
    };
    const changePath = write("changes.json", { ...changes, changes: records });
    live = await startServer();
    fixture = await startServer({ AGENTDEALS_INDEX_PATH: write("index.json", index), AGENTDEALS_CHANGES_PATH: changePath });
    categoryEmpty = await startServer({
      AGENTDEALS_INDEX_PATH: write("category-empty.json", { ...index, offers: index.offers.map((o: object) => ({ ...o, category: "Dev Utilities" })) }),
      AGENTDEALS_CHANGES_PATH: changePath,
    });
  });

  after(() => {
    for (const server of [live, fixture, categoryEmpty]) server?.process.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  for (const subject of SUBJECTS) {
    it(`${subject.slug} retains compared vendors and exact catalogue-category members`, async () => {
      const rows = await readTimeline(fixture, subject.slug);
      assert.deepEqual(rows.map(row => row[1]).sort(), [subject.compared, `Category Only ${subject.category}`].sort());
      assert.ok(rows.some(row => row[2].includes(`Compared ${subject.slug} terms changed`)));
      assert.ok(rows.some(row => row[2].includes(`Category ${subject.slug} terms changed`)));
    });

    it(`${subject.slug} retains compared vendors when its catalogue category has no changes`, async () => {
      const rows = await readTimeline(categoryEmpty, subject.slug);
      assert.deepEqual(rows.map(row => row[1]), [subject.compared]);
    });
  }

  it("excludes the unrelated products from the published timelines", async () => {
    const banned = {
      email: ["CatchJS.com", "AppFit", "Appwrite Cloud", "OneSignal"],
      monitoring: ["Svix", "LastPass", "Tomorrow.io Weather API", "Hotjar", "Hasura"],
      storage: ["SurrealDB Cloud", "Neon", "OVHcloud", "Modal", "Nango", "Penpot", "CockroachDB", "Chroma"],
    };
    for (const subject of SUBJECTS) {
      const rows = await readTimeline(live, subject.slug);
      assert.ok(rows.length > 0 && rows.length <= 12);
      assert.deepEqual(rows.filter(row => banned[subject.slug as keyof typeof banned].includes(row[1]!)), []);
    }
  });
});
