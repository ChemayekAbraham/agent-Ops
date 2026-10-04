import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { differenceInHours, format } from 'date-fns';
import { AlertTriangle, ArrowRight, Building2, CheckCircle2, Banknote, Send, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useServiceCentres, SERVICE_CENTRE_BONUS } from '@/hooks/useServiceCentres';

/** Hours a submission may sit unverified before Agent Ops is in breach. */
const VERIFY_SLA_HOURS = 48;

const STAGES = [
  { key: 'submit',  icon: Send,        owner: 'Agent',       title: '1 · Setup & submit',  detail: 'Agent mounts the Welile poster at their premises, then submits a photo, GPS pin and location description from the Agent app.' },
  { key: 'verify',  icon: ShieldCheck, owner: 'Agent Ops',   title: '2 · Field verification', detail: `Agent Ops checks the photo and GPS against the agent's territory and confirms the centre is genuine. SLA: ${VERIFY_SLA_HOURS}h.` },
  { key: 'pay',     icon: Banknote,    owner: 'CFO',         title: '3 · Bonus payout',    detail: `CFO approves and the UGX ${SERVICE_CENTRE_BONUS.toLocaleString()} setup bonus is credited to the agent wallet through credit_agent_event_bonus.` },
  { key: 'operate', icon: Building2,   owner: 'Agent',       title: '4 · Operate',         detail: 'The centre becomes a walk-in point for tenant onboarding, rent collection, landlord and LC1 registration in that area.' },
] as const;

/** Documents and monitors the end-to-end Service Centre operating flow. */
export function ServiceCentreOperatingModel() {
  const { data: centres } = useServiceCentres();

  const { counts, breaches } = useMemo(() => {
    const rows = centres || [];
    const pending = rows.filter((r) => r.status === 'pending');
    return {
      counts: {
        submit: rows.length,
        verify: pending.length,
        pay: rows.filter((r) => r.status === 'verified' || r.status === 'approved').length,
        operate: rows.filter((r) => r.status === 'paid').length,
      } as Record<string, number>,
      breaches: pending
        .filter((r) => differenceInHours(new Date(), new Date(r.created_at)) > VERIFY_SLA_HOURS)
        .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)),
    };
  }, [centres]);

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">How a Service Centre operates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            A Service Centre is an agent-run walk-in point. One centre per agent; eligibility requires at least one
            linked landlord and one LC1 chairperson in the agent's area. The setup bonus is paid once, on verification.
          </p>
          <div className="grid gap-3 lg:grid-cols-4">
            {STAGES.map((s, i) => {
              const Icon = s.icon;
              return (
                <div key={s.key} className="relative rounded-xl border border-border p-3">
                  <div className="flex items-center gap-2">
                    <span className="h-7 w-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{s.title}</p>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.owner}</p>
                    </div>
                    <Badge variant="secondary" className="ml-auto shrink-0 text-xs">{counts[s.key] ?? 0}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">{s.detail}</p>
                  {i < STAGES.length - 1 && (
                    <ArrowRight className="hidden lg:block absolute -right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50" />
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className={cn('text-sm flex items-center gap-2', breaches.length > 0 && 'text-destructive')}>
            {breaches.length > 0 ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
            Verification SLA ({VERIFY_SLA_HOURS}h)
            <span className="ml-auto text-xs font-normal text-muted-foreground">{breaches.length} overdue</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {breaches.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-3">Every submission is within the {VERIFY_SLA_HOURS}-hour verification window.</p>
          ) : (
            <div className="divide-y divide-border">
              {breaches.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{r.agent_name}</p>
                    <p className="text-xs text-muted-foreground truncate">{r.location_name || 'No description'} · submitted {format(new Date(r.created_at), 'dd MMM yyyy')}</p>
                  </div>
                  <Badge variant="destructive" className="shrink-0 text-xs">
                    {differenceInHours(new Date(), new Date(r.created_at))}h waiting
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
