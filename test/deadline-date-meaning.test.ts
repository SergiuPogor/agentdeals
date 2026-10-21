import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { datesNamedIn, statedDeadlines, type DeadlineText } from "../dist/stated-deadlines.js";

function text(value: string, statedIn: DeadlineText["statedIn"] = "description"): DeadlineText {
  return { vendor: "Example Cloud", category: "Cloud Hosting", text: value, sourceUrl: "https://example.com/pricing", statedIn };
}

function dates(value: string): string[] {
  return statedDeadlines([text(value)], [], "2026-01-01").map(entry => entry.date);
}

const metadata = [
  "Under the terms (2026-10-14), free content may train models.",
  "Its change log of 2026-10-14 announces the retirement.",
  "The acquisition closed on 2026-10-14, and the company now owns the service.",
  "Until at least October 14, 2026, the pricing page offered free units.",
  "On 2026-10-14 example.com returned errors.",
  "Checked 2026-10-14, the page says the service has shut down.",
  "Checked 2026-10-14, the vendor names no free plan.",
  "The new model became generally available on 2026-10-14.",
  "The model, generally available since 2026-10-14, is not available on the free tier.",
  "The service shuts down on 2026-10-31: its post of 2026-10-14 says no migration is automatic.",
  "Sign-ups are disabled (read 2026-10-14), so the free credit is no longer offered.",
  "On 2026-10-14, the model catalogue still lists the small model but no longer lists the large model.",
  "The model was retired on 2026-10-31 and is no longer listed (checked 2026-10-14).",
];

describe("a stated deadline uses the event's date", () => {
  for (const [index, sentence] of metadata.entries()) {
    it(`excludes metadata date ${index + 1} even beside a retirement`, () => {
      for (const value of [`${sentence} The API retires on 2026-10-31.`, `${sentence.replace(/\.$/, "")}; the API retires on 2026-10-31.`]) {
        assert.ok(!dates(value).includes("2026-10-14"), value);
        assert.ok(dates(value).includes("2026-10-31"), value);
      }
    });
  }

  it("separates a publication and an event in the same sentence", () => {
    assert.deepEqual(dates("The API retires on 2026-10-31 (its change log of 2026-10-14 says it will be discontinued on 2026-10-31)."), ["2026-10-31"]);
  });

  it("excludes acquisition dates even when the same sentence announces a shutdown", () => {
    assert.deepEqual(dates("The company was acquired on 2026-10-14 and its API shuts down on 2026-10-31."), ["2026-10-31"]);
  });

  it("does not use an unrelated sentence's date because another sentence names a deadline", () => {
    assert.deepEqual(dates("The company was founded on 2026-10-14. Its API retires on 2026-10-31."), ["2026-10-31"]);
  });

  it("does not let an observation consume a later event clause", () => {
    assert.deepEqual(dates("The API shuts down on 2026-10-31; on 2026-10-14 example.com returned errors."), ["2026-10-31"]);
    assert.deepEqual(dates("On 2026-10-31 the API retires, and its page still lists migration steps."), ["2026-10-31"]);
  });

  it("checks each occurrence when one date names both metadata and an event", () => {
    assert.deepEqual(dates("The API retires on 2026-10-14 (checked 2026-10-14)."), ["2026-10-14"]);
  });

  it("keeps month-first and day-first deadlines while excluding their check dates", () => {
    assert.deepEqual(dates("Read October 14, 2026, the API retires on 31st October 2026."), ["2026-10-31"]);
    assert.deepEqual(dates("Checked 14 October 2026, the API retires on October 31, 2026."), ["2026-10-31"]);
  });

  it("retains dated items belonging to an explicit retirement list", () => {
    assert.deepEqual(dates("Other model IDs retired this year include these. Small: example/small on 2026-10-14. Large: example/large on 2026-10-31."), ["2026-10-14", "2026-10-31"]);
    assert.deepEqual(dates("The API retires on 2026-10-31. Launch: example/small became generally available on 2026-10-14."), ["2026-10-31"]);
  });

  it("leaves a retirement list when ordinary prose resumes", () => {
    assert.deepEqual(dates("Retired models include these. Small: example/small on 2026-10-14. Our office was founded in 2020. Launch: example/new on 2026-10-20."), ["2026-10-14"]);
  });

  it("retains prices, restrictions and grandfathered-plan boundaries", () => {
    assert.deepEqual(dates("Free through 2026-10-14, then costs $2 from 2026-10-15."), ["2026-10-15"]);
    assert.deepEqual(dates("The old plan stays until 2026-10-31."), ["2026-10-31"]);
    assert.deepEqual(dates("Accounts created before 2026-10-14 keep 50,000 requests until 2026-10-31."), ["2026-10-14", "2026-10-31"]);
  });

  it("falls back to a real deadline when the preferred condition gives only a check date", () => {
    const result = statedDeadlines([
      text("The API retires on 2026-10-31."),
      text("Checked 2026-10-31, the page still lists a retired API.", "condition"),
    ], [], "2026-01-01");
    assert.equal(result.length, 1);
    assert.equal(result[0].statedIn, "description");
    assert.equal(result[0].sentence, "The API retires on 2026-10-31.");
  });

  it("preserves the general-purpose date reader's result", () => {
    assert.deepEqual(datesNamedIn("Read 2026-10-14; retired 31 October 2026 and October 31st, 2026."), ["2026-10-14", "2026-10-31"]);
  });
});
