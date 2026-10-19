import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUBJECTS = [
  { slug: "email", categories: ["Email"], compared: "Resend", keywords: ["email", "smtp", "transactional"] },
  { slug: "monitoring", categories: ["Monitoring", "Logging", "Error Tracking"], compared: "Datadog", keywords: ["monitoring", "observability", "apm", "uptime"] },
  { slug: "storage", categories: ["Storage", "Cloud Storage", "CDN"], compared: "Storj", keywords: ["storage", "egress", "object storage"] },
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
  let catalogueChanged: RunningServer;
  let categoryEmpty: RunningServer;
  let aliases: RunningServer;
  let dir = "";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "comparison-timeline-subjects-"));
    const index = data("index.json");
    const changes = data("deal_changes.json");
    const template = changes.changes.find((c: { vendor: string; change_type: string; resolution?: unknown }) =>
      c.vendor === "Resend" && c.change_type === "limits_increased" && !c.resolution,
    );
    assert.ok(template);
    const date = new Date().toISOString().slice(0, 10);
    const records: object[] = [];
    const record = (vendor: string, category: string, summary: string) => ({
      ...template, vendor, category, summary, date, recorded_date: date,
      source_url: "https://example.com/change",
    });
    for (const subject of SUBJECTS) {
      for (const category of subject.categories) {
        records.push(record(`Uncatalogued ${category}`, category, `Changed ${category} terms`));
        records.push(record(subject.compared, category, `Compared ${category} terms`));
      }
      records.push(record(subject.compared, "Dev Utilities", `Other product from ${subject.compared}`));
      records.push(record(`${subject.compared} Other Product`, "Dev Utilities", "Other product terms"));
      for (const keyword of subject.keywords) {
        records.push(record(`Unrelated ${keyword}`, "Dev Utilities", `Another product mentions ${keyword}`));
      }
      records.push(record(`Almost ${subject.categories[0]}`, `${subject.categories[0]} Other`, "Other category terms"));
    }
    records.push(record("AWS", "DevOps", "AWS Proton ends support"));
    records.push(record("AWS", "Cloud Hosting", "AWS Fargate version ends support"));
    records.push(record("Oracle Cloud", "Cloud IaaS", "Always Free VM terms changed"));
    const write = (name: string, value: unknown) => {
      const file = path.join(dir, name);
      writeFileSync(file, JSON.stringify(value));
      return file;
    };
    const changePath = write("changes.json", { ...changes, changes: records });
    live = await startServer();
    fixture = await startServer({ AGENTDEALS_CHANGES_PATH: changePath });
    catalogueChanged = await startServer({
      AGENTDEALS_CHANGES_PATH: changePath,
      AGENTDEALS_INDEX_PATH: write("index.json", { ...index, offers: index.offers.map((o: object) => ({ ...o, category: "Dev Utilities" })) }),
    });
    categoryEmpty = await startServer({
      AGENTDEALS_CHANGES_PATH: write("empty.json", { ...changes, changes: records.map((c: object) => ({ ...c, category: "Dev Utilities" })) }),
    });
    aliases = await startServer({ AGENTDEALS_CHANGES_PATH: write("aliases.json", {
      ...changes, changes: ["Mailtrap", "MailerLite", "MailerSend"].map(vendor => record(vendor, "Email", `Email history for ${vendor}`)),
    }) });
  });

  after(() => {
    for (const server of [live, fixture, catalogueChanged, categoryEmpty, aliases]) server?.process.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  for (const subject of SUBJECTS) {
    it(`${subject.slug} selects every subject category by the change record alone`, async () => {
      const rows = await readTimeline(fixture, subject.slug);
      assert.deepEqual(rows.map(row => row[2]!.split(/ Unconfirmed\.| Source/)[0]).sort(), subject.categories.flatMap(category =>
        [`Changed ${category} terms`, `Compared ${category} terms`],
      ).sort());
    });

    it(`${subject.slug} membership is independent of catalogue categories`, async () => {
      assert.deepEqual(await readTimeline(catalogueChanged, subject.slug), await readTimeline(fixture, subject.slug));
    });

    it(`${subject.slug} excludes compared vendors when no record has a subject category`, async () => {
      assert.deepEqual(await readTimeline(categoryEmpty, subject.slug), []);
    });
  }

  it("keeps Email records under each table spelling", async () => {
    const rows = await readTimeline(aliases, "email");
    assert.equal(rows.length, 3);
    for (const vendor of ["Mailtrap", "MailerLite", "MailerSend"]) {
      assert.ok(rows.some(row => row[2].includes(`Email history for ${vendor}`)));
    }
  });

  it("every published row belongs to its page's subject categories", async () => {
    const changes = data("deal_changes.json").changes;
    for (const subject of SUBJECTS) {
      const rows = await readTimeline(live, subject.slug);
      assert.ok(rows.length > 0 && rows.length <= 12);
      const allowedNames = new Set(changes.filter((c: { category: string }) => subject.categories.includes(c.category)).map((c: { vendor: string }) => c.vendor));
      for (const row of rows) assert.ok(allowedNames.has(row[1]), row[1]);
      const text = JSON.stringify(rows);
      const excluded = {
        email: /CatchJS|AppFit|Appwrite Cloud/,
        monitoring: /Svix|LastPass|Tomorrow.io|Hotjar|Hasura/,
        storage: /AWS Proton|AWS App Mesh|Fargate|SurrealDB Cloud|Neon|OVHcloud|Modal|Nango|Penpot|CockroachDB|Chroma/,
      };
      assert.doesNotMatch(text, excluded[subject.slug as keyof typeof excluded]);
    }
  });
});
