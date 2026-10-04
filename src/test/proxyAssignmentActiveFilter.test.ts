import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Reproduces the reassignment scenario:
 *   - Lukoda Joseph was originally a proxy of Caroline (active=true)
 *   - He is later reassigned to Lilian; the trigger
 *     `trg_deactivate_stale_proxy_assignments` flips Caroline's row to
 *     is_active=false and inserts a fresh row for Lilian.
 *
 * Both Caroline's and Lilian's UI queries MUST filter `is_active=true` so
 * only the newest assignment surfaces. These tests assert the query builder
 * chain enforces that filter and that stale rows never come back.
 */

type Row = {
  id: string;
  beneficiary_id: string;
  agent_id: string;
  is_active: boolean;
  beneficiary_role?: string;
  approval_status?: string;
  created_at?: string;
};

const STALE: Row = {
  id: "stale-1",
  beneficiary_id: "lukoda-joseph",
  agent_id: "caroline",
  is_active: false,
  beneficiary_role: "supporter",
  approval_status: "approved",
  created_at: "2026-05-19T00:00:00Z",
};

const ACTIVE: Row = {
  id: "active-1",
  beneficiary_id: "lukoda-joseph",
  agent_id: "lilian",
  is_active: true,
  beneficiary_role: "supporter",
  approval_status: "approved",
  created_at: "2026-05-20T00:00:00Z",
};

const ROWS = [STALE, ACTIVE];

function makeBuilder(table: string) {
  const filters: Array<[string, unknown]> = [];
  const builder: any = {
    _filters: filters,
    _table: table,
    select: vi.fn().mockImplementation(() => builder),
    order: vi.fn().mockImplementation(() => builder),
    in: vi.fn().mockImplementation(() => builder),
    eq: vi.fn().mockImplementation((col: string, val: unknown) => {
      filters.push([col, val]);
      return builder;
    }),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
      const data = ROWS.filter((r) =>
        filters.every(([c, v]) => (r as any)[c] === v),
      );
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return builder;
}

let lastBuilder: any;
const supabase = {
  from: vi.fn().mockImplementation((table: string) => {
    lastBuilder = makeBuilder(table);
    return lastBuilder;
  }),
};

beforeEach(() => {
  supabase.from.mockClear();
  lastBuilder = undefined;
});

describe("proxy_agent_assignments active-only filter", () => {
  it("AgentPartners-style query returns only the newest (active) assignment", async () => {
    const userId = "lilian";
    const { data } = await supabase
      .from("proxy_agent_assignments")
      .select("id, beneficiary_id, created_at, is_active, approval_status")
      .eq("agent_id", userId)
      .eq("is_active", true);

    expect(lastBuilder.eq).toHaveBeenCalledWith("is_active", true);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(ACTIVE.id);
    expect(data.every((r) => r.is_active)).toBe(true);
  });

  it("Caroline (previous proxy) sees zero rows after reassignment", async () => {
    const { data } = await supabase
      .from("proxy_agent_assignments")
      .select("id, beneficiary_id, created_at, is_active, approval_status")
      .eq("agent_id", "caroline")
      .eq("is_active", true);

    expect(data).toHaveLength(0);
  });

  it("FunderManagementSheet-style query enforces is_active=true", async () => {
    const userId = "lilian";
    const { data } = await supabase
      .from("proxy_agent_assignments")
      .select("id, beneficiary_id, beneficiary_role, is_active, approval_status")
      .eq("agent_id", userId)
      .eq("is_active", true)
      .eq("beneficiary_role", "supporter");

    const filterCols = lastBuilder._filters.map(([c]: [string]) => c);
    expect(filterCols).toContain("is_active");
    expect(data).toHaveLength(1);
    expect(data[0].beneficiary_id).toBe("lukoda-joseph");
    expect(data[0].agent_id).toBe("lilian");
  });

  it("regression: omitting the is_active filter would leak the stale row", async () => {
    const { data } = await supabase
      .from("proxy_agent_assignments")
      .select("*")
      .eq("agent_id", "caroline"); // missing .eq('is_active', true)

    // Proves the test fixture would surface the stale row without the filter,
    // which is exactly the bug Caroline reported.
    expect(data.some((r) => r.id === STALE.id)).toBe(true);
  });
});

/**
 * Source-level guard: the production queries MUST chain `.eq('is_active', true)`.
 * If a future edit drops the filter, this test fails loudly.
 */
describe("source guards for is_active filter", () => {
  it("AgentPartners.tsx filters proxy_agent_assignments by is_active=true", async () => {
    const src = await import("fs").then((m) =>
      m.readFileSync("src/pages/AgentPartners.tsx", "utf8"),
    );
    const block = src.split("proxy_agent_assignments")[1] ?? "";
    expect(block).toMatch(/\.eq\(\s*['"]is_active['"]\s*,\s*true\s*\)/);
  });

  it("FunderManagementSheet.tsx filters proxy_agent_assignments by is_active=true", async () => {
    const src = await import("fs").then((m) =>
      m.readFileSync("src/components/agent/FunderManagementSheet.tsx", "utf8"),
    );
    const block = src.split("proxy_agent_assignments")[1] ?? "";
    expect(block).toMatch(/\.eq\(\s*['"]is_active['"]\s*,\s*true\s*\)/);
  });
});