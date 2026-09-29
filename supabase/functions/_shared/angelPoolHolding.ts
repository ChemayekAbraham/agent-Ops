// Builds an investor's full Angel Pool shareholding for the purchase email.
// Read-only: sums the investor's confirmed angel_pool_investments rows.
// Best-effort — returns {} on any error so a failed read never blocks the email.
export async function getAngelPoolHolding(adminClient: any, investorId: string): Promise<Record<string, unknown>> {
  try {
    const { data, error } = await adminClient
      .from("angel_pool_investments")
      .select("reference_id, shares, amount, pool_ownership_percent, company_ownership_percent, created_at, funded_by")
      .eq("investor_id", investorId)
      .eq("status", "confirmed")
      .order("created_at", { ascending: true })
      .limit(200);
    if (error || !data?.length) return {};
    const n = (v: unknown) => Number(v) || 0;
    const totalShares = data.reduce((s: number, r: any) => s + n(r.shares), 0);
    const totalInvested = data.reduce((s: number, r: any) => s + n(r.amount), 0);
    const totalPool = data.reduce((s: number, r: any) => s + n(r.pool_ownership_percent), 0);
    const totalCompany = data.reduce((s: number, r: any) => s + n(r.company_ownership_percent), 0);
    return {
      holding_total_shares: totalShares,
      holding_total_invested: totalInvested,
      holding_pool_percentage: totalPool.toFixed(4),
      holding_company_percentage: totalCompany.toFixed(4),
      holding_purchase_count: data.length,
      holding_purchases: data.map((r: any) => ({
        reference: r.reference_id,
        date: new Date(r.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
        shares: n(r.shares),
        amount: n(r.amount),
      })),
    };
  } catch (err) {
    console.error("[angelPoolHolding] failed:", err);
    return {};
  }
}
