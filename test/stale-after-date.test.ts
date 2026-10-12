import { describe, it } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";

const { datesIn, readsTheSameOnBothSides, sentencesOf, sweep } = await import("../scripts/stale-after-date.mjs");

describe("stale-after-date reads the dates a sentence names", () => {
  it("reads ISO dates, month names with a year, and day-first dates", () => {
    assert.deepStrictEqual(datesIn("It can be called until 2026-10-22, when Google shuts it down.", "2026-10-12"), ["2026-10-22"]);
    assert.deepStrictEqual(datesIn("Existing evals become read-only on October 31, 2026.", "2026-10-12"), ["2026-10-31"]);
    assert.deepStrictEqual(datesIn("Date in Effect: Oct 31, 2026", "2026-10-12"), ["2026-10-31"]);
    assert.deepStrictEqual(datesIn("The plan ends on 18 October 2026.", "2026-10-12"), ["2026-10-18"]);
  });

  it("dates a month and day with no year to its next occurrence after today", () => {
    assert.deepStrictEqual(datesIn("Moved to Free on December 2.", "2026-10-12"), ["2026-12-02"]);
    assert.deepStrictEqual(datesIn("Renews on March 5.", "2026-10-12"), ["2027-03-05"]);
  });

  it("takes the year of a range from its end", () => {
    assert.deepStrictEqual(datesIn("Pricing Changes: October 20–26, 2025", "2026-10-12"), ["2025-10-20"]);
    assert.deepStrictEqual(datesIn("Pricing Changes: October 26 – November 1, 2026", "2026-10-12"), ["2026-10-26", "2026-11-01"]);
  });
});

describe("stale-after-date splits a page into the sentences a reader sees", () => {
  const page = `<html><head><title>T</title><meta name="description" content="Apiary reaches end of life on 2026-10-31."></head>
<body><script>var x = "2026-10-31 hidden";</script><style>.a{}</style>
<p>Apiary reaches end of life on 2026-10-31, when Oracle stops the service. Oracle announced it on 2025-10-28.</p>
<table><tr><td>effective 2026-10-31</td><td>2026-10-31 (scheduled)</td></tr></table>
<script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"name":"q","acceptedAnswer":{"text":"Existing evals become read-only on October 31, 2026."}}]}</script>
</body></html>`;

  it("keeps visible sentences, table cells, the meta description and structured-data prose, and drops scripts and styles", () => {
    const sentences = sentencesOf(page, true);
    assert.ok(sentences.includes("Apiary reaches end of life on 2026-10-31, when Oracle stops the service."));
    assert.ok(sentences.includes("Oracle announced it on 2025-10-28."));
    assert.ok(sentences.includes("effective 2026-10-31"));
    assert.ok(sentences.includes("2026-10-31 (scheduled)"));
    assert.ok(sentences.includes("Apiary reaches end of life on 2026-10-31."));
    assert.ok(sentences.includes("Existing evals become read-only on October 31, 2026."));
    assert.ok(!sentences.some((s: string) => s.includes("hidden")), "script text was read as prose");
  });

  it("leaves out labels that read the same on both sides of their date, and keeps sentences with a tense", () => {
    for (const label of ["2026-10-31", "effective 2026-10-22", "effective Oct 22, 2026", "Source ↗ (effective 2026-10-14)", "October 22, 2026 Source ↗"]) {
      assert.ok(readsTheSameOnBothSides(label), label);
    }
    for (const sentence of ["2026-10-31 (scheduled)", "Apiary reaches end of life on 2026-10-31, when Oracle stops the service."]) {
      assert.ok(!readsTheSameOnBothSides(sentence), sentence);
    }
  });
});

describe("stale-after-date run against this build", () => {
  it("reads the whole site at both dates and reports only sentences dated inside the window", async () => {
    const result = await sweep({ days: 30, keepLabels: false });
    assertPopulationFloor(result.fetched, 1500, "routes the sweep read");
    for (const s of result.sentences) {
      assert.ok(s.date > result.today && s.date <= result.later, `${s.date} is outside ${result.today}..${result.later}: ${s.sentence}`);
      assert.ok(s.stillServedOn.every((route: string) => s.routes.includes(route)), s.sentence);
      assert.ok(!readsTheSameOnBothSides(s.sentence), s.sentence);
    }
  });
});
