import { it } from "node:test";
import assert from "node:assert/strict";
import { changeContext, DEFAULT_CHANGE_WINDOW_DAYS, getPersonalizedChanges } from "../dist/data.js";

const DAY_MS = 86_400_000;
const NOW = Date.now();

it("keeps the default change window at its declared length when the clock advances between reads", t => {
  let tick = 0;
  t.mock.method(Date, "now", () => NOW + tick++);
  assert.equal(changeContext([]).summary.period_days, DEFAULT_CHANGE_WINDOW_DAYS);
});

it("keeps the personalized change summary at the same default window under an advancing clock", t => {
  let tick = 0;
  t.mock.method(Date, "now", () => NOW + tick++);
  assert.equal(getPersonalizedChanges().summary.period_days, DEFAULT_CHANGE_WINDOW_DAYS);
});

it("still measures a requested start day through the instant the summary was read", t => {
  t.mock.method(Date, "now", () => NOW);
  const since = new Date(NOW - 7 * DAY_MS).toISOString().slice(0, 10);
  const expected = Math.ceil((NOW - Date.parse(since)) / DAY_MS);
  assert.equal(changeContext([], since).summary.period_days, expected);
  assert.equal(changeContext([], `${since}T23:59:59Z`).summary.period_days, expected);
});
