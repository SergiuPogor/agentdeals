import { it } from "node:test";
import assert from "node:assert/strict";
import { plainMcpPassagesByVendor, withoutItsOwnMcpPassages } from "./official-mcp-after-descriptions.ts";
import { withoutItsOwnConditions } from "./conditions-after-descriptions.ts";

const entry = {
  kind: "remote" as const, target: "https://example.com/mcp", transport: "Streamable HTTP",
  authentication: "OAuth", doc_url: "https://example.com/docs", read_on: "2026-10-20",
  source_quote: "Connect to our MCP server.",
};
const passage = 'Example runs its own MCP server. "Connect to our MCP server." (From https://example.com/docs, read 2026-10-20.) The endpoint is https://example.com/mcp, the transport is Streamable HTTP, and authentication uses OAuth.';
const own = plainMcpPassagesByVendor([{ vendor: "Example", official_mcp_servers: [entry] }]).get("Example");
const conditions = " Personal use only. (From https://example.com/terms, read 2026-10-20.)";

it("removes only the listing's exact sourced passage while retaining a reason on either side", () => {
  const terms = "Free storage.";
  const reason = "We cannot confirm these terms today.";
  for (const described of [`${terms} ${reason} ${passage}`, `${terms} ${passage} ${reason}`]) {
    assert.equal(withoutItsOwnMcpPassages(described, own), `${terms} ${reason}`);
  }
  assert.equal(withoutItsOwnMcpPassages(`${terms} ${passage}`, own), terms);
  assert.equal(withoutItsOwnMcpPassages(`${terms} ${passage}`, undefined), `${terms} ${passage}`);
  assert.equal(withoutItsOwnMcpPassages(`${terms} ${passage.replace("OAuth", "an API key")}`, own), `${terms} ${passage.replace("OAuth", "an API key")}`);
});

it("leaves appended unstated text visible when passages and conditions are removed", () => {
  const terms = "Free storage.";
  const reason = "We cannot confirm these terms today.";
  for (const described of [`${terms} ${passage}${conditions}`, `${terms}${conditions} ${passage}`]) {
    assert.equal(withoutItsOwnConditions(withoutItsOwnMcpPassages(described, own), [conditions]), terms);
    assert.ok(withoutItsOwnConditions(withoutItsOwnMcpPassages(`${described} ${reason}`, own), [conditions]).includes(reason));
  }
});

it("collects every passage for a vendor with several listings without removing another vendor's words", () => {
  const second = { ...entry, target: "https://example.com/second" };
  const byVendor = plainMcpPassagesByVendor([
    { vendor: "Example", official_mcp_servers: [entry] },
    { vendor: "Example", official_mcp_servers: [second] },
    { vendor: "Other", official_mcp_servers: [entry] },
    { vendor: "Plain" },
  ]);
  assert.equal(byVendor.get("Example")?.length, 2);
  const secondPassage = passage.replace("https://example.com/mcp", "https://example.com/second");
  assert.equal(withoutItsOwnMcpPassages(`Free storage. ${passage} ${secondPassage}`, byVendor.get("Example")), "Free storage.");
  assert.equal(withoutItsOwnMcpPassages(`Free storage. ${passage}`, byVendor.get("Other")), `Free storage. ${passage}`);
  assert.equal(byVendor.has("Plain"), false);
});
