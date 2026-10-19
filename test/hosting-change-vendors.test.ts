import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
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


const PAGES = ["hosting-alternatives", "hosting-pricing", "hosting-free-tier-comparison-2026"];
const EXACT = ["Railway", "Fly.io", "Cloudflare Workers", "Cloudflare Pages", "Google Cloud Run", "GitHub Pages"];
const UNRELATED = ["Cloudflare", "Cloudflare for Startups", "Cloudflare Workers AI", "Cloudflare Pages Other", "Google", "Google Developer Program", "GitHub", "GitHub Copilot", "Fly.io Other", "Railway Other"];

function changeSection(html: string, page: string): string {
  if (page === "hosting-alternatives") {
    return html.match(/Recent Hosting Pricing Changes[\s\S]*?<\/ul>/)?.[0] ?? "";
  }
  return html.match(/<h2 id="changes">[\s\S]*?(?=<h2|$)/)?.[0] ?? "";
}

async function readSection(server: RunningServer, page: string): Promise<string> {
  const response = await fetch(`${server.base}/${page}`, { redirect: "error" });
  assert.equal(response.status, 200);
  return changeSection(await response.text(), page);
}

function data(file: string) {
  return JSON.parse(readFileSync(path.join(REPO, "data", file), "utf8"));
}

describe("hosting change vendor selection", () => {
  let fixture: RunningServer;
  let live: RunningServer;
  let dir = "";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hosting-change-vendors-"));
    const changes = data("deal_changes.json");
    const template = changes.changes.find((c: { vendor: string; change_type: string; resolution?: unknown }) =>
      c.vendor === "Resend" && c.change_type === "limits_increased" && !c.resolution,
    );
    assert.ok(template);
    const date = new Date().toISOString().slice(0, 10);
    const record = (vendor: string, category: string) => ({
      ...template, date_source: "vendor_page", vendor, category, summary: `Fixture history for ${vendor}.`, date, recorded_date: date,
      source_url: "https://example.com/change",
    });
    const file = path.join(dir, "changes.json");
    writeFileSync(file, JSON.stringify({ ...changes, changes: [
      ...EXACT.map(vendor => record(vendor, "Dev Utilities")),
      ...UNRELATED.map(vendor => record(vendor, "Dev Utilities")),
      record("Category Cloud Hosting", "Cloud Hosting"), record("Category Hosting", "Hosting"),
    ] }));
    fixture = await startServer({ AGENTDEALS_CHANGES_PATH: file });
    live = await startServer();
  });

  after(() => {
    for (const server of [fixture, live]) server?.process.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  for (const page of PAGES) {
    it(`${page} admits exact hosting products and excludes similar and parent vendor names`, async () => {
      const section = await readSection(fixture, page);
      const expected = page === "hosting-alternatives" ? EXACT.slice(0, 4) : page === "hosting-pricing" ? EXACT : EXACT.filter(vendor => vendor !== "Google Cloud Run");
      for (const vendor of expected) assert.ok(section.includes(`Fixture history for ${vendor}.`), vendor);
      for (const vendor of UNRELATED) assert.ok(!section.includes(`Fixture history for ${vendor}.`), vendor);
      for (const category of ["Cloud Hosting", "Hosting"]) {
        assert.equal(section.includes(`Fixture history for Category ${category}.`), page === "hosting-free-tier-comparison-2026");
      }
    });

    it(`${page} excludes unrelated published product changes`, async () => {
      const section = await readSection(live, page);
      assert.doesNotMatch(section, /Cloudflare for Startups|Cloudflare Workers AI|AWS App Mesh|WorkSpaces Thin Client|Google Developer Program|Google AI Ultra|GitHub Copilot/);
    });
  }
});
