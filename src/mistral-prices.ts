import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { archiveCaptureDate, isCalendarDay, isPageAddress, isText, linkedWordsProblems, textFieldProblems, type LinkedWords } from "./guide-data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MISTRAL_PRICES_SLUG = "mistral-api-pricing-2026";
export const MISTRAL_PRICES_PATH = `/${MISTRAL_PRICES_SLUG}`;

export interface SourcedRow {
  source: string;
  read_on: string;
}

export interface MistralPriceRow extends SourcedRow {
  model: string;
  input: string;
  cached_input: string;
  output: string;
}

export interface MistralRetirementRow extends SourcedRow {
  model: string;
  retired: string;
  replacement: string;
}

export interface Answer {
  heading: string;
  text: string;
}

export interface RetiredTerms {
  text: string;
  source: string;
}

export interface SitePageLink {
  text: string;
  path: string;
}

export interface MistralPrices {
  published: string;
  title: string;
  meta_description: string;
  lead: string;
  prices: {
    heading: string;
    intro: string;
    columns: string[];
    rows: MistralPriceRow[];
    note: LinkedWords;
  };
  answers: Answer[];
  retirements: {
    heading: string;
    intro: string;
    columns: string[];
    rows: MistralRetirementRow[];
  };
  other_numbers: {
    heading: string;
    retired_terms: RetiredTerms[];
    text: string;
  };
  see_also: {
    text: string;
    links: SitePageLink[];
  };
}

const RATE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const PRICE_FIELDS = ["input", "cached_input", "output"] as const;
const RETIRED_ON = /^(\d{4}-\d{2}-\d{2})(?: \(scheduled\))?$/;
const SITE_PATH = /^\/[a-z0-9][a-z0-9/-]*$/;

export function mistralPricesPath(): string {
  return process.env.AGENTDEALS_MISTRAL_PRICES_PATH || path.join(__dirname, "..", "data", "mistral_api_prices.json");
}

export function dollars(rate: string): string {
  return `$${rate}`;
}

export function retiredTermsSentences(prices: MistralPrices): string[] {
  return prices.other_numbers.retired_terms.map((terms) => terms.text);
}

export function readMistralPrices(file: string = mistralPricesPath()): MistralPrices {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read the Mistral API prices at ${file}: ${(err as Error).message}`);
  }
  return parseMistralPrices(text, file);
}

export function parseMistralPrices(text: string, file: string): MistralPrices {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const problems = mistralPricesProblems(parsed);
  if (problems.length > 0) throw new Error(`${file} ${problems.join("; ")}`);
  return parsed as MistralPrices;
}

function sourcedRowProblems(row: Partial<SourcedRow> | undefined, at: string): string[] {
  const problems: string[] = [];
  if (!isPageAddress(row?.source)) problems.push(`${at}.source is not an https address`);
  if (!isCalendarDay(row?.read_on)) problems.push(`${at}.read_on is not a calendar day`);
  return problems;
}

function columnsProblems(columns: unknown, count: number, at: string): string[] {
  if (!Array.isArray(columns) || columns.length !== count || !columns.every(isText)) return [`${at}.columns needs ${count} headings`];
  return [];
}

function priceRowProblems(row: Partial<MistralPriceRow> | undefined, at: string): string[] {
  const problems: string[] = [];
  if (!isText(row?.model)) problems.push(`${at}.model is missing`);
  for (const field of PRICE_FIELDS) {
    const rate = row?.[field];
    if (typeof rate !== "string" || !RATE.test(rate)) problems.push(`${at}.${field} is not a price in dollars, such as "0.15"`);
  }
  problems.push(...sourcedRowProblems(row, at));
  return problems;
}

function retirementRowProblems(row: Partial<MistralRetirementRow> | undefined, at: string): string[] {
  const problems: string[] = [];
  if (!isText(row?.model)) problems.push(`${at}.model is missing`);
  if (!isText(row?.replacement)) problems.push(`${at}.replacement is missing`);
  const retired = typeof row?.retired === "string" ? row.retired.match(RETIRED_ON) : null;
  if (!retired || !isCalendarDay(retired[1])) problems.push(`${at}.retired is not a calendar day, optionally followed by " (scheduled)"`);
  problems.push(...sourcedRowProblems(row, at));
  return problems;
}

function retiredTermsProblems(terms: Partial<RetiredTerms> | undefined, at: string): string[] {
  const problems: string[] = [];
  if (!isText(terms?.text)) problems.push(`${at}.text is missing`);
  if (typeof terms?.source !== "string" || archiveCaptureDate(terms.source) === null) problems.push(`${at}.source is not a dated web.archive.org capture`);
  return problems;
}

export function mistralPricesProblems(data: unknown): string[] {
  const prices = (data ?? {}) as Partial<MistralPrices>;
  const problems: string[] = [];
  if (!isCalendarDay(prices.published)) problems.push("published is not a calendar day");
  for (const field of ["title", "meta_description", "lead"] as const) {
    if (!isText(prices[field])) problems.push(`${field} is missing`);
  }

  const table = prices.prices;
  if (!table || !Array.isArray(table.rows) || table.rows.length === 0) {
    problems.push("prices needs rows");
  } else {
    problems.push(...textFieldProblems(table, ["heading", "intro"], "prices"));
    problems.push(...columnsProblems(table.columns, 4, "prices"));
    table.rows.forEach((row, n) => problems.push(...priceRowProblems(row, `prices.rows[${n}]`)));
    problems.push(...linkedWordsProblems(table.note, "prices.note", true));
  }

  if (!Array.isArray(prices.answers) || prices.answers.length === 0) {
    problems.push("answers needs at least one heading and text");
  } else {
    prices.answers.forEach((answer, n) => problems.push(...textFieldProblems(answer, ["heading", "text"], `answers[${n}]`)));
  }

  const retirements = prices.retirements;
  if (!retirements || !Array.isArray(retirements.rows) || retirements.rows.length === 0) {
    problems.push("retirements needs rows");
  } else {
    problems.push(...textFieldProblems(retirements, ["heading", "intro"], "retirements"));
    problems.push(...columnsProblems(retirements.columns, 3, "retirements"));
    retirements.rows.forEach((row, n) => problems.push(...retirementRowProblems(row, `retirements.rows[${n}]`)));
  }

  const other = prices.other_numbers;
  if (!other || !Array.isArray(other.retired_terms)) {
    problems.push("other_numbers needs a heading, retired_terms and text");
  } else {
    problems.push(...textFieldProblems(other, ["heading", "text"], "other_numbers"));
    other.retired_terms.forEach((terms, n) => problems.push(...retiredTermsProblems(terms, `other_numbers.retired_terms[${n}]`)));
  }

  const seeAlso = prices.see_also;
  if (!seeAlso || !isText(seeAlso.text) || !Array.isArray(seeAlso.links) || seeAlso.links.length === 0) {
    problems.push("see_also needs text and links");
  } else {
    seeAlso.links.forEach((link, n) => {
      if (!isText(link?.text) || !seeAlso.text.includes(link.text)) problems.push(`see_also.links[${n}].text is not words of see_also.text`);
      if (typeof link?.path !== "string" || !SITE_PATH.test(link.path)) problems.push(`see_also.links[${n}].path is not a path on this site`);
    });
  }
  return problems;
}
