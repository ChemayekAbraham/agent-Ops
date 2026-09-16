import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { subDays, format, startOfDay } from 'date-fns';
import type { ReportActivity, Severity } from './COOReportPage';

/**
 * Shared data layer for the four COO Reports pages.
 *
 * Each hook returns a normalised `ReportActivity[]` plus pre-computed
 * aggregates so the page components can stay declarative. Data sources
 * are the production tables — no placeholder math.
 *
 * Window: last 30 days. The page-level date filter narrows further client-side.
 */

const WINDOW_DAYS = 30;
const MAX_ROWS = 200;

function sinceISO(days = WINDOW_DAYS) {
  return startOfDay(subDays(new Date(), days)).toISOString();
}

function nameOf(p?: { full_name?: string | null; phone?: string | null } | null): string {
  if (!p) return 'Unknown';
  return p.full_name || p.phone || 'Unknown';
}

function statusKindFor(status: string): Severity {
  const s = status.toLowerCase();
  if (['approved', 'completed', 'paid', 'active', 'verified'].some((k) => s.includes(k))) return 'success';
  if (['rejected', 'failed', 'cancelled', 'missing', 'default'].some((k) => s.includes(k))) return 'destructive';
  if (['pending', 'review', 'awaiting', 'processing', 'submitted'].some((k) => s.includes(k))) return 'warning';
  return 'neutral';
}

function buildTrend(rows: { created_at: string }[], days = 14) {
  const out: { label: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = subDays(new Date(), i);
    const key = format(d, 'yyyy-MM-dd');
    const count = rows.filter((r) => r.created_at?.slice(0, 10) === key).length;
    out.push({ label: format(d, 'd MMM'), count });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Partner Ops
// ─────────────────────────────────────────────────────────────────────────────

export function usePartnerOpsReportData() {
  return useQuery({
    queryKey: ['coo-report', 'partner-ops'],
    staleTime: 60_000,
    queryFn: async () => {
      const since = sinceISO();

      const [portfoliosRes, withdrawalsRes] = await Promise.all([
        supabase
          .from('investor_portfolios')
          .select('id, portfolio_code, investment_amount, status, cfo_verified, cfo_rejection_reason, created_at, investor_id, agent_id, payment_method, account_name, bank_account_name')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(MAX_ROWS),
        supabase
          .from('investment_withdrawal_requests')
          .select('id, amount, status, created_at, user_id, rejection_reason')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(MAX_ROWS),
      ]);

      const portfolios = portfoliosRes.data ?? [];
      const withdrawals = withdrawalsRes.data ?? [];

      const userIds = Array.from(
        new Set(
          [
            ...portfolios.map((p: any) => p.investor_id).filter(Boolean),
            ...withdrawals.map((w: any) => w.user_id).filter(Boolean),
          ] as string[],
        ),
      );
      const profilesMap: Record<string, { full_name: string | null; phone: string | null }> = {};
      if (userIds.length) {
        const { data: profiles, error: profilesErr } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', userIds);
        if (profilesErr) throw profilesErr;
        (profiles ?? []).forEach((p: any) => (profilesMap[p.id] = { full_name: p.full_name, phone: p.phone }));
      }

      const activities: ReportActivity[] = [
        ...portfolios.map((p: any) => {
          const status = p.cfo_verified ? 'Verified' : p.cfo_rejection_reason ? 'Rejected' : (p.status ?? 'Pending');
          return {
            id: `PRT-${p.id.slice(0, 8)}`,
            type: 'New portfolio',
            // Profile name first; fall back to the payout account name captured
            // on the portfolio itself so a row is never labelled "Unknown".
            person:
              profilesMap[p.investor_id]?.full_name ||
              p.account_name ||
              p.bank_account_name ||
              profilesMap[p.investor_id]?.phone ||
              'Unknown',
            amount: Number(p.investment_amount ?? 0),
            status,
            statusKind: statusKindFor(status),
            date: p.created_at,
            staff: p.cfo_verified ? 'CFO' : 'Partner Ops',
            reference: p.portfolio_code,
            details: { department: 'Partner Ops', payment_method: p.payment_method ?? '—', rejection: p.cfo_rejection_reason ?? null },
          } as ReportActivity;
        }),
        ...withdrawals.map((w: any) => ({
          id: `WIT-${w.id.slice(0, 8)}`,
          type: 'Withdrawal request',
          person: nameOf(profilesMap[w.user_id]),
          amount: Number(w.amount ?? 0),
          status: (w.status ?? 'pending').replace(/_/g, ' '),
          statusKind: statusKindFor(w.status ?? 'pending'),
          date: w.created_at,
          staff: 'Financial Ops',
          reference: w.id.slice(0, 8),
          details: { department: 'Financial Ops', rejection: w.rejection_reason ?? null },
        } as ReportActivity)),
      ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      const totalAum = portfolios.reduce((s: number, p: any) => s + Number(p.investment_amount ?? 0), 0);
      const verified = portfolios.filter((p: any) => p.cfo_verified).length;
      const pendingReview = portfolios.filter((p: any) => !p.cfo_verified && !p.cfo_rejection_reason).length;
      const rejected = portfolios.filter((p: any) => !!p.cfo_rejection_reason).length;
      const pendingWithdrawals = withdrawals.filter((w: any) => (w.status ?? 'pending') === 'pending').length;
      const pendingWithdrawalAmt = withdrawals
        .filter((w: any) => (w.status ?? 'pending') === 'pending')
        .reduce((s: number, w: any) => s + Number(w.amount ?? 0), 0);

      return {
        activities,
        kpis: {
          totalPortfolios: portfolios.length,
          totalAum,
          verified,
          pendingReview,
          rejected,
          pendingWithdrawals,
          pendingWithdrawalAmt,
        },
        trend: buildTrend(portfolios, 14),
      };
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Ops
// ─────────────────────────────────────────────────────────────────────────────

export function useAgentOpsReportData() {
  return useQuery({
    queryKey: ['coo-report', 'agent-ops'],
    staleTime: 60_000,
    queryFn: async () => {
      const since = sinceISO();

      const [collectionsRes, advancesRes, depositsRes] = await Promise.all([
        supabase
          .from('agent_collections')
          .select('id, agent_id, tenant_id, amount, payment_method, location_name, created_at').is('reversed_at', null)
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(MAX_ROWS),
        supabase
          .from('agent_advance_requests_privileged')
          .select('id, agent_id, principal, total_payable, status, reason, created_at')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(MAX_ROWS),
        supabase
          .from('wallet_deposits')
          .select('id, agent_id, user_id, amount, deposit_type, created_at')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(MAX_ROWS),
      ]);

      const collections = collectionsRes.data ?? [];
      const advances = advancesRes.data ?? [];
      const deposits = depositsRes.data ?? [];

      const ids = Array.from(
        new Set(
          [
            ...collections.map((c: any) => c.agent_id),
            ...collections.map((c: any) => c.tenant_id),
            ...advances.map((a: any) => a.agent_id),
            ...deposits.map((d: any) => d.agent_id),
            ...deposits.map((d: any) => d.user_id),
          ].filter(Boolean) as string[],
        ),
      );
      const profilesMap: Record<string, any> = {};
      if (ids.length) {
        const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', ids);
        (data ?? []).forEach((p: any) => (profilesMap[p.id] = p));
      }

      const activities: ReportActivity[] = [
        ...collections.map((c: any) => ({
          id: `COL-${c.id.slice(0, 8)}`,
          type: 'Rent collection',
          person: nameOf(profilesMap[c.agent_id]),
          amount: Number(c.amount ?? 0),
          status: 'Recorded',
          statusKind: 'success' as Severity,
          date: c.created_at,
          staff: 'Field Agent',
          reference: c.id.slice(0, 8),
          details: { department: 'Agent Ops', tenant: nameOf(profilesMap[c.tenant_id]), method: c.payment_method, location: c.location_name ?? '—' },
        })),
        ...advances.map((a: any) => ({
          id: `ADV-${a.id.slice(0, 8)}`,
          type: 'Advance request',
          person: nameOf(profilesMap[a.agent_id]),
          amount: Number(a.principal ?? 0),
          status: (a.status ?? 'pending').replace(/_/g, ' '),
          statusKind: statusKindFor(a.status ?? 'pending'),
          date: a.created_at,
          staff: 'Agent Ops',
          reference: a.id.slice(0, 8),
          details: { department: 'Agent Ops', total_payable: Number(a.total_payable ?? 0), reason: a.reason },
        })),
        ...deposits.map((d: any) => ({
          id: `DEP-${d.id.slice(0, 8)}`,
          type: 'Wallet deposit',
          person: nameOf(profilesMap[d.agent_id]),
          amount: Number(d.amount ?? 0),
          status: 'Recorded',
          statusKind: 'success' as Severity,
          date: d.created_at,
          staff: 'Field Agent',
          reference: d.id.slice(0, 8),
          details: { department: 'Agent Ops', recipient: nameOf(profilesMap[d.user_id]), deposit_type: d.deposit_type },
        })),
      ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      const collectionsTotal = collections.reduce((s: number, c: any) => s + Number(c.amount ?? 0), 0);
      const depositsTotal = deposits.reduce((s: number, d: any) => s + Number(d.amount ?? 0), 0);
      const advancesPending = advances.filter((a: any) => (a.status ?? 'pending') === 'pending').length;
      const advancesApproved = advances.filter((a: any) => (a.status ?? '').includes('approved')).length;
      const uniqueAgents = new Set(collections.map((c: any) => c.agent_id)).size;

      // Top agents by collected volume
      const byAgent: Record<string, number> = {};
      collections.forEach((c: any) => {
        byAgent[c.agent_id] = (byAgent[c.agent_id] ?? 0) + Number(c.amount ?? 0);
      });
      const topAgents = Object.entries(byAgent)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([id, total]) => ({ label: nameOf(profilesMap[id]).slice(0, 14), value: Math.round(total) }));

      return {
        activities,
        kpis: {
          collectionsCount: collections.length,
          collectionsTotal,
          depositsCount: deposits.length,
          depositsTotal,
          advancesPending,
          advancesApproved,
          uniqueAgents,
        },
        trend: buildTrend(collections, 14),
        topAgents,
      };
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tenant Ops
// ─────────────────────────────────────────────────────────────────────────────

export function useTenantOpsReportData() {
  return useQuery({
    queryKey: ['coo-report', 'tenant-ops'],
    staleTime: 60_000,
    queryFn: async () => {
      const since = sinceISO();

      const { data: requests = [] } = await supabase
        .from('rent_requests')
        .select('id, tenant_id, agent_id, landlord_id, rent_amount, total_repayment, status, schedule_status, created_at, approved_at, funded_at, disbursed_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(MAX_ROWS);

      const ids = Array.from(
        new Set(
          [
            ...requests!.map((r: any) => r.tenant_id),
            ...requests!.map((r: any) => r.landlord_id),
          ].filter(Boolean) as string[],
        ),
      );
      const profilesMap: Record<string, any> = {};
      if (ids.length) {
        const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', ids);
        (data ?? []).forEach((p: any) => (profilesMap[p.id] = p));
      }

      const activities: ReportActivity[] = (requests ?? []).map((r: any) => ({
        id: `RNT-${r.id.slice(0, 8)}`,
        type: 'Rent plan request',
        person: nameOf(profilesMap[r.tenant_id]),
        amount: Number(r.rent_amount ?? 0),
        status: (r.status ?? 'pending').replace(/_/g, ' '),
        statusKind: statusKindFor(r.status ?? 'pending'),
        date: r.created_at,
        staff: 'Tenant Ops',
        reference: r.id.slice(0, 8),
        details: {
          department: 'Tenant Ops',
          landlord: nameOf(profilesMap[r.landlord_id]),
          total_repayment: Number(r.total_repayment ?? 0),
          schedule: r.schedule_status ?? '—',
        },
      }));

      const total = requests!.length;
      const pending = requests!.filter((r: any) => (r.status ?? 'pending') === 'pending').length;
      const approved = requests!.filter((r: any) => r.approved_at).length;
      const funded = requests!.filter((r: any) => r.funded_at).length;
      const disbursed = requests!.filter((r: any) => r.disbursed_at).length;
      const rejected = requests!.filter((r: any) => (r.status ?? '').toLowerCase().includes('reject')).length;
      const totalRent = requests!.reduce((s: number, r: any) => s + Number(r.rent_amount ?? 0), 0);

      const funnel = [
        { label: 'Submitted', value: total },
        { label: 'Approved', value: approved },
        { label: 'Funded', value: funded },
        { label: 'Disbursed', value: disbursed },
      ];

      return {
        activities,
        kpis: { total, pending, approved, funded, disbursed, rejected, totalRent },
        trend: buildTrend(requests as any[], 14),
        funnel,
      };
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Financial Ops
// ─────────────────────────────────────────────────────────────────────────────

export function useFinancialOpsReportData() {
  return useQuery({
    queryKey: ['coo-report', 'financial-ops'],
    staleTime: 60_000,
    queryFn: async () => {
      const since = sinceISO();

      const [withdrawalsRes, depositReqRes, walletDepRes] = await Promise.all([
        supabase
          .from('withdrawal_requests')
          .select('id, user_id, amount, status, payout_method, created_at, processed_at, manager_approved_at, cfo_approved_at, coo_approved_at, rejection_reason')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(MAX_ROWS),
        supabase
          .from('deposit_requests')
          .select('id, user_id, agent_id, amount, status, deposit_purpose, provider, created_at, approved_at, rejected_at, rejection_reason, auto_approved')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(MAX_ROWS),
        supabase
          .from('wallet_deposits')
          .select('id, user_id, amount, deposit_type, created_at')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(MAX_ROWS),
      ]);

      const withdrawals = withdrawalsRes.data ?? [];
      const depositReqs = depositReqRes.data ?? [];
      const walletDeps = walletDepRes.data ?? [];

      const ids = Array.from(
        new Set(
          [
            ...withdrawals.map((w: any) => w.user_id),
            ...depositReqs.map((d: any) => d.user_id),
            ...walletDeps.map((d: any) => d.user_id),
          ].filter(Boolean) as string[],
        ),
      );
      const profilesMap: Record<string, any> = {};
      if (ids.length) {
        const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', ids);
        (data ?? []).forEach((p: any) => (profilesMap[p.id] = p));
      }

      const activities: ReportActivity[] = [
        ...withdrawals.map((w: any) => ({
          id: `WTD-${w.id.slice(0, 8)}`,
          type: 'Withdrawal',
          person: nameOf(profilesMap[w.user_id]),
          amount: Number(w.amount ?? 0),
          status: (w.status ?? 'pending').replace(/_/g, ' '),
          statusKind: statusKindFor(w.status ?? 'pending'),
          date: w.created_at,
          staff: w.coo_approved_at ? 'COO' : w.cfo_approved_at ? 'CFO' : w.manager_approved_at ? 'Manager' : 'FinOps',
          reference: w.id.slice(0, 8),
          details: { department: 'Financial Ops', payout_method: w.payout_method, rejection: w.rejection_reason ?? null },
        })),
        ...depositReqs.map((d: any) => ({
          id: `DRQ-${d.id.slice(0, 8)}`,
          type: 'Deposit request',
          person: nameOf(profilesMap[d.user_id]),
          amount: Number(d.amount ?? 0),
          status: (d.status ?? 'pending').replace(/_/g, ' '),
          statusKind: statusKindFor(d.status ?? 'pending'),
          date: d.created_at,
          staff: d.auto_approved ? 'System' : 'FinOps',
          reference: d.id.slice(0, 8),
          details: { department: 'Financial Ops', purpose: d.deposit_purpose, provider: d.provider ?? '—', rejection: d.rejection_reason ?? null },
        })),
        ...walletDeps.map((d: any) => ({
          id: `WDP-${d.id.slice(0, 8)}`,
          type: 'Wallet deposit',
          person: nameOf(profilesMap[d.user_id]),
          amount: Number(d.amount ?? 0),
          status: 'Recorded',
          statusKind: 'success' as Severity,
          date: d.created_at,
          staff: 'Field Agent',
          reference: d.id.slice(0, 8),
          details: { department: 'Financial Ops', deposit_type: d.deposit_type },
        })),
      ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      const withdrawalsTotal = withdrawals.reduce((s: number, w: any) => s + Number(w.amount ?? 0), 0);
      const depositsTotal =
        depositReqs.filter((d: any) => (d.status ?? '').toLowerCase().includes('approved')).reduce((s: number, d: any) => s + Number(d.amount ?? 0), 0) +
        walletDeps.reduce((s: number, d: any) => s + Number(d.amount ?? 0), 0);
      const pendingApprovals = withdrawals.filter((w: any) => (w.status ?? 'pending') === 'pending').length +
        depositReqs.filter((d: any) => (d.status ?? 'pending') === 'pending').length;
      const rejected = withdrawals.filter((w: any) => (w.status ?? '').toLowerCase().includes('reject')).length +
        depositReqs.filter((d: any) => (d.status ?? '').toLowerCase().includes('reject')).length;

      // Daily inflow vs outflow trend (14d)
      const trend: { label: string; deposits: number; withdrawals: number }[] = [];
      for (let i = 13; i >= 0; i--) {
        const d = subDays(new Date(), i);
        const key = format(d, 'yyyy-MM-dd');
        const dep = [...depositReqs.filter((x: any) => (x.status ?? '').toLowerCase().includes('approved')), ...walletDeps]
          .filter((x: any) => x.created_at?.slice(0, 10) === key)
          .reduce((s: number, x: any) => s + Number(x.amount ?? 0), 0);
        const wit = withdrawals
          .filter((x: any) => x.created_at?.slice(0, 10) === key)
          .reduce((s: number, x: any) => s + Number(x.amount ?? 0), 0);
        trend.push({ label: format(d, 'd MMM'), deposits: Math.round(dep / 1000), withdrawals: Math.round(wit / 1000) });
      }

      // Outflow by payout method
      const byMethod: Record<string, number> = {};
      withdrawals.forEach((w: any) => {
        const k = (w.payout_method ?? 'other').replace(/_/g, ' ');
        byMethod[k] = (byMethod[k] ?? 0) + Number(w.amount ?? 0);
      });
      const outflowByMethod = Object.entries(byMethod).map(([label, value]) => ({ label, value: Math.round(value) }));

      return {
        activities,
        kpis: {
          withdrawalsCount: withdrawals.length,
          withdrawalsTotal,
          depositsTotal,
          pendingApprovals,
          rejected,
        },
        trend,
        outflowByMethod,
      };
    },
  });
}
// ─────────────────────────────────────────────────────────────────────────────
// System Overview (ALL-TIME — deliberately unwindowed, unlike the four reports
// above which are locked to the 30-day window).
// ─────────────────────────────────────────────────────────────────────────────

export interface SystemOverviewSnapshot {
  total_tenants_ever: number;
  active_tenants_now: number;
  total_paid_to_landlords: number;
  first_operation_date: string | null;
  days_in_operation: number;
  avg_daily_paid: number;
}

export function useSystemOverviewData() {
  return useQuery({
    queryKey: ['coo-report', 'system-overview'],
    staleTime: 60_000,
    queryFn: async (): Promise<SystemOverviewSnapshot> => {
      const { data, error } = await (supabase.rpc as any)('get_coo_system_overview');
      if (error) throw error;
      const d = (data ?? {}) as Record<string, any>;
      return {
        total_tenants_ever: Number(d.total_tenants_ever ?? 0),
        active_tenants_now: Number(d.active_tenants_now ?? 0),
        total_paid_to_landlords: Number(d.total_paid_to_landlords ?? 0),
        first_operation_date: d.first_operation_date ?? null,
        days_in_operation: Number(d.days_in_operation ?? 0),
        avg_daily_paid: Number(d.avg_daily_paid ?? 0),
      };
    },
  });
}
