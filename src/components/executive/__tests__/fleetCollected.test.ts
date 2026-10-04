import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- In-memory seeded dataset -------------------------------------------------
// Window: 2026-07-23 00:00:00Z .. 2026-07-24 00:00:00Z
// Two agents, mix of tracking_ids, and some rows tied to rent_requests that
// were CFO-funded via landlord float (must be excluded from "Collected").

type CollectionRow = {
  agent_id: string;
  amount: number;
  created_at: string;
  rent_request_id: string | null;
  tracking_id: string;
};

const AGENT_A = "agent-a";
const AGENT_B = "agent-b";

// rent_requests funded by CFO landlord float
const RR_FLOAT_1 = "rr-float-1";
const RR_FLOAT_2 = "rr-float-2";
// clean rent_requests (fresh field collections)
const RR_CLEAN_1 = "rr-clean-1";
const RR_CLEAN_2 = "rr-clean-2";

const collections: CollectionRow[] = [
  // Agent A — 3 AGT rows: 2 clean (5,000 + 7,500), 1 landlord-float (100,000 excluded)
  { agent_id: AGENT_A, amount: 5_000, created_at: "2026-07-23T08:00:00Z", rent_request_id: RR_CLEAN_1, tracking_id: "AGT-1" },
  { agent_id: AGENT_A, amount: 7_500, created_at: "2026-07-23T09:30:00Z", rent_request_id: RR_CLEAN_2, tracking_id: "AGT-2" },
  { agent_id: AGENT_A, amount: 100_000, created_at: "2026-07-23T10:00:00Z", rent_request_id: RR_FLOAT_1, tracking_id: "AGT-3" },
  // Agent A — non-AGT tracking (must be excluded regardless of rent_request)
  { agent_id: AGENT_A, amount: 999_999, created_at: "2026-07-23T11:00:00Z", rent_request_id: RR_CLEAN_1, tracking_id: "ALLOC-1" },
  { agent_id: AGENT_A, amount: 888_888, created_at: "2026-07-23T11:30:00Z", rent_request_id: null, tracking_id: "TPAY-1" },

  // Agent B — 2 AGT rows: 1 clean (12,000), 1 landlord-float (50,000 excluded)
  { agent_id: AGENT_B, amount: 12_000, created_at: "2026-07-23T14:00:00Z", rent_request_id: null, tracking_id: "AGT-4" },
  { agent_id: AGENT_B, amount: 50_000, created_at: "2026-07-23T15:00:00Z", rent_request_id: RR_FLOAT_2, tracking_id: "AGT-5" },

  // Outside window — must be excluded
  { agent_id: AGENT_A, amount: 1_000_000, created_at: "2026-07-22T23:59:00Z", rent_request_id: RR_CLEAN_1, tracking_id: "AGT-6" },
  { agent_id: AGENT_B, amount: 1_000_000, created_at: "2026-07-24T00:00:00Z", rent_request_id: RR_CLEAN_2, tracking_id: "AGT-7" },

  // Zero/negative amount — must be excluded
  { agent_id: AGENT_A, amount: 0, created_at: "2026-07-23T12:00:00Z", rent_request_id: RR_CLEAN_1, tracking_id: "AGT-8" },
];

const landlordFloatAllocations: Array<{ rent_request_id: string }> = [
  { rent_request_id: RR_FLOAT_1 },
  { rent_request_id: RR_FLOAT_2 },
];

// ---- Minimal supabase query-builder mock -------------------------------------

function buildAgentCollectionsQuery() {
  let rows = [...collections];
  const selectedCols: string[] = [];
  const api: any = {
    select(cols: string) {
      cols.split(",").forEach((c) => selectedCols.push(c.trim()));
      return api;
    },
    gte(col: string, val: string) {
      rows = rows.filter((r) => (r as any)[col] >= val);
      return api;
    },
    lt(col: string, val: string) {
      rows = rows.filter((r) => (r as any)[col] < val);
      return api;
    },
    gt(col: string, val: number) {
      rows = rows.filter((r) => (r as any)[col] > val);
      return api;
    },
    like(col: string, pattern: string) {
      const prefix = pattern.replace(/%$/, "");
      rows = rows.filter((r) => typeof (r as any)[col] === "string" && (r as any)[col].startsWith(prefix));
      return api;
    },
    range(from: number, to: number) {
      const slice = rows.slice(from, to + 1).map((r) => {
        const proj: any = {};
        selectedCols.forEach((c) => (proj[c] = (r as any)[c]));
        return proj;
      });
      return Promise.resolve({ data: slice, error: null });
    },
  };
  return api;
}

function buildLandlordFloatAllocationsQuery() {
  let rows = [...landlordFloatAllocations];
  const api: any = {
    select() {
      return api;
    },
    in(col: string, values: string[]) {
      rows = rows.filter((r) => values.includes((r as any)[col]));
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return api;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from(table: string) {
      if (table === "agent_collections") return buildAgentCollectionsQuery();
      if (table === "agent_landlord_float_allocations") return buildLandlordFloatAllocationsQuery();
      throw new Error(`Unmocked table: ${table}`);
    },
  },
}));

// Recharts (used elsewhere in module) needs DOM stubs — not touched here.

import {
  fetchCollectedByAgent,
  fetchCollectedBuckets,
  fetchLandlordFloatRentRequestIds,
} from "@/components/executive/FleetPerformanceStats";

const START = new Date("2026-07-23T00:00:00Z");
const END = new Date("2026-07-24T00:00:00Z");

describe("Fleet Performance — Collected excludes landlord float allocations", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("identifies CFO landlord-float rent_request_ids", async () => {
    const excluded = await fetchLandlordFloatRentRequestIds([
      RR_FLOAT_1,
      RR_FLOAT_2,
      RR_CLEAN_1,
      RR_CLEAN_2,
    ]);
    expect(excluded.has(RR_FLOAT_1)).toBe(true);
    expect(excluded.has(RR_FLOAT_2)).toBe(true);
    expect(excluded.has(RR_CLEAN_1)).toBe(false);
    expect(excluded.has(RR_CLEAN_2)).toBe(false);
  });

  it("fetchCollectedByAgent returns per-agent totals with landlord-float allocations excluded", async () => {
    const byAgent = await fetchCollectedByAgent(START, END);
    // Agent A: 5,000 + 7,500 = 12,500 (100,000 float row excluded; non-AGT rows excluded)
    // Agent B: 12,000 (50,000 float row excluded)
    expect(byAgent[AGENT_A]).toBe(12_500);
    expect(byAgent[AGENT_B]).toBe(12_000);
    const total = Object.values(byAgent).reduce((s, v) => s + v, 0);
    expect(total).toBe(24_500);
  });

  it("fetchCollectedBuckets sums daily totals with landlord-float allocations excluded", async () => {
    const byDay = await fetchCollectedBuckets(START, END, "day");
    // Only 2026-07-23 bucket, total = 12,500 + 12,000 = 24,500
    expect(byDay["2026-07-23"]).toBe(24_500);
    expect(Object.keys(byDay)).toEqual(["2026-07-23"]);
  });

  it("excludes non-AGT tracking_ids, zero-amount rows, and out-of-window rows", async () => {
    const byAgent = await fetchCollectedByAgent(START, END);
    // If any of the excluded rows leaked in, totals would be far higher
    // (999,999 / 888,888 / 1,000,000 / 0). Sanity-check the ceiling.
    expect(byAgent[AGENT_A]).toBeLessThan(100_000);
    expect(byAgent[AGENT_B]).toBeLessThan(100_000);
  });
});
