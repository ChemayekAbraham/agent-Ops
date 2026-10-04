import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type DailyRange = { from: Date; to: Date };


const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const endOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

export interface ReceivableRow {
  id: string;
  tenant_id: string | null;
  tenant_name: string;
  daily_repayment: number;
  amount_repaid: number;
  total_repayment: number;
  expected_to_date: number;
  overdue: number;
  outstanding: number;
  status: string;
}

export interface PayableRow {
  id: string;
  user_id: string | null;
  name: string;
  amount: number;
  status: string;
  created_at: string;
  processed_at: string | null;
  payout_method: string | null;
  due_date?: string | null;
  category_label?: string | null;
}


export interface DailyReceivablesPayables {
  receivables: {
    dueInRange: number;
    collectedInRange: number;
    overdue: number;
    outstanding: number;
    rows: ReceivableRow[];
  };
  payables: {
    dueInRange: number;
    paidInRange: number;
    overdue: number;
    outstanding: number;
    rows: PayableRow[];
  };
  days: number;
}

const kampalaDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(d);

/**
 * Daily receivables & payables derived strictly from existing sources:
 *  - receivables: v_tenant_daily_eligibility (active repaying plans) + agent_collections (money actually collected)
 *  - payables:    get_payables_due_range (authoritative v_payables_lines definition, Kampala business dates)
 * No accounting logic is changed here — this is a reporting-layer aggregation only.
 */
export function useCFODailyReceivablesPayables(range: DailyRange) {
  const from = startOfDay(range.from);
  const to = endOfDay(range.to);
  const days = Math.max(1, Math.round((startOfDay(range.to).getTime() - from.getTime()) / 86_400_000) + 1);

  return useQuery<DailyReceivablesPayables>({
    queryKey: ['cfo-daily-receivables-payables', from.toISOString(), to.toISOString()],
    staleTime: 120_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const [eligRes, collectedRes, payablesRes] = await Promise.all([
        (supabase.from('v_tenant_daily_eligibility') as any)
          .select('rent_request_id, tenant_id, daily_repayment, amount_repaid, total_repayment, start_at, status'),
        supabase
          .from('agent_collections')
          .select('amount').is('reversed_at', null)
          .gte('created_at', from.toISOString())
          .lte('created_at', to.toISOString()),
        (supabase.rpc as any)('get_payables_due_range', {
          p_from: kampalaDate(from),
          p_to: kampalaDate(to),
        }),
      ]);

      if (eligRes.error) throw eligRes.error;
      if (collectedRes.error) throw collectedRes.error;
      if (payablesRes.error) throw payablesRes.error;

      const elig = (eligRes.data || []) as any[];
      const payablesData = (payablesRes.data || {}) as any;
      const payableRaw = (payablesData.rows || []) as any[];


      /* ── names ── */
      const ids = [
        ...new Set([
          ...elig.map((r) => r.tenant_id),
          ...payableRaw.map((r) => r.user_id),
        ].filter(Boolean)),
      ] as string[];

      const nameMap = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 300) {
        const chunk = ids.slice(i, i + 300);
        const { data } = await supabase.from('profiles').select('id, full_name').in('id', chunk);
        (data || []).forEach((p: any) => nameMap.set(p.id, p.full_name || 'Unknown'));
      }

      /* ── receivables ── */
      const receivableRows: ReceivableRow[] = elig.map((r) => {
        const daily = Number(r.daily_repayment || 0);
        const repaid = Number(r.amount_repaid || 0);
        const total = Number(r.total_repayment || 0);
        const startAt = r.start_at ? startOfDay(new Date(r.start_at)) : null;
        const elapsed = startAt
          ? Math.max(0, Math.floor((startOfDay(range.to).getTime() - startAt.getTime()) / 86_400_000) + 1)
          : 0;
        const expected = total > 0 ? Math.min(total, daily * elapsed) : daily * elapsed;
        const outstanding = Math.max(0, total - repaid);
        return {
          id: r.rent_request_id,
          tenant_id: r.tenant_id,
          tenant_name: nameMap.get(r.tenant_id) || 'Unknown',
          daily_repayment: daily,
          amount_repaid: repaid,
          total_repayment: total,
          expected_to_date: expected,
          overdue: Math.max(0, expected - repaid),
          outstanding,
          status: r.status || '',
        };
      });

      const dueInRange = receivableRows.reduce(
        (s, r) => s + Math.min(r.daily_repayment * days, r.outstanding),
        0,
      );
      const collectedInRange = (collectedRes.data || []).reduce(
        (s: number, c: any) => s + Number(c.amount || 0),
        0,
      );
      const overdueReceivables = receivableRows.reduce((s, r) => s + r.overdue, 0);
      const outstandingReceivables = receivableRows.reduce((s, r) => s + r.outstanding, 0);

      /* ── payables (authoritative server-side definition) ── */
      const payableRows: PayableRow[] = payableRaw.map((r) => ({
        id: String(r.id),
        user_id: r.user_id ?? null,
        name: r.name || nameMap.get(r.user_id) || 'Unknown',
        amount: Number(r.amount || 0),
        status: r.status || '',
        created_at: r.due_date ? `${r.due_date}T00:00:00Z` : new Date().toISOString(),
        processed_at: null,
        payout_method: r.product_label ?? null,
        due_date: r.due_date ?? null,
        category_label: r.category_label ?? null,
      }));

      return {
        days,
        receivables: {
          dueInRange,
          collectedInRange,
          overdue: overdueReceivables,
          outstanding: outstandingReceivables,
          rows: receivableRows
            .slice()
            .sort((a, b) => b.overdue - a.overdue || b.outstanding - a.outstanding)
            .slice(0, 300),
        },
        payables: {
          dueInRange: Number(payablesData.due_in_range || 0),
          paidInRange: Number(payablesData.paid_in_range || 0),
          overdue: Number(payablesData.overdue || 0),
          outstanding: Number(payablesData.outstanding || 0),
          rows: payableRows,
        },
      };

    },
  });
}
