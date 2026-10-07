// A promissory note is fulfilled once its partner has come in: the partner has an
// active portfolio opened on or after the day before the note was recorded.
// Reminders (to the proxy agent or the partner) must never chase a fulfilled note,
// even while the note itself is still waiting for Partner Ops approval.
// deno-lint-ignore no-explicit-any
export async function dropFulfilledNotes<T extends { partner_user_id?: string | null; created_at: string }>(admin: any, notes: T[]): Promise<{ open: T[]; fulfilled: number }> {
  const ids = [...new Set(notes.map((n) => n.partner_user_id).filter(Boolean))] as string[];
  if (ids.length === 0) return { open: notes, fulfilled: 0 };
  const since = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from("investor_portfolios")
      .select("investor_id, created_at").eq("status", "active").in("investor_id", ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const p of data ?? []) {
      const list = since.get(p.investor_id) ?? [];
      list.push(p.created_at);
      since.set(p.investor_id, list);
    }
  }
  const open = notes.filter((n) => {
    if (!n.partner_user_id) return true;
    const floor = new Date(n.created_at).getTime() - 86_400_000;
    return !(since.get(n.partner_user_id) ?? []).some((c) => new Date(c).getTime() >= floor);
  });
  return { open, fulfilled: notes.length - open.length };
}
