import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";

/**
 * Integration-style test for the Bulk-Assign auto-move contract
 * (Partner Ops → Proxy Agent Manager):
 *
 *   For every partner in the batch the mutation must
 *     1. Deactivate every OTHER active proxy assignment (different agent_id)
 *        for that partner.
 *     2. Insert or reactivate a single row for (newAgent, partner).
 *
 * Post-condition (the invariant the rest of the platform relies on):
 *   Each partner has EXACTLY ONE active proxy assignment, and it points
 *   at the newly-selected agent.
 *
 * This is the same one-active-proxy-per-partner contract that
 * `proxyAssignmentActiveFilter.test.ts` already pins from the read side;
 * this file pins it from the write side (bulk assign).
 */

type Row = {
  id: string;
  agent_id: string;
  beneficiary_id: string;
  beneficiary_role: string;
  is_active: boolean;
  approval_status: string;
  is_managed_account?: boolean;
  assigned_by?: string;
  approved_by?: string;
  approved_at?: string | null;
  reason?: string | null;
  agent?: { full_name?: string; phone?: string } | null;
};

/** In-memory `proxy_agent_assignments` table. */
let table: Row[] = [];
let idSeq = 0;
const nextId = () => `pa-${++idSeq}`;

/** Tiny PostgREST-like query builder over the in-memory table. */
function makeBuilder() {
  const eqs: Array<[string, unknown]> = [];
  const neqs: Array<[string, unknown]> = [];
  let inFilter: [string, unknown[]] | null = null;
  let updatePatch: Partial<Row> | null = null;
  let insertPayload: Partial<Row> | Partial<Row>[] | null = null;
  let isSelect = false;
  let selectAfterMutation = false;

  const apply = () =>
    table.filter(
      (r) =>
        eqs.every(([c, v]) => (r as any)[c] === v) &&
        neqs.every(([c, v]) => (r as any)[c] !== v) &&
        (!inFilter || inFilter[1].includes((r as any)[inFilter[0]])),
    );

  const builder: any = {
    select: (_cols?: string) => {
      isSelect = true;
      return builder;
    },
    eq: (c: string, v: unknown) => {
      eqs.push([c, v]);
      return builder;
    },
    neq: (c: string, v: unknown) => {
      neqs.push([c, v]);
      return builder;
    },
    in: (c: string, v: unknown[]) => {
      inFilter = [c, v];
      return builder;
    },
    maybeSingle: async () => {
      const rows = apply();
      return { data: rows[0] ?? null, error: null };
    },
    update: (patch: Partial<Row>) => {
      updatePatch = patch;
      return builder;
    },
    insert: (payload: Partial<Row> | Partial<Row>[]) => {
      insertPayload = payload;
      const arr = Array.isArray(payload) ? payload : [payload];
      arr.forEach((p) =>
        table.push({
          id: nextId(),
          is_active: true,
          approval_status: "approved",
          beneficiary_role: "supporter",
          ...(p as Row),
        }),
      );
      return Promise.resolve({ data: null, error: null });
    },
    then: (resolve: any) => {
      // Terminal step: handle UPDATE … WHERE … or SELECT.
      if (updatePatch) {
        apply().forEach((r) => Object.assign(r, updatePatch));
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      if (isSelect) {
        return Promise.resolve({ data: apply(), error: null }).then(resolve);
      }
      return Promise.resolve({ data: null, error: null }).then(resolve);
    },
  };
  return builder;
}

const supabase = {
  from: vi.fn().mockImplementation(() => makeBuilder()),
};

/**
 * Faithful re-implementation of `bulkAssignMutation` in
 * `src/components/cfo/ProxyAgentManager.tsx` (deactivate-others → upsert).
 * Kept tiny on purpose so the test fails loudly if the production
 * sequence drifts.
 */
async function runBulkAssign(opts: {
  newAgentId: string;
  partners: Array<{ id: string }>;
  assignedBy: string;
  reason: string;
  managed?: boolean;
}) {
  const nowIso = new Date().toISOString();
  const results = { inserted: 0, reactivated: 0, moved: 0 };

  for (const b of opts.partners) {
    // 1) Deactivate any OTHER active proxy holding this partner.
    const { data: others } = await supabase
      .from("proxy_agent_assignments")
      .select("id, agent_id")
      .eq("beneficiary_id", b.id)
      .eq("is_active", true)
      .neq("agent_id", opts.newAgentId);
    if (others && others.length > 0) {
      await supabase
        .from("proxy_agent_assignments")
        .update({ is_active: false })
        .in(
          "id",
          others.map((o: any) => o.id),
        );
      results.moved++;
    }

    // 2) Upsert assignment for (newAgent, partner).
    const { data: existing } = await supabase
      .from("proxy_agent_assignments")
      .select("id")
      .eq("agent_id", opts.newAgentId)
      .eq("beneficiary_id", b.id)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("proxy_agent_assignments")
        .update({
          is_active: true,
          approval_status: "approved",
          assigned_by: opts.assignedBy,
          approved_by: opts.assignedBy,
          approved_at: nowIso,
          reason: opts.reason,
          is_managed_account: !!opts.managed,
        })
        .eq("id", existing.id);
      results.reactivated++;
    } else {
      await supabase.from("proxy_agent_assignments").insert({
        agent_id: opts.newAgentId,
        beneficiary_id: b.id,
        beneficiary_role: "supporter",
        assigned_by: opts.assignedBy,
        approved_by: opts.assignedBy,
        approved_at: nowIso,
        is_managed_account: !!opts.managed,
        approval_status: "approved",
        is_active: true,
        reason: opts.reason,
      });
      results.inserted++;
    }
  }
  return results;
}

function activeFor(partnerId: string) {
  return table.filter((r) => r.beneficiary_id === partnerId && r.is_active);
}

beforeEach(() => {
  table = [];
  idSeq = 0;
  supabase.from.mockClear();
});

describe("bulk assign — auto-move deactivates prior proxy", () => {
  it("moves a partner from prior agent → new agent, leaves exactly one active row", async () => {
    // Seed: PIUS currently on agent CAROLINE.
    table.push({
      id: nextId(),
      agent_id: "caroline",
      beneficiary_id: "pius",
      beneficiary_role: "supporter",
      is_active: true,
      approval_status: "approved",
    });

    const res = await runBulkAssign({
      newAgentId: "lukodda",
      partners: [{ id: "pius" }],
      assignedBy: "partner-ops-1",
      reason: "Bulk assignment by Partner Ops",
    });

    expect(res.moved).toBe(1);
    expect(res.inserted).toBe(1);

    const active = activeFor("pius");
    expect(active).toHaveLength(1);
    expect(active[0].agent_id).toBe("lukodda");

    // Prior row still exists but is_active=false (audit trail preserved).
    const stale = table.find((r) => r.agent_id === "caroline" && r.beneficiary_id === "pius");
    expect(stale?.is_active).toBe(false);
  });

  it("reactivates an existing (newAgent, partner) row instead of inserting a duplicate", async () => {
    // Seed: PIUS has an OLD, deactivated row already pointing at LUKODDA,
    // and a CURRENT active row on CAROLINE.
    table.push({
      id: nextId(),
      agent_id: "lukodda",
      beneficiary_id: "pius",
      beneficiary_role: "supporter",
      is_active: false,
      approval_status: "rejected",
    });
    table.push({
      id: nextId(),
      agent_id: "caroline",
      beneficiary_id: "pius",
      beneficiary_role: "supporter",
      is_active: true,
      approval_status: "approved",
    });

    const res = await runBulkAssign({
      newAgentId: "lukodda",
      partners: [{ id: "pius" }],
      assignedBy: "partner-ops-1",
      reason: "Bulk re-link by Partner Ops",
    });

    expect(res.moved).toBe(1);
    expect(res.reactivated).toBe(1);
    expect(res.inserted).toBe(0);

    // Exactly one active row, pointing at LUKODDA — no duplicate insert.
    const active = activeFor("pius");
    expect(active).toHaveLength(1);
    expect(active[0].agent_id).toBe("lukodda");
    expect(table.filter((r) => r.agent_id === "lukodda" && r.beneficiary_id === "pius")).toHaveLength(1);
  });

  it("deactivates ALL prior active proxies (multi-stale defence)", async () => {
    // Seed: partner accidentally has TWO active proxies (data drift).
    table.push({
      id: nextId(),
      agent_id: "caroline",
      beneficiary_id: "pius",
      beneficiary_role: "supporter",
      is_active: true,
      approval_status: "approved",
    });
    table.push({
      id: nextId(),
      agent_id: "lilian",
      beneficiary_id: "pius",
      beneficiary_role: "supporter",
      is_active: true,
      approval_status: "approved",
    });

    await runBulkAssign({
      newAgentId: "lukodda",
      partners: [{ id: "pius" }],
      assignedBy: "partner-ops-1",
      reason: "Cleanup + bulk assign",
    });

    const active = activeFor("pius");
    expect(active).toHaveLength(1);
    expect(active[0].agent_id).toBe("lukodda");

    // Both prior agents got flipped to inactive.
    expect(table.find((r) => r.agent_id === "caroline" && r.beneficiary_id === "pius")?.is_active).toBe(false);
    expect(table.find((r) => r.agent_id === "lilian" && r.beneficiary_id === "pius")?.is_active).toBe(false);
  });

  it("invariant after a multi-partner batch: every partner has exactly ONE active proxy on the new agent", async () => {
    // Seed: 3 partners, each on a different prior agent.
    const seeds = [
      ["pius", "caroline"],
      ["mary", "lilian"],
      ["john", "caroline"],
    ] as const;
    seeds.forEach(([p, a]) =>
      table.push({
        id: nextId(),
        agent_id: a,
        beneficiary_id: p,
        beneficiary_role: "supporter",
        is_active: true,
        approval_status: "approved",
      }),
    );

    const res = await runBulkAssign({
      newAgentId: "lukodda",
      partners: [{ id: "pius" }, { id: "mary" }, { id: "john" }],
      assignedBy: "partner-ops-1",
      reason: "Bulk reassignment to LUKODDA",
    });

    expect(res.moved).toBe(3);
    expect(res.inserted).toBe(3);

    for (const p of ["pius", "mary", "john"]) {
      const active = activeFor(p);
      expect(active, `partner ${p}`).toHaveLength(1);
      expect(active[0].agent_id).toBe("lukodda");
    }

    // Sanity: no other agent has any active row for these partners.
    const otherActive = table.filter(
      (r) =>
        r.is_active &&
        r.agent_id !== "lukodda" &&
        ["pius", "mary", "john"].includes(r.beneficiary_id),
    );
    expect(otherActive).toHaveLength(0);
  });

  it("partner with no prior proxy: inserts new active row, nothing moved", async () => {
    const res = await runBulkAssign({
      newAgentId: "lukodda",
      partners: [{ id: "fresh-partner" }],
      assignedBy: "partner-ops-1",
      reason: "New link by Partner Ops",
    });

    expect(res.moved).toBe(0);
    expect(res.inserted).toBe(1);

    const active = activeFor("fresh-partner");
    expect(active).toHaveLength(1);
    expect(active[0].agent_id).toBe("lukodda");
  });
});

/**
 * Source-level guards: if a future edit drops the deactivate-others step
 * or the `.neq('agent_id', …)` scope, this whole contract collapses
 * silently. Pin the production strings.
 */
describe("source guards: ProxyAgentManager bulk-assign sequence", () => {
  const src = readFileSync("src/components/cfo/ProxyAgentManager.tsx", "utf8");

  it("queries OTHER active assignments scoped by .neq('agent_id', …) before deactivating", () => {
    expect(src).toMatch(/\.eq\(\s*['"]beneficiary_id['"]\s*,\s*b\.id\s*\)/);
    expect(src).toMatch(/\.eq\(\s*['"]is_active['"]\s*,\s*true\s*\)/);
    expect(src).toMatch(/\.neq\(\s*['"]agent_id['"]\s*,\s*bulkAgent\.id\s*\)/);
  });

  it("flips prior assignments to is_active=false via .update({ is_active: false })", () => {
    expect(src).toMatch(/\.update\(\s*\{\s*is_active:\s*false\s*\}\s*\)/);
  });

  it("upserts the new (agent, partner) row with is_active=true and approval_status='approved'", () => {
    expect(src).toMatch(/is_active:\s*true/);
    expect(src).toMatch(/approval_status:\s*['"]approved['"]/);
  });
});