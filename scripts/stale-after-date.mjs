#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 86_400_000;
const CONCURRENCY = 6;

const HELP = `Stale after date — lists every sentence the site serves that names a date
between today and a day ahead, and is still served word for word on that day.
A sentence that outlives its own date unchanged is fixed text: read it for
tense ("retires on", "can be called until", "(scheduled)").

It serves this build twice from dist/ (run npx tsc first): once at today's
clock and once with the clock moved ahead, and reads every sitemap route plus
llms.txt and the feeds from both. Labels that read the same on both sides of a
date (a bare date, "effective <date>", "<date> Source") are left out.

Usage:
  node scripts/stale-after-date.mjs                 the next 30 days
  node scripts/stale-after-date.mjs --days 60       the next 60 days
  node scripts/stale-after-date.mjs --json out.json also write every sentence found
  node scripts/stale-after-date.mjs --all           keep the labels too
`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export function datesIn(sentence, today) {
  const year = Number(today.slice(0, 4));
  const found = new Set();
  for (const m of sentence.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) found.add(iso(m[1], Number(m[2]), Number(m[3])));
  for (const m of sentence.matchAll(new RegExp(`\\b(${MONTHS.join("|")}) (\\d{1,2})(?:st|nd|rd|th)?(?:, (20\\d\\d))?\\b`, "g"))) {
    const month = MONTHS.indexOf(m[1]) + 1;
    const day = Number(m[2]);
    if (m[3]) { found.add(iso(m[3], month, day)); continue; }
    const rangeYear = sentence.slice(m.index + m[0].length, m.index + m[0].length + 30).match(/^\s*[–—-]\s*(?:[A-Z][a-z]+ )?\d{1,2}, (20\d\d)\b/)?.[1];
    if (rangeYear) { found.add(iso(rangeYear, month, day)); continue; }
    const thisYear = iso(year, month, day);
    found.add(thisYear > today ? thisYear : iso(year + 1, month, day));
  }
  for (const m of sentence.matchAll(new RegExp(`\\b(${MONTHS.map((m) => m.slice(0, 3)).join("|")}) (\\d{1,2}), (20\\d\\d)\\b`, "g"))) {
    found.add(iso(m[3], MONTHS.findIndex((x) => x.startsWith(m[1])) + 1, Number(m[2])));
  }
  for (const m of sentence.matchAll(new RegExp(`\\b(\\d{1,2}) (${MONTHS.join("|")}) (20\\d\\d)\\b`, "g"))) {
    found.add(iso(m[3], MONTHS.indexOf(m[2]) + 1, Number(m[1])));
  }
  return [...found].sort();
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&rarr;": "→", "&nearr;": "↗", "&minus;": "−", "&middot;": "·", "&hellip;": "…", "&euro;": "€", "&times;": "×" };
const decode = (s) => s.replace(/&[a-z]+;|&#\d+;/g, (e) => ENTITIES[e] ?? (e.startsWith("&#") ? String.fromCharCode(Number(e.slice(2, -1))) : e));

function proseIn(value, found) {
  if (typeof value === "string") {
    if (value.length >= 30 && /\s/.test(value)) found.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) proseIn(v, found);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) proseIn(v, found);
  }
  return found;
}

const BLOCK = /<\/?(?:p|li|td|th|tr|h[1-6]|div|section|article|header|footer|ul|ol|table|br|dt|dd|summary|details|blockquote|figcaption|caption)\b[^>]*>/gi;

export function sentencesOf(body, isHtml) {
  const chunks = [];
  if (isHtml) {
    for (const m of body.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
      try {
        chunks.push(...proseIn(JSON.parse(m[1]), []));
      } catch {
        continue;
      }
    }
    const description = body.match(/<meta name="description" content="([^"]*)"/)?.[1];
    if (description) chunks.push(description);
    const visible = body
      .replace(/<head>[\s\S]*?<\/head>/, "\n")
      .replace(/<script[\s\S]*?<\/script>/g, "\n")
      .replace(/<style[\s\S]*?<\/style>/g, "\n")
      .replace(BLOCK, "\n")
      .replace(/<[^>]+>/g, " ");
    chunks.push(...visible.split("\n"));
  } else {
    chunks.push(...body.replace(/<[^>]+>/g, " ").split("\n"));
  }
  const sentences = [];
  for (const chunk of chunks) {
    const line = decode(chunk).replace(/\s+/g, " ").replace(/\(\s/g, "(").replace(/\s([.,;:!?)])/g, "$1").trim();
    if (!line) continue;
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z"(\[])/)) if (s.trim()) sentences.push(s.trim());
  }
  return sentences;
}

const DATE = String.raw`(?:\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8} \d{1,2}, \d{4})`;
const LABELS = [
  new RegExp(`^${DATE}$`),
  new RegExp(`^effective ${DATE}$`),
  new RegExp(`^Source ↗ \\(effective ${DATE}\\)$`),
  new RegExp(`^${DATE} Source ↗$`),
];

export function readsTheSameOnBothSides(sentence) {
  return LABELS.some((label) => label.test(sentence));
}

function argument(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function startServer(shiftMs) {
  return new Promise((resolve, reject) => {
    const imports = shiftMs ? ["--import", path.join(REPO, "scripts", "shifted-clock.mjs")] : [];
    const child = spawn(process.execPath, [...imports, path.join(REPO, "dist", "serve.js")], {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost",
        TZ: "UTC",
        AGENTDEALS_API_URL: "http://stale-after-date-reads-no-api.invalid",
        AGENTDEALS_REFERRAL_HEALTH: "off",
        AGENTDEALS_CLOCK_SHIFT_MS: String(shiftMs),
      },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("the server did not start within 90 s")); }, 90_000);
    child.stderr.on("data", (data) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, base: `http://localhost:${m[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function routesOf(base) {
  const routes = new Set(["/llms.txt", "/llms-full.txt", "/feed.xml", "/rss.xml", "/changes.xml", "/pricing-changes.xml"]);
  const seen = new Set();
  const queue = ["/sitemap.xml"];
  while (queue.length > 0) {
    const sitemap = queue.shift();
    if (seen.has(sitemap)) continue;
    seen.add(sitemap);
    const res = await fetch(base + sitemap);
    if (res.status !== 200) continue;
    for (const [, loc] of (await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const route = new URL(loc).pathname;
      if (route.endsWith(".xml")) queue.push(route);
      else routes.add(route);
    }
  }
  return [...routes];
}

async function read(base, route) {
  const res = await fetch(base + route, { redirect: "manual" });
  if (res.status !== 200) return { status: res.status, sentences: [] };
  const isHtml = (res.headers.get("content-type") ?? "").includes("html");
  return { status: 200, sentences: sentencesOf(await res.text(), isHtml) };
}

export async function sweep({ days, keepLabels }) {
  const today = new Date().toISOString().slice(0, 10);
  const later = new Date(Date.parse(`${today}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
  const [now, ahead] = await Promise.all([startServer(0), startServer(days * DAY_MS)]);
  try {
    const routes = await routesOf(now.base);
    const found = new Map();
    let fetched = 0;
    for (let i = 0; i < routes.length; i += CONCURRENCY) {
      await Promise.all(routes.slice(i, i + CONCURRENCY).map(async (route) => {
        const current = await read(now.base, route);
        if (current.status !== 200) return;
        fetched++;
        const dated = [...new Set(current.sentences)]
          .map((sentence) => ({ sentence, date: datesIn(sentence, today).find((d) => d > today && d <= later) }))
          .filter((s) => s.date && (keepLabels || !readsTheSameOnBothSides(s.sentence)));
        if (dated.length === 0) return;
        const after = await read(ahead.base, route);
        const servedAfter = new Set(after.sentences);
        for (const { sentence, date } of dated) {
          const entry = found.get(sentence) ?? { date, sentence, routes: [], stillServedOn: [] };
          entry.routes.push(route);
          if (servedAfter.has(sentence)) entry.stillServedOn.push(route);
          found.set(sentence, entry);
        }
      }));
    }
    const sentences = [...found.values()]
      .map((e) => ({ ...e, routes: e.routes.sort(), stillServedOn: e.stillServedOn.sort() }))
      .sort((a, b) => a.date.localeCompare(b.date) || b.stillServedOn.length - a.stillServedOn.length);
    return { today, later, routes: routes.length, fetched, sentences };
  } finally {
    now.child.kill();
    ahead.child.kill();
  }
}

async function main(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const days = Number(argument(args, "--days") ?? 30);
  const jsonPath = argument(args, "--json");
  if (!Number.isInteger(days) || days < 1 || (args.includes("--json") && !jsonPath)) {
    console.error(HELP);
    return 2;
  }
  const result = await sweep({ days, keepLabels: args.includes("--all") });
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(result, null, 1)}\n`);
  const stale = result.sentences.filter((s) => s.stillServedOn.length > 0);
  console.log(`Read ${result.fetched} of ${result.routes} routes at ${result.today} and ${result.later}: ${result.sentences.length} sentences name a date in between, and ${stale.length} are still served word for word on ${result.later}.`);
  for (const s of stale) {
    const sample = s.stillServedOn.slice(0, 3).join(" ");
    console.log(`${s.date}  ${s.stillServedOn.length} of ${s.routes.length} routes  ${s.sentence.slice(0, 240)}  (${sample}${s.stillServedOn.length > 3 ? " …" : ""})`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => { console.error(err.message); process.exit(2); },
  );
}
