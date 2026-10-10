// Shared repayment routing for lending-agent loans.
// KEEP IN SYNC with supabase/functions/lending-borrower-pay/floatSplit.ts.
//
// Float-funded loans (funding_source = 'float'):
//  * every payment is split proportionally into principal and interest
//  * principal -> lender operational float; interest -> lender withdrawable
//  * borrower principal is taken from their float first, then withdrawable;
//    borrower interest is taken from withdrawable only, so company float can
//    never be turned into the lender's withdrawable earnings.
// Legacy loans (funding_source = 'withdrawable') keep withdrawable -> withdrawable.

export const FLOAT_LOAN_MAX_UGX = 5_000_000;
export const FLOAT_LOAN_DAILY_MAX_UGX = 10_000_000;

const n = (v: unknown) => Math.max(0, Math.floor(Number(v ?? 0) || 0));

export function totalOwed(loan: any): number {
  const p = Number(loan.principal_ugx) || 0;
  return Math.round(p + (p * (Number(loan.interest_rate_pct) || 0)) / 100);
}

export function remainingParts(loan: any) {
  const principal = Math.round(Number(loan.principal_ugx) || 0);
  const interest = Math.max(0, totalOwed(loan) - principal);
  return {
    principalLeft: Math.max(0, principal - n(loan.principal_repaid_ugx)),
    interestLeft: Math.max(0, interest - n(loan.interest_repaid_ugx)),
  };
}

export function splitAmount(loan: any, amount: number) {
  const { principalLeft, interestLeft } = remainingParts(loan);
  const left = principalLeft + interestLeft;
  if (left <= 0) return { principal: 0, interest: 0 };
  let principal = Math.round((amount * principalLeft) / left);
  principal = Math.min(principal, principalLeft, amount);
  let interest = amount - principal;
  if (interest > interestLeft) { principal += interest - interestLeft; interest = interestLeft; }
  return { principal, interest };
}

export interface RepaymentPlan {
  amount: number;
  principal: number;
  interest: number;
  fromFloat: number;
  fromWithdrawable: number;
  available: { float: number; withdrawable: number };
}

export async function planRepayment(admin: any, loan: any, target: number): Promise<RepaymentPlan> {
  const isFloat = loan.funding_source === "float";
  const { data: w, error: we } = await admin.rpc("get_user_available_balance", { p_user_id: loan.borrower_user_id });
  if (we) throw we;
  const W = n(w);
  if (!isFloat) {
    const amount = Math.min(n(target), W);
    return { amount, principal: 0, interest: 0, fromFloat: 0, fromWithdrawable: amount, available: { float: 0, withdrawable: W } };
  }
  const { data: f, error: fe } = await admin.rpc("get_user_float_available_balance", { p_user_id: loan.borrower_user_id });
  if (fe) throw fe;
  const F = n(f);
  const feasible = (x: number) => {
    const s = splitAmount(loan, x);
    const pf = Math.min(s.principal, F);
    return s.interest + (s.principal - pf) <= W;
  };
  let lo = 0, hi = n(target);
  if (feasible(hi)) lo = hi;
  else {
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (feasible(mid)) lo = mid; else hi = mid - 1; }
  }
  const s = splitAmount(loan, lo);
  const pf = Math.min(s.principal, F);
  return { amount: lo, principal: s.principal, interest: s.interest, fromFloat: pf, fromWithdrawable: s.interest + (s.principal - pf), available: { float: F, withdrawable: W } };
}

export function repaymentLegs(loan: any, plan: RepaymentPlan, o: { ref: string; now: string; borrowerDesc: string; lenderDesc: string; borrowerLabel: string }) {
  const base = { category: "wallet_transfer", ledger_scope: "wallet", source_table: "lending_agent_loans", source_id: loan.id, currency: "UGX", transaction_date: o.now, reference_id: o.ref };
  const legs: any[] = [];
  if (loan.funding_source !== "float") {
    legs.push({ ...base, user_id: loan.borrower_user_id, amount: plan.amount, direction: "cash_out", description: o.borrowerDesc, linked_party: "Lending agent", recipient_type: "user" });
    legs.push({ ...base, user_id: loan.lender_agent_id, amount: plan.amount, direction: "cash_in", description: o.lenderDesc, linked_party: o.borrowerLabel, recipient_type: "user" });
    return legs;
  }
  if (plan.fromFloat > 0) legs.push({ ...base, user_id: loan.borrower_user_id, amount: plan.fromFloat, direction: "cash_out", description: `${o.borrowerDesc} (principal, float) float_usage=lending_float_repayment`, linked_party: "Lending agent", recipient_type: "operational_wallet" });
  if (plan.fromWithdrawable > 0) legs.push({ ...base, user_id: loan.borrower_user_id, amount: plan.fromWithdrawable, direction: "cash_out", description: `${o.borrowerDesc} (wallet)`, linked_party: "Lending agent", recipient_type: "user" });
  if (plan.principal > 0) legs.push({ ...base, user_id: loan.lender_agent_id, amount: plan.principal, direction: "cash_in", description: `${o.lenderDesc} (principal back to float) float_usage=lending_float_repayment`, linked_party: o.borrowerLabel, recipient_type: "operational_wallet" });
  if (plan.interest > 0) legs.push({ ...base, user_id: loan.lender_agent_id, amount: plan.interest, direction: "cash_in", description: `${o.lenderDesc} (interest)`, linked_party: o.borrowerLabel, recipient_type: "user" });
  return legs;
}

export function splitColumns(loan: any, plan: RepaymentPlan) {
  if (loan.funding_source !== "float") return {};
  return {
    principal_repaid_ugx: n(loan.principal_repaid_ugx) + plan.principal,
    interest_repaid_ugx: n(loan.interest_repaid_ugx) + plan.interest,
  };
}
