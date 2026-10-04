/**
 * Contributed principal = money the partner actually put in
 * (creation amount + prior top-ups), EXCLUDING ROI that was
 * compounded into investor_portfolios.investment_amount.
 *
 * roi_compounded events are logged in audit_logs
 * (table_name = 'investor_portfolios', record_id = portfolio id,
 *  metadata.roi_amount = the ROI folded into principal).
 *
 * IMPORTANT: a manual `edit_investment_portfolio` that changes
 * investment_amount re-baselines principal — whoever edited the amount has
 * already decided what the principal is (they may have stripped past
 * compounds out themselves). Subtracting compounds logged BEFORE that edit
 * would double-count them, so only compounds recorded AFTER the most recent
 * amount-changing manual edit are subtracted.
 */
export async function getContributedPrincipal(
  supabase: any,
  portfolioId: string,
  currentInvestmentAmount: number,
): Promise<number> {
  const current = Number(currentInvestmentAmount) || 0;
  try {
    // 1. Find the most recent manual edit that actually changed the amount.
    const { data: edits, error: editErr } = await supabase
      .from("audit_logs")
      .select("created_at, metadata")
      .eq("action_type", "edit_investment_portfolio")
      .eq("table_name", "investor_portfolios")
      .eq("record_id", portfolioId)
      .order("created_at", { ascending: false });
    if (editErr) throw editErr;
    let baselineAt: string | null = null;
    for (const row of edits ?? []) {
      const change = row?.metadata?.changes?.investment_amount;
      const from = Number(change?.from);
      const to = Number(change?.to);
      if (change && Number.isFinite(from) && Number.isFinite(to) && from !== to) {
        baselineAt = row.created_at;
        break;
      }
    }

    // 2. Sum only the compounds logged after that baseline.
    let query = supabase
      .from("audit_logs")
      .select("metadata")
      .eq("action_type", "roi_compounded")
      .eq("table_name", "investor_portfolios")
      .eq("record_id", portfolioId);
    if (baselineAt) query = query.gt("created_at", baselineAt);
    const { data, error } = await query;
    if (error) throw error;
    const compounded = (data ?? []).reduce(
      (sum: number, row: any) => sum + (Number(row?.metadata?.roi_amount) || 0),
      0,
    );
    return Math.max(0, current - compounded);
  } catch (e) {
    console.warn("[contributed-principal] fallback to raw investment_amount:", e);
    return current;
  }
}
