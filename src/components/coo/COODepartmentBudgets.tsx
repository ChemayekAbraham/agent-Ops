import { useEffect, useMemo, useState } from 'react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import BudgetReviewQueue from '@/components/budget/BudgetReviewQueue';
import { fetchBudgetReviewQueue, useBudgetCycles, type BudgetQueueRow } from '@/hooks/useDepartmentBudgets';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';

/**
 * COO review stage for department budgets, scoped server-side to Tenant Ops,
 * Agent Ops, Landlord Ops and Partner Ops. Approval forwards the submission to
 * the CFO queue; a rejection or revision request returns it to the department.
 *
 * "Budgets awaiting approval" is deliberately unscoped by budget cycle so a
 * pending submission can never be hidden by the cycle selector below it.
 */
export default function COODepartmentBudgets() {
  const { cycles } = useBudgetCycles();
  const [cycleId, setCycleId] = useState('all');
  const [rows, setRows] = useState<BudgetQueueRow[]>([]);
  const [loading, setLoading] = useState(false);

  const effectiveCycleId = cycleId === 'all' ? null : cycleId;

  useEffect(() => { if (cycleId === 'all' && cycles.length) setCycleId(cycles[0].id); }, [cycles, cycleId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchBudgetReviewQueue(effectiveCycleId, 'coo')
      .then(data => { if (!cancelled) setRows(data); })
      .catch(() => { if (!cancelled) setRows([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [effectiveCycleId]);

  const counts = useMemo(() => {
    const pending = rows.filter(r => ['pending_coo', 'coo_under_review'].includes(r.status));
    const approved = rows.filter(r => ['approved', 'released', 'paid', 'submitted', 'under_review'].includes(r.status));
    const rejected = rows.filter(r => ['rejected', 'revision_requested', 'returned', 'cancelled', 'superseded'].includes(r.status));
    return {
      pending: { count: pending.length, amount: pending.reduce((s, r) => s + r.total_amount, 0) },
      approved: { count: approved.length, amount: approved.reduce((s, r) => s + r.total_amount, 0) },
      rejected: { count: rejected.length, amount: rejected.reduce((s, r) => s + r.total_amount, 0) },
    };
  }, [rows]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm">All department budgets</CardTitle>
        <Select value={cycleId} onValueChange={setCycleId}>
          <SelectTrigger className="h-8 w-[240px] text-xs"><SelectValue placeholder="Budget cycle" /></SelectTrigger>
          <SelectContent className="z-[100]">
            <SelectItem value="all">All budget cycles</SelectItem>
            {cycles.map(c => (
              <SelectItem key={c.id} value={c.id}>
                {c.title}{c.financial_year ? ` · ${c.financial_year}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SummaryCard
            label="Pending"
            count={counts.pending.count}
            amount={counts.pending.amount}
            icon={<Clock className="h-4 w-4 text-amber-600" />}
            tone="amber"
            loading={loading}
          />
          <SummaryCard
            label="Approved"
            count={counts.approved.count}
            amount={counts.approved.amount}
            icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />}
            tone="emerald"
            loading={loading}
          />
          <SummaryCard
            label="Rejected"
            count={counts.rejected.count}
            amount={counts.rejected.amount}
            icon={<XCircle className="h-4 w-4 text-rose-600" />}
            tone="rose"
            loading={loading}
          />
        </div>
        <BudgetReviewQueue cycleId={effectiveCycleId} stage="coo" />
      </CardContent>
    </Card>
  );
}

interface SummaryCardProps {
  label: string;
  count: number;
  amount: number;
  icon: React.ReactNode;
  tone: 'amber' | 'emerald' | 'rose';
  loading: boolean;
}

function SummaryCard({ label, count, amount, icon, tone, loading }: SummaryCardProps) {
  const border = { amber: 'border-amber-500/30', emerald: 'border-emerald-500/30', rose: 'border-rose-500/30' }[tone];
  const bg = { amber: 'bg-amber-500/8', emerald: 'bg-emerald-500/8', rose: 'bg-rose-500/8' }[tone];
  return (
    <div className={`rounded-xl border ${border} ${bg} p-4`}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
        {icon}
      </div>
      <p className="mt-2 text-2xl font-black tracking-tight tabular-nums">
        {loading ? '—' : count}
      </p>
      <p className="mt-0.5 text-xs font-medium tabular-nums text-muted-foreground">
        {loading ? '—' : formatUGX(amount)}
      </p>
    </div>
  );
}
