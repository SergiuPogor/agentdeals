import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Offer } from "../src/types.ts";
import { toSlug } from "../dist/vendor-slug.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATEGORIES = [
  "API Gateway", "Background Jobs", "Browser Automation", "Code Quality", "Container Registry",
  "DNS & Domain Management", "Dev Utilities", "Diagramming", "Documentation", "Feature Flags",
  "Forms", "Headless CMS", "Localization", "Low-Code Platforms", "Maps/Geolocation", "Messaging",
  "Mobile Development", "Notebooks & Data Science", "Payments", "Search", "Server Management",
  "Source Control", "Team Collaboration", "Tunneling & Networking", "Video", "Web Scraping", "Workflow Automation",
];
const KEPT = new Map([
  ["Databases", ["/database-free-tier-comparison-2026", "/database-alternatives"]],
  ["Cloud Hosting", ["/hosting-pricing", "/hosting-alternatives"]],
  ["Monitoring", ["/monitoring-comparison-2026", "/monitoring-alternatives"]],
  ["CI/CD", ["/cicd-free-tier-comparison-2026", "/ci-cd-alternatives"]],
  ["Security", ["/security-free-tier-comparison-2026", "/security-alternatives"]],
  ["Storage", ["/storage-comparison-2026", "/storage-alternatives"]],
  ["Testing", ["/testing-free-tier-comparison-2026", "/testing-alternatives"]],
  ["Analytics", ["/analytics-free-tier-comparison-2026", "/analytics-alternatives"]],
  ["Email", ["/email-comparison-2026", "/email-alternatives"]],
  ["API Development", ["/api-development-free-tier-comparison-2026", "/api-development-alternatives"]],
  ["AI / ML", ["/llm-api-pricing", "/ai-ml-alternatives"]],
  ["Design", ["/design-alternatives"]],
  ["IDE & Code Editors", ["/ide-code-editors-alternatives"]],
  ["Project Management", ["/project-management-alternatives"]],
  ["Cloud Storage", ["/storage-alternatives"]],
  ["CDN", ["/storage-comparison-2026", "/storage-alternatives"]],
  ["Error Tracking", ["/monitoring-comparison-2026", "/monitoring-alternatives"]],
  ["Logging", ["/monitoring-comparison-2026", "/monitoring-alternatives"]],
  ["AI Coding", ["/ai-coding-tools-pricing", "/ide-code-editors-alternatives"]],
  ["Auth", ["/auth-comparison-2026", "/security-alternatives"]],
  ["Cloud IaaS", ["/cloud-free-tier-comparison-2026", "/hosting-alternatives"]],
  ["Infrastructure", ["/hosting-alternatives"]],
  ["Secrets Management", ["/security-alternatives"]],
  ["Status Pages", ["/monitoring-alternatives"]],
  ["Startup Perks", ["/startup-credits"]],
]);
const scratch = mkdtempSync(path.join(tmpdir(), "vendor-category-links-"));
const children: ChildProcess[] = [];
const pages = new Map<string, string>();

function section(html: string, name: string): string {
  const match = html.match(new RegExp(`<div class="${name}">([\\s\\S]*?)<\\/div>`));
  assert.ok(match, name);
  return match[1];
}

async function start(indexPath?: string): Promise<string> {
  const child = spawn("node", [path.join(ROOT, "dist/serve.js")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off", ...(indexPath ? { AGENTDEALS_INDEX_PATH: indexPath } : {}) },
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${log}`)), 30_000);
    child.stderr!.on("data", chunk => {
      log = (log + chunk).slice(-3000);
      const match = log.match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://localhost:${match[1]}`); }
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${log}`)); });
  });
}

before(async () => {
  const live = await start();
  for (const slug of ["pipedream", "bugsnag"]) {
    const response = await fetch(`${live}/vendor/${slug}`, { redirect: "error" });
    assert.equal(response.status, 200);
    pages.set(slug, await response.text());
  }
  const offers: Offer[] = [...CATEGORIES, ...KEPT.keys()].map((category, i) => ({
    vendor: `Category Link ${i}`, category, tier: "Free", description: "Free plan with 100 requests per month.",
    url: `https://category-link-${i}.example/pricing`, verifiedDate: new Date().toISOString().slice(0, 10), tags: [],
  }));
  const file = path.join(scratch, "index.json");
  writeFileSync(file, JSON.stringify({ offers }));
  const fixture = await start(file);
  for (const offer of offers) {
    const response = await fetch(`${fixture}/vendor/${toSlug(offer.vendor)}`, { redirect: "error" });
    assert.equal(response.status, 200);
    pages.set(offer.category, await response.text());
  }
});

after(() => {
  for (const child of children) child.kill();
  rmSync(scratch, { recursive: true, force: true });
});

function assertOfferLinks(html: string, category: string): void {
  const target = `/category/${toSlug(category)}`;
  for (const name of ["category-context", "section related-guides"]) {
    const body = section(html, name);
    const links = [...body.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g)];
    const own = links.filter(link => link[1] === target);
    assert.equal(own.length, 1, `${category}: ${name}`);
    assert.match(own[0][2], /offer(?:s| we track)/);
    assert.doesNotMatch(body, /alternatives guide/i);
  }
}

describe("vendor category links name the offers or guides they lead to", () => {
  it("links Pipedream's context and related guide to the workflow automation offers", () => {
    assertOfferLinks(pages.get("pipedream")!, "Workflow Automation");
  });

  for (const category of CATEGORIES) it(`${category} links its own offers in both sections`, () => {
    assertOfferLinks(pages.get(category)!, category);
  });

  it("keeps Bugsnag's monitoring comparison and alternatives guide", () => {
    const html = pages.get("bugsnag")!;
    assert.match(section(html, "category-context"), /href="\/monitoring-comparison-2026"/);
    assert.match(section(html, "section related-guides"), /href="\/monitoring-alternatives"/);
  });

  for (const [category, targets] of KEPT) it(`${category} keeps its existing comparison and guide destinations`, () => {
    const html = pages.get(category)!;
    assert.match(section(html, "category-context"), new RegExp(`href="${targets[0]}"`));
    const related = section(html, "section related-guides");
    for (const target of targets) assert.ok(related.includes(`href="${target}"`), `${category}: ${target}`);
    assert.doesNotMatch(related, /offers we track/);
  });
});
