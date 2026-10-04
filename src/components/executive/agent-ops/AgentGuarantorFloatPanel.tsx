import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { formatUGX } from '@/lib/rentCalculations';
import { AlertTriangle, RefreshCw, Wallet, Users, Info } from 'lucide-react';
import {
  useAgentGuarantorFloatPreview,
  GUARANTOR_BASELINE_DATE,
  type GuarantorAgentRow,
  type GuarantorTenantRow,
} from '@/hooks/useAgentGuarantorFloatPreview';

const cadenceLabel: Record<GuarantorTenantRow['cadence'], string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  irregular: 'Irregular',
  unknown: 'No history',
};

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'warn' }) {
  const toneClass =
    tone === 'bad' ? 'text-destructive' : tone === 'good' ? 'text-success' : tone === 'warn' ? 'text-amber-600' : '';
  return (
    <div className="rounded-xl bg-muted/40 p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold leading-tight ${toneClass}`}>{value}</p>
    </div>
  );
}

function TenantRow({ t }: { t: GuarantorTenantRow }) {
  return (
    <div className="rounded-xl border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{t.tenant_name || 'Tenant'}</p>
          <p className="text-[11px] text-muted-foreground">
            {cadenceLabel[t.cadence]} · quiet {t.days_quiet}d since {t.quiet_start} · threshold {t.advance_threshold}d
          </p>
        </div>
        <Badge variant={t.state === 'advance_ready' ? 'destructive' : 'secondary'} className="shrink-0">
          {t.state === 'advance_ready' ? 'Deduct ready' : 'Watch'}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Daily expected" value={formatUGX(t.daily_repayment)} />
        <Metric label="Missing" value={formatUGX(t.missing_amount)} tone="warn" />
        <Metric label="From float" value={formatUGX(t.float_allocation)} tone="good" />
        <Metric label="Residual" value={formatUGX(t.residual_advance)} tone={t.residual_advance > 0 ? 'bad' : undefined} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Outstanding {formatUGX(t.outstanding)} · last collection{' '}
        {t.last_collection_at ? new Date(t.last_collection_at).toLocaleDateString() : 'none recorded'}
      </p>
    </div>
  );
}

function AgentItem({ a }: { a: GuarantorAgentRow }) {
  return (
    <AccordionItem value={a.agent_id} className="border rounded-2xl px-3">
      <AccordionTrigger className="hover:no-underline">
        <div className="flex-1 text-left space-y-2 pr-2">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-sm truncate">{a.agent_name || 'Agent'}</p>
            <Badge variant="outline" className="shrink-0">
              {a.tenant_count} tenant{a.tenant_count === 1 ? '' : 's'}
            </Badge>
            {a.advance_ready_count > 0 && (
              <Badge variant="destructive" className="shrink-0">{a.advance_ready_count} ready</Badge>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Float available" value={formatUGX(a.float_available)} />
            <Metric label="To be deducted" value={formatUGX(a.amount_to_deduct)} tone="warn" />
            <Metric label="Float remaining" value={formatUGX(a.float_remaining)} tone="good" />
            <Metric
              label="Residual (agent debt)"
              value={formatUGX(a.residual_advance)}
              tone={a.residual_advance > 0 ? 'bad' : undefined}
            />
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent className="space-y-2 pb-3">
        {a.tenants.map((t) => (
          <TenantRow key={t.rent_request_id} t={t} />
        ))}
      </AccordionContent>
    </AccordionItem>
  );
}

/**
 * Agent Ops → Guarantor Float Tracker.
 * Read-only parent (agent) → child (missing-paid tenant) tracker built on
 * Section 14 of the Agent Rent Repayment → Advance Engine design.
 * No cron, no automation: Agent Ops reviews this manually.
 */
export function AgentGuarantorFloatPanel() {
  const { data, isLoading, isFetching, refetch, error } = useAgentGuarantorFloatPreview();
  const totals = data?.totals;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Wallet className="h-4 w-4 text-primary" /> Guarantor Float Tracker
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Counting starts {GUARANTOR_BASELINE_DATE} 00:00 EAT. Preview only — no money moves and nothing is flagged
                automatically.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-xl" />
              ))}
            </div>
          ) : error ? (
            <p className="text-sm text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> {(error as Error).message}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label="Agents affected" value={String(totals?.agents ?? 0)} />
                <Metric label="Tenants missing" value={String(totals?.tenants ?? 0)} tone="warn" />
                <Metric label="Total shortfall" value={formatUGX(totals?.total_shortfall ?? 0)} tone="warn" />
                <Metric label="Float available" value={formatUGX(totals?.float_available ?? 0)} />
                <Metric label="To be deducted" value={formatUGX(totals?.amount_to_deduct ?? 0)} tone="warn" />
                <Metric label="Float remaining" value={formatUGX(totals?.float_remaining ?? 0)} tone="good" />
                <Metric
                  label="Residual → agent debt"
                  value={formatUGX(totals?.residual_advance ?? 0)}
                  tone={(totals?.residual_advance ?? 0) > 0 ? 'bad' : undefined}
                />
                <Metric label="Deduct-ready tenants" value={String(totals?.advance_ready_tenants ?? 0)} />
              </div>
              <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                Operational float is distributed oldest quiet window first, capped at the agent's float and at the
                cadence-scaled window (8 days daily, 16 weekly, 31 fortnightly). Anything float cannot cover is shown as
                residual and stays on the manual worklist.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {!isLoading && !error && (data?.agents.length ?? 0) === 0 && (
        <Card>
          <CardContent className="py-10 text-center space-y-2">
            <Users className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="text-sm font-medium">No agents to review yet</p>
            <p className="text-xs text-muted-foreground">
              Quiet days only start accumulating from {GUARANTOR_BASELINE_DATE}. Entries appear once a tenant crosses
              their cadence threshold.
            </p>
          </CardContent>
        </Card>
      )}

      {(data?.agents.length ?? 0) > 0 && (
        <Accordion type="multiple" className="space-y-2">
          {data!.agents.map((a) => (
            <AgentItem key={a.agent_id} a={a} />
          ))}
        </Accordion>
      )}
    </div>
  );
}
