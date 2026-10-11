import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { assertCoversPopulation, pagesOnTheReviewRegister } from "./population-floor.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const INSTALL_COMMAND = "claude mcp add agentdeals";
const INSTALL_BOX_HEADING = "Get this data in your AI editor";
const PAGES_ABOUT_INSTALLING = new Set(["/setup"]);
const SITEMAPS = [
  "/sitemap.xml",
  "/sitemap-pages.xml",
  "/sitemap-reports.xml",
  "/sitemap-misc.xml",
  "/sitemap-vendors.xml",
  "/sitemap-categories.xml",
  "/sitemap-alternatives.xml",
  "/sitemap-compare.xml",
];

const REGISTERED_PATHS: string[] = JSON.parse(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8")).pages.map((page: { path: string }) => page.path);

let server: ChildProcess;
let base = "";
const served = new Map<string, string>();

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        base = `http://localhost:${match[1]}`;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function locs(sitemap: string): Promise<string[]> {
  const response = await fetch(`${base}${sitemap}`);
  if (response.status !== 200) return [];
  return [...(await response.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
}

before(async () => {
  server = await startServer();
  const routes = new Set<string>(["/", "/setup", "/estimate", "/budget-builder"]);
  for (const sitemap of SITEMAPS) {
    for (const route of await locs(sitemap)) {
      if (route.endsWith(".xml")) for (const nested of await locs(route)) routes.add(nested);
      else routes.add(route);
    }
  }
  const list = [...routes];
  for (let at = 0; at < list.length; at += 8) {
    await Promise.all(list.slice(at, at + 8).map(async (route) => {
      const response = await fetch(`${base}${route}`);
      if (response.status === 200) served.set(route, await response.text());
    }));
  }
});

after(() => {
  server?.kill();
});

describe("the MCP install command is served only where the reader asked how to install it", () => {
  it("reads every page on the review register among the routes it sweeps", () => {
    const swept = REGISTERED_PATHS.filter((route) => served.has(route)).length;
    assertCoversPopulation(swept, pagesOnTheReviewRegister(), "pages on the review register that the sweep served");
    assert.ok(served.has("/vendor/vercel") && served.has("/category/databases") && served.has("/compare/netlify-vs-vercel"));
  });

  it("puts neither the install command nor the install box in the served HTML of any other route", () => {
    const carrying = [...served]
      .filter(([route]) => !PAGES_ABOUT_INSTALLING.has(route))
      .flatMap(([route, html]) => [INSTALL_COMMAND, INSTALL_BOX_HEADING].filter((text) => html.includes(text)).map((text) => `${route}: "${text}"`));
    assert.deepStrictEqual(carrying, []);
  });

  it("keeps the install command on /setup", () => {
    assert.ok(served.get("/setup")?.includes(`<code>${INSTALL_COMMAND} -- npx -y agentdeals</code>`));
  });
});
