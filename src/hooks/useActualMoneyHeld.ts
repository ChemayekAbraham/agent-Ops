import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cfoWalletTotalsOptions } from './cfoWalletTotals';
import { cfoReportRetry } from './cfoReportRetry';
import { supabase } from '@/integrations/supabase/client';

export interface ActualMoneyHeld {
  /** Live MTN Mobile Money line balance parsed from provider alerts. */
  mtn: number;
  /** Live Airtel Money line balance parsed from provider alerts. */
  airtel: number;
  /**
   * Cash collected and held in custody that has NOT been confirmed banked by a
   * verified banking event. Reported as "Cash in Custody — Not Yet Confirmed
   * Banked" and deliberately EXCLUDED from `total`.
   */
  cashAtHand: number;
  /** Alias of `cashAtHand`, named for the caption it is shown under. */
  custodyNotConfirmedBanked: number;
  /**
   * Cumulative total of verified cash deposits that Financial Ops marked as banked. This is a running sum of
   * deposits INTO the bank and is never reduced by money paid out, so it is NOT a bank balance (CFO review
   * 9 Nov 2026: 4.36B against an emailed Equity balance of tens of millions).
   */
  bankedCash: number;
  /** Equity account balance from bank emails since the reconciliation cutoff (credits in less debits out). */
  bankReconciliation: number;
  /** Bank balance used in Money We Have: the email-derived Equity balance. */
  bankBalance: number;
  /** True when a confirmed balance (fin_bank_anchors) exists at the date the bank-email count starts from. */
  bankAnchored: boolean;
  /** Plain-language description of that anchor, e.g. "opening balance UGX 0 on 07 Oct 2026, confirmed by the CFO". */
  bankAnchorNote: string | null;
  /** MTN + Airtel + bank balance (email-derived). Custody is excluded until banking is verified. */
  total: number;

  /** Number of verified banked deposits behind `bankedCash`. */
  bankedCashCount: number;
  /** When the banked-cash figure was computed (server time). */
  bankedComputedAt: string | null;
  /** Latest Financial Ops verification timestamp inside the banked set. */
  bankedLastMovementAt: string | null;
  /** Banked total recomputed straight from the Financial Ops verifications. */
  finOpsBankedCash: number;
  /** Movement count recomputed straight from the Financial Ops verifications. */
  finOpsBankedCount: number;
  /** finOpsBankedCash − bankedCash (0 when the two agree). */
  bankedDifference: number;
  /** True when the card figure matches Financial Ops to the shilling. */
  bankedInSync: boolean;
  /** Real float currently sitting in agent wallets (company money with agents). */
  agentFloatHeld: number;
  /** MTN + Airtel + verified cash at hand — real money held outside the bank. */
  outsideBankHeld: number;
}

/**
 * Real money the platform holds right now, mirroring the "Actual Float"
 * bucket on the Financial Ops Wallet Buckets page.
 *
 * Banked cash is the verified deposit total where Financial Ops set
 * `purpose_audit.cash_location = 'bank'`, i.e. the real cash at bank.
 * The email-derived bank reconciliation is kept as a separate reference figure
 * and is never added to the headline.
 */
export function useActualMoneyHeld(enabled = true) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['cfo-actual-money-held'],
    enabled,
    retry: cfoReportRetry,
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async (): Promise<ActualMoneyHeld> => {
      const [phoneRes, cashRes, bankRes, anchorRes, w, verification] = await Promise.all([
        supabase.rpc('get_phone_platform_reconciliation' as any),
        supabase.rpc('get_cash_at_hand_total' as any),
        supabase.rpc('get_money_at_bank_reconciliation' as any),
        // Confirmed bank balance at the email-count start date (CFO, 10 Nov 2026). Optional: a failure here only
        // means the bank line is shown as not anchored.
        supabase.rpc('fin_bank_anchor', { p_account_key: 'equity' }),
        // The enclosing query owns retries; do not multiply retry budgets.
        queryClient.fetchQuery({ ...cfoWalletTotalsOptions(), retry: false }),
        (async () => {
          // Independent cross-check: rebuild the banked total from the Financial Ops
          // verifications themselves (latest verification per deposit request, status
          // 'verified', cash_location = 'bank') so the card can say whether it is in
          // sync rather than just asserting it.
          const verifications: any[] = [];
          for (let page = 0; page < 20; page += 1) {
            const from = page * 1000;
            const { data: chunk, error } = await supabase
              .from('cash_deposit_verifications')
              .select('id, amount, status, verified_at, created_at, deposit_request_id, deposit_requests!inner(purpose_audit)')
              .order('created_at', { ascending: false })
              .range(from, from + 999);
            if (error) throw error;
            const rows = (chunk ?? []) as any[];
            verifications.push(...rows);
            if (rows.length < 1000) break;
          }

          const latest = new Map<string, any>();
          for (const v of verifications) {
            const key = String(v.deposit_request_id);
            if (!latest.has(key)) latest.set(key, v);
          }
          const banked = Array.from(latest.values()).filter((v: any) => {
            if (v.status !== 'verified') return false;
            const loc = (v.deposit_requests?.purpose_audit?.cash_location ?? 'cash_at_hand') as string;
            return loc === 'bank';
          });

          const finOpsBankedCash = banked.reduce((sum: number, v: any) => sum + Number(v.amount ?? 0), 0);
          const bankedLastMovementAt = banked.reduce<string | null>((latestAt, v: any) => {
            const at = (v.verified_at ?? v.created_at) as string | null;
            if (!at) return latestAt;
            if (!latestAt || new Date(at).getTime() > new Date(latestAt).getTime()) return at;
            return latestAt;
          }, null);

          return { banked, finOpsBankedCash, bankedLastMovementAt };
        })(),
      ]);
      if (phoneRes.error) throw phoneRes.error;
      if (cashRes.error) throw cashRes.error;
      if (bankRes.error) throw bankRes.error;
      const p = (phoneRes.data ?? {}) as any;
      const c = (cashRes.data ?? {}) as any;
      const b = (bankRes.data ?? {}) as any;
      const mtn = Number(p.mtn_balance ?? 0);
      const airtel = Number(p.airtel_balance ?? 0);
      const cashAtHand = Number(c.cash_at_hand_total ?? 0);
      const bankedCash = Number(b.banked_cash_reference ?? 0);
      const bankReconciliation = Number(b.money_at_bank_total ?? 0);
      const { banked, finOpsBankedCash, bankedLastMovementAt } = verification;

      const anchor = (anchorRes?.error ? null : (anchorRes?.data ?? null)) as
        { anchor_at?: string; balance?: number | string; source?: string } | null;
      const cutoff = (b.email_cutoff_at as string | undefined) ?? null;
      const bankAnchored = !!(anchor?.anchor_at && cutoff
        && Math.abs(new Date(anchor.anchor_at).getTime() - new Date(cutoff).getTime()) < 1000);
      const bankAnchorNote = bankAnchored && anchor?.anchor_at
        ? `opening balance UGX ${Number(anchor.balance ?? 0).toLocaleString('en-US')} on ${new Date(anchor.anchor_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala' })}, ${anchor.source === 'bank_statement' ? 'per bank statement' : 'confirmed by the CFO'}`
        : null;

      const bankedDifference = finOpsBankedCash - bankedCash;

      return {
        mtn,
        airtel,
        cashAtHand,
        bankedCash,
        bankReconciliation,
        custodyNotConfirmedBanked: cashAtHand,
        bankBalance: bankReconciliation,
        bankAnchored,
        bankAnchorNote,
        // Custody cash is NOT company cash we can spend: no verified banking
        // event exists for it, so it is reported under its own caption and kept
        // out of every "Money We Have" / available-cash figure. The bank line is the
        // email-derived Equity balance, not the cumulative banked-deposit total.
        total: mtn + airtel + bankReconciliation,

        bankedCashCount: Number(b.banked_cash_reference_count ?? banked.length),
        bankedComputedAt: (b.computed_at as string | undefined) ?? null,
        bankedLastMovementAt,
        finOpsBankedCash,
        finOpsBankedCount: banked.length,
        bankedDifference,
        bankedInSync: Math.abs(bankedDifference) < 1,
        agentFloatHeld: Number(w.total_float ?? 0),
        outsideBankHeld: mtn + airtel + cashAtHand,
      };
    },
  });
}
