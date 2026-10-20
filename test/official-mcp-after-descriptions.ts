import { officialMcpPassage } from "../dist/official-mcp.js";
import type { OfficialMcpServer } from "../src/official-mcp.ts";

type Listing = { vendor: string; official_mcp_servers?: OfficialMcpServer[] };

export function plainMcpPassagesByVendor(listings: readonly Listing[]): Map<string, string[]> {
  const byVendor = new Map<string, string[]>();
  for (const listing of listings) {
    const passages = (listing.official_mcp_servers ?? []).map(entry => officialMcpPassage(listing.vendor, entry));
    if (passages.length) byVendor.set(listing.vendor, [...(byVendor.get(listing.vendor) ?? []), ...passages]);
  }
  return byVendor;
}

export function withoutItsOwnMcpPassages(described: string, own: readonly string[] = []): string {
  return own.reduce((remaining, passage) => remaining.replace(` ${passage}`, ""), described);
}
