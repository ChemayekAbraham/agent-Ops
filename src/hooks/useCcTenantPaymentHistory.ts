/**
 * Read-only payment history for ONE tenant, for the Calling Center details view.
 *
 * Identity: the Calling Center subject id IS `profiles.id` / `rent_requests.tenant_id`
 * — the same primary key Classic → All Tenants resolves tenants by. Every read
 * here is keyed on that id (and then on the plan ids that belong to it). No name,
 * phone or fuzzy matching, ever.
 *
 * Sources are the same authoritative receipt tables Tenant Ops → Agent Monitoring
 * reads: `agent_collections` (whichever agent keyed the receipt in) and
 * `repayments` (tenant self-payments and the other supported channels), paired
 * with the shared `unmatchedRepayments` rule so the same money is never listed
 * twice. Plan figures (`total_repayment`, `amount_repaid`, `daily_repayment`) are
 * shown as already stored — nothing is recalculated. `tenant_self_repayment_attempts`
 * supplies the failed / partial / surplus attempts that the system already records.
 *
 * Performance: three fixed queries (plans, collections, repayments) plus one for
 * recorded attempts — no per-row fetching, only the fields displayed.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { unmatchedRepayments } from '@/lib/rentReceipts';

export interface CcTenantReceipt {
  id: string;
  planId: string;
  at: string;
  amount: number;
  method: string | null;
  reference: string | null;
  source: 'agent' | 'tenant';
  agentId: string | null;
  isPartial: boolean | null;
  expectedAmount: number | null;
  provider: string | null;
}

export interface CcTenantPlan {
  id: string;
  status: string | null;
  rentAmount: number;
  totalRepayment: number;
  amountRepaid: number;
  dailyRepayment: number;
  frequency: string | null;
  durationDays: number | null;
  startedAt: string | null;
  createdAt: string;
  outstanding: number;
  receiptCount: number;
  receiptTotal: number;
}

export interface CcTenantAttempt {
  id: string;
  planId: string | null;
  at: string;
  outcome: string | null;
  reason: string | null;
  depositAmount: number;
  appliedAmount: number;
  surplusAmount: number;
}

export interface CcTenantPaymentHistory {
  plans: CcTenantPlan[];
  receipts: CcTenantReceipt[];
  attempts: CcTenantAttempt[];
  summary: {
    planCount: number;
    activePlanCount: number;
    totalCommitted: number;
    totalRepaidRecorded: number;
    outstanding: number;
    receiptTotal: number;
    receiptCount: number;
    lastPaymentAt: string | null;
    lastPaymentAmount: number | null;
  };
}

const ACTIVE = new Set(['funded', 'disbursed', 'repaying']);

export function useCcTenantPaymentHistory(tenantId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['cc-tenant-payment-history', tenantId],
    enabled: enabled && !!tenantId,
    staleTime: 60_000,
    queryFn: async (): Promise<CcTenantPaymentHistory> => {
      const client = supabase as any;

      // 1. Every rent plan belonging to this exact tenant id — all statuses, so a
      //    completed or rejected plan's receipts are never hidden.
      const { data: planRows, error: planErr } = await client
        .from('rent_requests')
        .select(
          'id, status, rent_amount, total_repayment, amount_repaid, daily_repayment, repayment_frequency, duration_days, created_at, disbursed_at, funded_at, repayment_starts_on',
        )
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });
      if (planErr) throw planErr;

      const raw = (planRows || []) as Record<string, any>[];
      const planIds = raw.map((r) => String(r.id));

      let receipts: CcTenantReceipt[] = [];
      if (planIds.length) {
        const [collected, repaid] = await Promise.all([
          client
            .from('agent_collections')
            .select(
              'id, rent_request_id, agent_id, amount, created_at, payment_method, is_partial, expected_amount, momo_provider, tracking_id',
            )
            .is('reversed_at', null)
            .in('rent_request_id', planIds)
            .order('created_at', { ascending: false }),
          client
            .from('repayments')
            .select('id, rent_request_id, amount, created_at, payment_method, external_reference')
            .in('rent_request_id', planIds)
            .order('created_at', { ascending: false }),
        ]);
        if (collected.error) throw collected.error;
        if (repaid.error) throw repaid.error;

        const collections = (collected.data || []) as Record<string, any>[];
        receipts = collections.map((r) => ({
          id: String(r.id),
          planId: String(r.rent_request_id),
          at: String(r.created_at),
          amount: Number(r.amount ?? 0),
          method: r.payment_method ?? null,
          reference: r.tracking_id ?? null,
          source: 'agent' as const,
          agentId: r.agent_id ?? null,
          isPartial: r.is_partial ?? null,
          expectedAmount: r.expected_amount === null || r.expected_amount === undefined ? null : Number(r.expected_amount),
          provider: r.momo_provider ?? null,
        }));

        unmatchedRepayments(
          (repaid.data || []) as { id: string; rent_request_id: string | null; amount: number | null; created_at: string; payment_method: string | null; external_reference: string | null }[],
          collections as { rent_request_id: string | null; amount: number | null; created_at: string }[],
        ).forEach((r) => {
          receipts.push({
            id: String(r.id),
            planId: String(r.rent_request_id),
            at: String(r.created_at),
            amount: Number(r.amount ?? 0),
            method: r.payment_method ?? null,
            reference: r.external_reference ?? null,
            source: 'tenant',
            agentId: null,
            isPartial: null,
            expectedAmount: null,
            provider: null,
          });
        });

        receipts.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      }

      // 2. Attempts the system already recorded (failed / partial / surplus).
      const { data: attemptRows } = await client
        .from('tenant_self_repayment_attempts')
        .select('id, rent_request_id, outcome, reason, deposit_amount, applied_amount, surplus_amount, created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(30);

      const attempts: CcTenantAttempt[] = ((attemptRows || []) as Record<string, any>[]).map((r) => ({
        id: String(r.id),
        planId: r.rent_request_id ? String(r.rent_request_id) : null,
        at: String(r.created_at),
        outcome: r.outcome ?? null,
        reason: r.reason ?? null,
        depositAmount: Number(r.deposit_amount ?? 0),
        appliedAmount: Number(r.applied_amount ?? 0),
        surplusAmount: Number(r.surplus_amount ?? 0),
      }));

      const byPlan = new Map<string, { count: number; total: number }>();
      receipts.forEach((r) => {
        const cur = byPlan.get(r.planId) ?? { count: 0, total: 0 };
        cur.count += 1;
        cur.total += r.amount;
        byPlan.set(r.planId, cur);
      });

      const plans: CcTenantPlan[] = raw.map((r) => {
        const total = Number(r.total_repayment ?? 0);
        const repaid = Number(r.amount_repaid ?? 0);
        const agg = byPlan.get(String(r.id)) ?? { count: 0, total: 0 };
        return {
          id: String(r.id),
          status: r.status ?? null,
          rentAmount: Number(r.rent_amount ?? 0),
          totalRepayment: total,
          amountRepaid: repaid,
          dailyRepayment: Number(r.daily_repayment ?? 0),
          frequency: r.repayment_frequency ?? null,
          durationDays: r.duration_days === null || r.duration_days === undefined ? null : Number(r.duration_days),
          startedAt: r.repayment_starts_on || r.disbursed_at || r.funded_at || null,
          createdAt: String(r.created_at),
          outstanding: total - repaid,
          receiptCount: agg.count,
          receiptTotal: agg.total,
        };
      });

      const active = plans.filter((p) => p.status && ACTIVE.has(p.status));
      const counted = active.length ? active : plans;

      return {
        plans,
        receipts,
        attempts,
        summary: {
          planCount: plans.length,
          activePlanCount: active.length,
          totalCommitted: counted.reduce((s, p) => s + p.totalRepayment, 0),
          totalRepaidRecorded: counted.reduce((s, p) => s + p.amountRepaid, 0),
          outstanding: counted.reduce((s, p) => s + p.outstanding, 0),
          receiptTotal: receipts.reduce((s, r) => s + r.amount, 0),
          receiptCount: receipts.length,
          lastPaymentAt: receipts[0]?.at ?? null,
          lastPaymentAmount: receipts[0]?.amount ?? null,
        },
      };
    },
  });
}
