import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatUGX } from '@/lib/rentCalculations';

interface Inflow {
  paid_on: string;
  amount: number;
  source: string;
  method: string | null;
  reference: string | null;
  recorded_by: string | null;
}

interface ScheduleDay {
  due_on: string;
  due_amount: number;
  paid_amount: number;
  shortfall: number;
}

interface PlanArrearsDetail {
  found: boolean;
  as_at: string;
  plan: {
    daily_amount: number;
    plan_total: number;
    repaid: number;
    expected_to_date: number;
    arrears: number;
    term_start: string;
    obligation_end: string;
    obligation_days: number;
  };
  tenant: {
    name: string;
    phone: string | null;
    email: string | null;
    national_id: string | null;
    district: string | null;
    village: string | null;
    town: string | null;
    status: string | null;
    house_category: string | null;
    mobile_money_number: string | null;
    mobile_money_provider: string | null;
  };
  agent: { name: string; phone: string | null };
  totals: {
    receipt_count: number;
    received_total: number;
    due_days: number;
    shortfall_days: number;
  };
  inflows: Inflow[];
  schedule_days: ScheduleDay[];
}

const moneyCell = 'text-right tabular-nums';

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2">
      <span className="text-[11px] font-medium text-muted-foreground shrink-0">{label}</span>
      <span className="text-[11px] font-semibold text-foreground text-right break-words min-w-0">
        {value ?? '—'}
      </span>
    </div>
  );
}

export function TppoPlanArrearsDialog({
  rentRequestId,
  tenantName,
  onClose,
}: {
  rentRequestId: string | null;
  tenantName?: string;
  onClose: () => void;
}) {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['tppo-plan-arrears-detail', rentRequestId],
    enabled: !!rentRequestId,
    staleTime: 60_000,
    queryFn: async (): Promise<PlanArrearsDetail> => {
      const { data: rpcData, error: rpcError } = await supabase.rpc('tppo_plan_arrears_detail', {
        p_rent_request_id: rentRequestId as string,
      });
      if (rpcError) throw rpcError;
      return (rpcData ?? {}) as unknown as PlanArrearsDetail;
    },
  });

  const missed = (data?.schedule_days ?? []).filter((d) => d.shortfall > 0);

  return (
    <Dialog open={!!rentRequestId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {data?.tenant.name ?? tenantName ?? 'Plan detail'}
          </DialogTitle>
        </DialogHeader>

        {isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : isError ? (
          <p className="text-sm text-destructive">
            Could not load this tenant: {(error as Error)?.message ?? 'unknown error'}
          </p>
        ) : data?.found ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={data.plan.arrears > 0 ? 'destructive' : 'outline'}>
                {`Arrears ${formatUGX(data.plan.arrears)}`}
              </Badge>
              <Badge variant="outline">{`${data.totals.shortfall_days} missed or short days`}</Badge>
              <Badge variant="outline">{`Received ${formatUGX(data.totals.received_total)}`}</Badge>
              <span className="text-[11px] text-muted-foreground">
                {`As at ${data.as_at} · Africa/Kampala`}
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="divide-y divide-border rounded-xl border border-border bg-card">
                <p className="px-3 py-2 text-xs font-semibold text-foreground">Where the arrears come from</p>
                <Fact label="Daily amount" value={formatUGX(data.plan.daily_amount)} />
                <Fact label="Term start" value={data.plan.term_start} />
                <Fact label="Obligation end" value={data.plan.obligation_end} />
                <Fact label="Days in plan" value={data.plan.obligation_days} />
                <Fact label="Should have paid by now" value={formatUGX(data.plan.expected_to_date)} />
                <Fact label="Paid so far" value={formatUGX(data.plan.repaid)} />
                <Fact label="Plan total" value={formatUGX(data.plan.plan_total)} />
                <Fact
                  label="Shortfall"
                  value={
                    <span className={data.plan.arrears > 0 ? 'text-destructive' : undefined}>
                      {formatUGX(data.plan.arrears)}
                    </span>
                  }
                />
              </div>

              <div className="divide-y divide-border rounded-xl border border-border bg-card">
                <p className="px-3 py-2 text-xs font-semibold text-foreground">Tenant and agent</p>
                <Fact label="Tenant" value={data.tenant.name} />
                <Fact
                  label="Phone"
                  value={
                    data.tenant.phone ? (
                      <a className="underline" href={`tel:${data.tenant.phone}`}>{data.tenant.phone}</a>
                    ) : '—'
                  }
                />
                <Fact label="Email" value={data.tenant.email ?? '—'} />
                <Fact label="National ID" value={data.tenant.national_id ?? '—'} />
                <Fact
                  label="Location"
                  value={[data.tenant.village, data.tenant.town, data.tenant.district].filter(Boolean).join(', ') || '—'}
                />
                <Fact label="House category" value={data.tenant.house_category ?? '—'} />
                <Fact label="Tenant status" value={data.tenant.status ?? '—'} />
                <Fact
                  label="Mobile money"
                  value={[data.tenant.mobile_money_number, data.tenant.mobile_money_provider].filter(Boolean).join(' · ') || '—'}
                />
                <Fact
                  label="Agent"
                  value={
                    data.agent.phone
                      ? `${data.agent.name} · ${data.agent.phone}`
                      : data.agent.name
                  }
                />
              </div>
            </div>

            <section className="rounded-xl border border-border bg-card p-3">
              <h4 className="text-xs font-semibold text-foreground">
                {`Money received on this plan · ${data.totals.receipt_count} receipts`}
              </h4>
              {data.inflows.length === 0 ? (
                <p className="mt-2 text-[11px] text-muted-foreground">No money has been received on this plan yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Recorded by</TableHead>
                      <TableHead>Reference</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.inflows.map((r, i) => (
                      <TableRow key={`${r.paid_on}-${i}`}>
                        <TableCell>{r.paid_on}</TableCell>
                        <TableCell className={moneyCell}>{formatUGX(r.amount)}</TableCell>
                        <TableCell>{r.source}</TableCell>
                        <TableCell>{r.method ?? '—'}</TableCell>
                        <TableCell>{r.recorded_by ?? '—'}</TableCell>
                        <TableCell className="text-[11px] text-muted-foreground">{r.reference ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            <section className="rounded-xl border border-border bg-card p-3">
              <h4 className="text-xs font-semibold text-foreground">
                {`Dates that fell short · ${missed.length} of ${data.totals.due_days} due days`}
              </h4>
              {missed.length === 0 ? (
                <p className="mt-2 text-[11px] text-muted-foreground">Every due date so far has been met in full.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Due date</TableHead>
                      <TableHead className="text-right">Due</TableHead>
                      <TableHead className="text-right">Paid that day</TableHead>
                      <TableHead className="text-right">Short by</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {missed.map((d) => (
                      <TableRow key={d.due_on}>
                        <TableCell>{d.due_on}</TableCell>
                        <TableCell className={moneyCell}>{formatUGX(d.due_amount)}</TableCell>
                        <TableCell className={moneyCell}>{formatUGX(d.paid_amount)}</TableCell>
                        <TableCell className={`${moneyCell} text-destructive`}>{formatUGX(d.shortfall)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This plan could not be found.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default TppoPlanArrearsDialog;
