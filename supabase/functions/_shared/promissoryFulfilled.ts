// A promissory note is fulfilled once its partner has come in with money: the note is linked to the
// partner's account and that account holds an active portfolio. WHEN the portfolio was opened does not
// matter. Since 2026-10-23 a note recorded after the money arrived still earns its commission (a "late
// note"), so agents record notes for partners who already funded. The old test only counted a portfolio
// opened on or after the day before the note, and kept texting those partners that their promise was
// unfulfilled (18 funded partners on 2026-11-09).
// Reminders (to the proxy agent or the partner) must never chase a fulfilled note, even while the note
// itself is still waiting for Partner Ops approval.

const ID_CHUNK = 100;
const PAGE = 1000; // PostgREST returns at most 1,000 rows per request.

// deno-lint-ignore no-explicit-any
export async function dropFulfilledNotes<T extends { partner_user_id?: string | null }>(admin: any, notes: T[]): Promise<{ open: T[]; fulfilled: number }> {
  const ids = [...new Set(notes.map((n) => n.partner_user_id).filter(Boolean))] as string[];
  if (ids.length === 0) return { open: notes, fulfilled: 0 };

  const funded = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin.from("investor_portfolios")
        .select("investor_id").eq("status", "active").in("investor_id", chunk)
        .order("investor_id").range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      for (const p of data ?? []) funded.add(p.investor_id);
      if ((data ?? []).length < PAGE) break;
    }
  }

  const open = notes.filter((n) => !n.partner_user_id || !funded.has(n.partner_user_id));
  return { open, fulfilled: notes.length - open.length };
}
