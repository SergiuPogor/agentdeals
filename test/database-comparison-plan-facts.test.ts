import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const comparison = "/database-free-tier-comparison-2026";
const vector = "/vector-database-pricing";
const pages: Record<string, string> = {};
let server: ChildProcess;

function text(html: string): string {
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").replace(/ ([.,;:])/g, "$1").trim();
}

function cells(route: string, vendor: string, columns = 6): string[] {
  const rows = [...pages[route].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => text(cell)))
    .filter((row) => row.length === columns && (row[0] === vendor || row[0]?.startsWith(`${vendor} `)));
  assert.equal(rows.length, 1, `${route} must carry one ${vendor} comparison row`);
  return rows[0];
}

describe("database comparisons distinguish free-plan limits and closed cloud signup", () => {
  before(async () => {
    const base = await new Promise<string>((resolve, reject) => {
      server = spawn("node", ["dist/serve.js"], {
        cwd: root, stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_REFERRAL_HEALTH: "off" },
      });
      const timeout = setTimeout(() => { server.kill(); reject(new Error("Server startup timeout")); }, 20000);
      server.once("error", (error) => { clearTimeout(timeout); reject(error); });
      server.stderr!.on("data", (chunk: Buffer) => {
        const port = chunk.toString().match(/running on http:\/\/localhost:(\d+)/)?.[1];
        if (port) { clearTimeout(timeout); resolve(`http://localhost:${port}`); }
      });
    });
    for (const route of [comparison, vector]) {
      const response = await fetch(base + route, { redirect: "error" });
      assert.equal(response.status, 200, route);
      pages[route] = await response.text();
    }
  });

  after(() => { server?.kill(); });

  it("states Redis Cloud's throughput and connection caps beside its 30 MB free plan", () => {
    assert.deepEqual(cells(comparison, "Redis Cloud").slice(1, 4), ["Redis", "30 MB", "100 ops/sec, 30 connections"]);
  });

  it("says the free Redis Cloud plan has no persistence, with the negative cell style", () => {
    assert.equal(cells(comparison, "Redis Cloud")[4], "No (not on the free plan)");
    assert.match(pages[comparison], /<td class="cross">No \(not on the free plan\)<\/td>/);
  });

  it("states the Redis 8 open-source license option and preserves the surrounding cache guidance", () => {
    const note = text(pages[comparison]).match(/Upstash is the standout[\s\S]*?Dragonfly a source-available one\./)?.[0];
    assert.equal(note, "Upstash is the standout for serverless Redis — 256 MB data and 500K commands/month with true pay-per-request pricing beyond the free tier. Cloudflare KV has more storage (1 GB) but very low write limits (1K/day) making it best for read-heavy config data. Redis Cloud's 30 MB free tier is tiny but useful for development. Note: Redis 8 added AGPLv3, an open-source license, besides RSALv2 and SSPLv1. Valkey is the leading open-source alternative, and Dragonfly a source-available one.");
  });

  it("distinguishes LanceDB's unlimited embedded offer from its closed cloud signup", () => {
    assert.deepEqual(cells(comparison, "LanceDB", 5).slice(1), ["Unlimited (embedded)", "Unlimited (embedded)", "OSS: free. Cloud: closed to new accounts", "Embedded vector search, local development"]);
  });

  it("shows closed LanceDB cloud signup in the vector pricing table", () => {
    const row = cells(vector, "LanceDB", 7);
    assert.equal(row[5], "Cloud: closed to new accounts");
    assert.deepEqual(row.slice(2, 5), ["Unlimited (OSS)", "Unlimited (OSS)", "Unlimited"]);
  });

  it("shows closed LanceDB cloud signup in its vector description without offering credits", () => {
    const card = pages[vector].match(/<h3><a href="\/vendor\/lancedb">LanceDB<\/a><\/h3>[\s\S]*?(?=<h3|<h2)/)?.[0];
    assert.ok(card, "LanceDB's vector description is present");
    assert.match(text(card), /LanceDB Cloud is closed to new accounts\./);
    assert.doesNotMatch(text(card), /\$100|one-time free credits/);
  });

  it("preserves Turso storage, Upstash commands and Pinecone storage", () => {
    assert.equal(cells(comparison, "Turso")[2], "5 GB");
    assert.equal(cells(comparison, "Upstash")[3], "500K commands/mo");
    assert.equal(cells(vector, "Pinecone", 7)[3], "2 GB");
  });
});
