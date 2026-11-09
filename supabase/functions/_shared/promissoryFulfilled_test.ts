// dropFulfilledNotes: which pending notes the partner and proxy-agent reminders may still chase.
// Run: deno test supabase/functions/_shared/promissoryFulfilled_test.ts
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dropFulfilledNotes } from "./promissoryFulfilled.ts";

type Portfolio = { investor_id: string; status: string; created_at: string };

/** investor_portfolios behind the PostgREST chain the helper uses, with the 1,000-row cap per request. */
function fakeAdmin(portfolios: Portfolio[], opts: { error?: string } = {}) {
  const calls: { ids: string[]; from: number; to: number }[] = [];
  const admin = {
    from(table: string) {
      if (table !== "investor_portfolios") throw new Error(`unexpected table ${table}`);
      let status = ""; let ids: string[] = [];
      const q = {
        select: () => q,
        eq: (_c: string, v: string) => { status = v; return q; },
        in: (_c: string, v: string[]) => { ids = v; return q; },
        order: () => q,
        range: (from: number, to: number) => {
          calls.push({ ids, from, to });
          if (opts.error) return Promise.resolve({ data: null, error: { message: opts.error } });
          const rows = portfolios
            .filter((p) => p.status === status && ids.includes(p.investor_id))
            .sort((a, b) => a.investor_id.localeCompare(b.investor_id))
            .slice(from, Math.min(to + 1, from + 1000))
            .map((p) => ({ investor_id: p.investor_id }));
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return q;
    },
  };
  return { admin, calls };
}

const note = (id: string, partner: string | null, created_at = "2026-11-02T10:00:00Z") =>
  ({ id, partner_user_id: partner, created_at });

Deno.test("late note: partner funded BEFORE the note was recorded -> fulfilled, not chased", async () => {
  const { admin } = fakeAdmin([{ investor_id: "p1", status: "active", created_at: "2026-09-01T00:00:00Z" }]);
  const { open, fulfilled } = await dropFulfilledNotes(admin, [note("n1", "p1", "2026-11-02T10:00:00Z")]);
  assertEquals(open, []);
  assertEquals(fulfilled, 1);
});

Deno.test("partner funded after the note -> fulfilled", async () => {
  const { admin } = fakeAdmin([{ investor_id: "p1", status: "active", created_at: "2026-11-05T00:00:00Z" }]);
  const { open } = await dropFulfilledNotes(admin, [note("n1", "p1")]);
  assertEquals(open, []);
});

Deno.test("linked partner with no active portfolio (redeemed, cancelled, awaiting Ops, locked) -> still open", async () => {
  const { admin } = fakeAdmin([
    { investor_id: "p1", status: "redeemed", created_at: "2026-09-01T00:00:00Z" },
    { investor_id: "p1", status: "cancelled", created_at: "2026-09-01T00:00:00Z" },
    { investor_id: "p1", status: "pending_ops_approval", created_at: "2026-11-03T00:00:00Z" },
    { investor_id: "p1", status: "locked", created_at: "2026-11-03T00:00:00Z" },
  ]);
  const { open, fulfilled } = await dropFulfilledNotes(admin, [note("n1", "p1")]);
  assertEquals(open.map((n) => n.id), ["n1"]);
  assertEquals(fulfilled, 0);
});

Deno.test("note not linked to an account -> open, and no query is made", async () => {
  const { admin, calls } = fakeAdmin([]);
  const { open } = await dropFulfilledNotes(admin, [note("n1", null), note("n2", null)]);
  assertEquals(open.map((n) => n.id), ["n1", "n2"]);
  assertEquals(calls.length, 0);
});

Deno.test("mixed list keeps order and drops only funded partners' notes", async () => {
  const { admin } = fakeAdmin([
    { investor_id: "funded", status: "active", created_at: "2026-01-01T00:00:00Z" },
    { investor_id: "unfunded", status: "redeemed", created_at: "2026-01-01T00:00:00Z" },
  ]);
  const { open, fulfilled } = await dropFulfilledNotes(admin, [
    note("a", "funded"), note("b", null), note("c", "unfunded"), note("d", "funded"),
  ]);
  assertEquals(open.map((n) => n.id), ["b", "c"]);
  assertEquals(fulfilled, 2);
});

Deno.test("many partners and more than 1,000 portfolios: every funded partner is seen", async () => {
  // 250 partners (3 id chunks); partner p0 alone holds 1,500 active portfolios, so its chunk needs 2 pages.
  const portfolios: Portfolio[] = [];
  for (let i = 0; i < 1500; i++) portfolios.push({ investor_id: "p000", status: "active", created_at: "2026-01-01T00:00:00Z" });
  for (let i = 1; i < 250; i += 2) {
    portfolios.push({ investor_id: `p${String(i).padStart(3, "0")}`, status: "active", created_at: "2026-01-01T00:00:00Z" });
  }
  const notes = Array.from({ length: 250 }, (_, i) => note(`n${i}`, `p${String(i).padStart(3, "0")}`));
  const { admin, calls } = fakeAdmin(portfolios);
  const { open, fulfilled } = await dropFulfilledNotes(admin, notes);
  // Funded: p000 and the 125 odd-numbered partners. Open: the 124 even-numbered partners from p002.
  assertEquals(fulfilled, 126);
  assertEquals(open.length, 124);
  assertEquals(open.every((n) => Number(n.partner_user_id!.slice(1)) % 2 === 0 && n.partner_user_id !== "p000"), true);
  assertEquals(calls.every((c) => c.ids.length <= 100), true);
  assertEquals(calls.some((c) => c.from === 1000), true); // second page fetched for the heavy chunk
});

Deno.test("a database error stops the run instead of texting everyone", async () => {
  const { admin } = fakeAdmin([], { error: "boom" });
  await assertRejects(() => dropFulfilledNotes(admin, [note("n1", "p1")]), Error, "boom");
});
