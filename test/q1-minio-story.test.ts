import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "https://github.com/minio/minio";
let risk: string;
let server: ChildProcess;
let html: string;
let story: string;
let text: string;

before(async () => {
  server = spawn(process.execPath, [path.join(REPO, "dist/serve.js")], {
    cwd: REPO,
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { server.kill(); reject(new Error("Server startup timeout")); }, 30000);
    server.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    server.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
  const response = await fetch(`http://localhost:${port}/q1-2026-developer-pricing-report`);
  assert.equal(response.status, 200);
  html = await response.text();
  risk = await (await fetch(`http://localhost:${port}/free-tier-risk`)).text();
  const cards = [...html.matchAll(/<div class="story-card">([\s\S]*?)<\/div>/g)];
  const matches = cards.filter((match) => match[1].includes("<h3>MinIO Open Source Killed</h3>"));
  assert.equal(matches.length, 1);
  story = matches[0][1];
  text = story.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
});

after(() => { server?.kill(); });

describe("MinIO's open-source archive is separate from AIStor licensing", () => {
  it("states the AGPLv3 license and dates the maintenance notice and following archive", () => {
    assert.ok(text.includes("MinIO's open-source server was licensed under AGPLv3."));
    assert.ok(text.includes("On February 12, 2026, MinIO marked its repository as no longer maintained and archived it the next day."));
  });

  it("states the lack of fixes and distinguishes commercial AIStor and its single-node free edition", () => {
    assert.ok(text.includes("The AGPL edition now gets no bug fixes or security patches."));
    assert.ok(text.includes("Development continues in the commercially licensed MinIO AIStor."));
    assert.ok(text.includes("Its AIStor Free edition is free for a single-node deployment."));
  });

  it("cites the repository with destination metadata and preserves the existing navigation", () => {
    const links = [...story.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/g)];
    const citations = links.filter(match => match[1].includes(`href="${SOURCE}"`));
    assert.equal(citations.length, 1);
    assert.match(citations[0][1], /rel="nofollow noopener"/);
    assert.match(citations[0][1], /title="github.com\/minio\/minio"/);
    assert.ok(story.includes('href="/vendor/minio"'));
    assert.ok(story.includes('href="/storage-alternatives"'));
  });

  it("describes maintenance ending in both the visible warning answer and its structured answer", () => {
    const question = "What are the warning signs that a free tier is about to be removed?";
    const faq = [...risk.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map(match => JSON.parse(match[1])).find(value => value["@type"] === "FAQPage");
    assert.ok(faq);
    const answer = faq.mainEntity.find((entry: any) => entry.name === question)?.acceptedAnswer.text;
    assert.ok(answer);
    assert.ok(answer.includes("(2) end of open-source maintenance (MinIO's AGPLv3 server)"));
    const visible = risk.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
    assert.ok(visible.includes("(2) end of open-source maintenance (MinIO's AGPLv3 server)"));
    const warning = risk.match(/<strong>Watch the signals, not just the announcements<\/strong>\s*<p>([\s\S]*?)<\/p>/)?.[1];
    assert.ok(warning);
    assert.ok(warning.includes("end of open-source maintenance (MinIO's AGPLv3 server)"));
    assert.ok(warning.includes("credit-based pricing transitions (Vercel, Netlify)"));
  });

  it("removes the false relicensing and compulsory commercial-license claims from both complete responses", () => {
    for (const page of [html, risk]) {
      assert.doesNotMatch(page, /MinIO.{0,100}(?:switched from Apache|AGPL(?:v3)?\s*(?:to|→)\s*proprietary)/i);
      assert.ok(!page.includes("Self-hosted users now need a commercial license for production use"));
    }
    assert.ok(html.includes("HashiCorp discontinued the legacy HCP Terraform free plan on March 31."));
    assert.ok(html.replace(/<[^>]+>/g, "").includes("X launched Pay-Per-Use pricing"));
    assert.equal([...html.matchAll(/<div class="story-card">/g)].length, 7);
  });
});
