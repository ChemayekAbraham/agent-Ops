import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import {
  ShieldAlert,
  RefreshCw,
  Loader2,
  Phone,
  Check,
  EyeOff,
  Settings2,
  ArrowRight,
} from 'lucide-react';
import { TenantPhoneDuplicateSettingsDialog } from './TenantPhoneDuplicateSettingsDialog';

interface DuplicateAlert {
  id: string;
  signature: string;
  match_type: string;
  phone_key: string;
  member_ids: string[];
  member_count: number;
  sample_names: string[];
  sample_phones: string[];
  status: string;
  created_at: string;
  updated_at: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Surfaces tenant phone near-duplicates flagged by the recurring monitor
 * (`detect_tenant_phone_near_duplicates`, scheduled hourly via pg_cron).
 * Near-duplicates share the last 8 digits but differ on the full number —
 * a common signature of typo'd or fraudulent re-registrations that slip past
 * the exact-match unique constraint.
 */
interface TenantPhoneDuplicatePanelProps {
  /** `summary` renders the compact dashboard hero card with an "Open hub" action.
   *  `full` renders the complete working view (used inside the dedicated hub). */
  variant?: 'summary' | 'full';
  onOpenHub?: () => void;
}

export function TenantPhoneDuplicatePanel({ variant = 'full', onOpenHub }: TenantPhoneDuplicatePanelProps = {}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showResolved, setShowResolved] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ['tenant-phone-duplicate-alerts', showResolved],
    queryFn: async (): Promise<DuplicateAlert[]> => {
      let q = supabase
        .from('tenant_phone_duplicate_alerts')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(200);
      if (!showResolved) q = q.eq('status', 'open');
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as DuplicateAlert[];
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const rescan = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('detect_tenant_phone_near_duplicates');
      if (error) throw error;
      return (data as number) ?? 0;
    },
    onSuccess: (newCount) => {
      toast({
        title: 'Scan complete',
        description:
          newCount > 0
            ? `${newCount} new near-duplicate group${newCount === 1 ? '' : 's'} detected.`
            : 'No new near-duplicates found.',
      });
      queryClient.invalidateQueries({ queryKey: ['tenant-phone-duplicate-alerts'] });
    },
    onError: (e) =>
      toast({ title: 'Scan failed', description: (e as Error).message, variant: 'destructive' }),
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: 'resolved' | 'ignored' | 'open' }) => {
      const { data: u } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('tenant_phone_duplicate_alerts')
        .update({
          status,
          resolved_by: status === 'open' ? null : u.user?.id ?? null,
          resolved_at: status === 'open' ? null : new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenant-phone-duplicate-alerts'] });
    },
    onError: (e) =>
      toast({ title: 'Update failed', description: (e as Error).message, variant: 'destructive' }),
  });

  const rows = data ?? [];
  const openCount = useMemo(() => rows.filter((r) => r.status === 'open').length, [rows]);

  // Compact dashboard hero card — mirrors the "Open hub" entry pattern used by
  // the other Tenant Ops workspaces: icon, name, one summary stat, one action.
  if (variant === 'summary') {
    return (
      <button
        type="button"
        onClick={onOpenHub}
        aria-label="Open Tenant Phone Duplicate Monitor hub"
        className="group w-full cursor-pointer rounded-xl border border-amber-500/30 bg-card p-3 sm:p-3.5 flex items-start gap-3 text-left min-h-[64px] touch-manipulation hover:border-primary/60 hover:shadow-md active:scale-[0.99] transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <div className="p-2 rounded-lg bg-amber-500/10 shrink-0">
          <ShieldAlert className="h-5 w-5 text-amber-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm text-foreground leading-tight break-words">
            Tenant Phone Duplicate Monitor
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <span className="inline-flex items-baseline gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
              <span className="font-bold text-foreground">{openCount}</span>
              open
            </span>
          </div>
        </div>
        <span className="shrink-0 hidden sm:inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-[11px] font-bold text-primary-foreground shadow-sm group-hover:bg-primary/90 transition-colors">
          Open hub
          <ArrowRight className="h-3.5 w-3.5" />
        </span>
        <ArrowRight className="h-5 w-5 text-primary shrink-0 sm:hidden mt-1" />
      </button>
    );
  }

  return (
    <Card className="border-amber-500/30">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="h-4 w-4 text-amber-600 shrink-0" />
              <span className="min-w-0 break-words">Tenant Phone Duplicate Monitor</span>
              {openCount > 0 && (
                <Badge variant="destructive" className="ml-1 shrink-0">
                  {openCount} open
                </Badge>
              )}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1 leading-snug">
              Runs automatically every hour. Flags tenant phone numbers that nearly match an
              existing record (same last 8 digits) — likely typos or duplicate sign-ups.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowResolved((v) => !v)}
              className="text-xs"
            >
              {showResolved ? 'Open only' : 'Show all'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSettingsOpen(true)}
              className="text-xs"
            >
              <Settings2 className="h-4 w-4 mr-1" /> Settings
            </Button>
            <Button
              onClick={() => rescan.mutate()}
              disabled={rescan.isPending}
              size="sm"
              variant="secondary"
            >
              {rescan.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Scan now
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            {(error as Error).message}
          </div>
        )}

        {isFetching && rows.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading alerts…
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            No phone near-duplicates detected. The monitor will alert here automatically if any appear.
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div
                key={r.id}
                className="rounded-md border p-3 text-xs flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Phone className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                    <span className="font-mono font-medium">…{r.phone_key}</span>
                    <Badge variant="outline">{r.member_count} records</Badge>
                    {r.status !== 'open' && (
                      <Badge variant={r.status === 'ignored' ? 'secondary' : 'default'}>
                        {r.status}
                      </Badge>
                    )}
                    <span className="text-muted-foreground">{timeAgo(r.updated_at)}</span>
                  </div>
                  <div className="text-muted-foreground truncate">
                    {r.sample_names.filter(Boolean).join(', ') || 'Unnamed'}
                  </div>
                  <div className="text-muted-foreground font-mono truncate">
                    {r.sample_phones.filter(Boolean).join('  •  ')}
                  </div>
                </div>
                {r.status === 'open' ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={updateStatus.isPending}
                      onClick={() => updateStatus.mutate({ id: r.id, status: 'resolved' })}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" /> Resolve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={updateStatus.isPending}
                      onClick={() => updateStatus.mutate({ id: r.id, status: 'ignored' })}
                    >
                      <EyeOff className="h-3.5 w-3.5 mr-1" /> Ignore
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={updateStatus.isPending}
                    onClick={() => updateStatus.mutate({ id: r.id, status: 'open' })}
                    className="shrink-0"
                  >
                    Reopen
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <TenantPhoneDuplicateSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </Card>
  );
}