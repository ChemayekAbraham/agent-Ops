import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTenantBehavior } from '@/hooks/useTenantBehavior';
import { format } from 'date-fns';
import { useEffect, useState } from 'react';
import { Activity, MapPin, ShieldCheck, ShieldAlert, Sparkles, Settings2 } from 'lucide-react';
import { TenantDetailPanel } from '@/components/executive/TenantDetailPanel';

interface Props {
  tenantId: string | null;
  onOpenChange: (open: boolean) => void;
}

const fmtUGX = (n: number) => `UGX ${Math.round(n || 0).toLocaleString()}`;

export function BehaviorDrawer({ tenantId, onOpenChange }: Props) {
  const { data, isLoading } = useTenantBehavior(tenantId);
  const open = !!tenantId;
  const [mode, setMode] = useState<'behavior' | 'manage'>('behavior');

  // Reset to the behaviour view whenever a different tenant (or none) is opened.
  useEffect(() => { setMode('behavior'); }, [tenantId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {mode === 'manage' ? 'Manage Tenant' : 'Tenant Behaviour'}
          </SheetTitle>
        </SheetHeader>

        {mode === 'manage' && tenantId ? (
          <div className="mt-4 pb-8">
            <TenantDetailPanel
              tenantId={tenantId}
              tenantName={data?.header.full_name || 'Tenant'}
              onBack={() => setMode('behavior')}
            />
          </div>
        ) : isLoading || !data ? (
          <div className="space-y-4 mt-4">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="space-y-5 mt-4 pb-8">
            {/* Drill-down: edit, collect rent, and update outstanding balance */}
            <Button className="w-full gap-2" onClick={() => setMode('manage')}>
              <Settings2 className="h-4 w-4" />
              Manage · edit, collect rent & outstanding
            </Button>
            {/* Header */}
            <div className="rounded-xl border border-border p-4 bg-card">
              <p className="font-semibold text-base truncate">{data.header.full_name || 'Unknown'}</p>
              <p className="text-xs text-muted-foreground">{data.header.phone || '—'}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge variant="secondary" className="gap-1">
                  {data.header.verified ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
                  {data.header.verified ? 'Verified' : 'Unverified'}
                </Badge>
                <Badge variant="outline" className="gap-1">
                  <MapPin className="h-3 w-3" /> {data.header.city || '—'}
                </Badge>
                <Badge className="bg-primary/15 text-primary border-primary/30">
                  Trust {data.header.trust_score} · {data.header.trust_tier || '—'}
                </Badge>
              </div>
            </div>

            {/* 30-day trend */}
            <Section icon={<Activity className="h-4 w-4" />} title="30-day payment trend">
              <TrendSpark data={data.trend_30d} />
              <p className="text-xs text-muted-foreground mt-2">
                Paid in last 30 days: <span className="font-semibold text-foreground">{fmtUGX(data.cohort.tenant_paid_30d)}</span>
              </p>
            </Section>

            {/* Trust factors */}
            <Section icon={<ShieldCheck className="h-4 w-4" />} title="Trust factors">
              <TrustBreakdown breakdown={data.trust_breakdown} />
            </Section>

            {/* Recent events */}
            <Section icon={<Sparkles className="h-4 w-4" />} title="Last 5 events">
              {data.recent_events.length === 0 ? (
                <p className="text-xs text-muted-foreground">No recent events.</p>
              ) : (
                <ul className="space-y-2">
                  {data.recent_events.map((e) => (
                    <li key={e.id} className="text-xs flex justify-between gap-2 border-b border-border/60 pb-2 last:border-b-0">
                      <span className="font-medium text-foreground truncate">{e.event_type}</span>
                      <span className="text-muted-foreground shrink-0">{format(new Date(e.created_at), 'MMM dd HH:mm')}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border p-4 bg-card">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-muted-foreground">{icon}</span>
        <h4 className="text-sm font-semibold">{title}</h4>
      </div>
      {children}
    </div>
  );
}

function TrendSpark({ data }: { data: Array<{ d: string; paid: number }> }) {
  if (!data || data.length === 0) {
    return <p className="text-xs text-muted-foreground">No payments in the last 30 days.</p>;
  }
  const max = Math.max(1, ...data.map((p) => Number(p.paid) || 0));
  return (
    <div className="flex items-end gap-0.5 h-16">
      {data.map((p) => {
        const h = Math.max(2, Math.round(((Number(p.paid) || 0) / max) * 60));
        return (
          <div
            key={p.d}
            className="flex-1 rounded-sm bg-primary/60 hover:bg-primary transition-colors"
            style={{ height: `${h}px` }}
            title={`${p.d}: UGX ${Math.round(Number(p.paid) || 0).toLocaleString()}`}
          />
        );
      })}
    </div>
  );
}

function TrustBreakdown({ breakdown }: { breakdown: Record<string, unknown> }) {
  const entries = Object.entries(breakdown || {}).slice(0, 6);
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">No factor data yet.</p>;
  return (
    <ul className="space-y-1.5">
      {entries.map(([k, v]) => {
        const val = typeof v === 'number' ? v : typeof v === 'object' && v && 'score' in (v as object) ? (v as { score: number }).score : null;
        return (
          <li key={k} className="flex justify-between text-xs">
            <span className="capitalize text-muted-foreground">{k.replace(/_/g, ' ')}</span>
            <span className="font-mono font-semibold">{val ?? '—'}</span>
          </li>
        );
      })}
    </ul>
  );
}
