import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Offer } from "../src/types.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const WITHHELD_SUBJECTS = ["Withheld Alpha", "Withheld Beta", "Withheld Gamma"];

export function withheldTermsFixture(directory: string, newAndExpiring = false) {
  const today = new Date().toISOString().slice(0, 10);
  const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const index = JSON.parse(readFileSync(process.env.AGENTDEALS_INDEX_PATH || path.join(REPO, "data", "index.json"), "utf-8"));
  const changes = JSON.parse(readFileSync(process.env.AGENTDEALS_CHANGES_PATH || path.join(REPO, "data", "deal_changes.json"), "utf-8"));
  const subjects: Offer[] = WITHHELD_SUBJECTS.map((vendor) => ({
    vendor,
    category: "Withheld Terms Subjects",
    description: `${vendor} stored allowance: free plan with 100 GB of storage and 10,000 monthly requests.`,
    tier: "Free",
    url: `https://${vendor.toLowerCase().replace(/ /g, "-")}.example/pricing`,
    product_subtypes: { taxonomy: "Withheld Terms Subjects", labels: [{ subtype: "storage", source_url: "https://withheld-subject.example/pricing", source_quote: "Hosted storage service." }], reviewed: today },
    tags: [],
    verifiedDate: today,
    ...(newAndExpiring ? { expires_date: inAWeek } : {}),
    source_check: { checked: today, outcome: "ok", detail: "The pricing page names the plan and its allowance." },
  }));
  const control: Offer = { ...subjects[0]!, vendor: "Withheld Terms Control", description: "Free plan: 50 GB of storage.", url: "https://withheld-control.example/pricing" };
  const catalogue = { ...index, offers: [...subjects, ...index.offers, control] };
  const records = subjects.map((offer) => ({
    vendor: offer.vendor,
    category: offer.category,
    change_type: "limits_reduced",
    date: today,
    date_source: "discovered",
    previous_state: offer.description,
    current_state: "Free plan: 20 GB of storage and 10,000 monthly requests.",
    summary: "The free plan's storage allowance changed from 100 GB to 20 GB.",
    source_url: offer.url,
    impact: "high",
    alternatives: [],
  }));
  const indexPath = path.join(directory, "index.json");
  const changesPath = path.join(directory, "deal_changes.json");
  writeFileSync(indexPath, JSON.stringify(catalogue));
  writeFileSync(changesPath, JSON.stringify({ ...changes, changes: [...records, ...changes.changes] }));
  return { catalogue, env: { AGENTDEALS_INDEX_PATH: indexPath, AGENTDEALS_CHANGES_PATH: changesPath } };
}
