import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Copy, ExternalLink, MapPin, Megaphone, MousePointerClick, Pause, Play, RefreshCw, Send, Smartphone, Users } from 'lucide-react';

const SLUG = 'renewal-survey-oct-2026';
const SEGMENT_LABEL: Record<string, string> = { repaying: 'Actively repaying', completed: 'Completed', funded: 'Funded' };
const STATUS_TONE: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  scheduled: 'outline', sending: 'default', sent: 'secondary', paused: 'outline', stopped: 'destructive',
};
const n = (v: unknown) => Number(v ?? 0).toLocaleString('en-US');
const kampala = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

function Breakdown({ title, rows }: { title: string; rows: { label: string; n: number }[] }) {
  const total = rows.reduce((s, r) => s + Number(r.n), 0) || 1;
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-muted-foreground">{title}</p>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">No clicks yet</p>}
      {rows.map((r) => (
        <div key={r.label} className="space-y-1">
          <div className="flex justify-between text-xs"><span className="capitalize">{r.label.replace(/_/g, ' ')}</span><span className="tabular-nums">{n(r.n)}</span></div>
          <Progress value={(Number(r.n) / total) * 100} className="h-1.5" />
        </div>
      ))}
    </div>
  );
}

export function TenantCampaignPanel() {
  const qc = useQueryClient();
  const [testing, setTesting] = useState(false);
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['crm-tenant-campaign', SLUG],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('crm_tenant_campaign_overview', { p_slug: SLUG });
      if (error) throw error;
      return data as any;
    },
    refetchInterval: 30000,
  });

  const link = data ? `welileapp.com/n/${data.campaign.short_code}` : '';

  const sendTest = async () => {
    setTesting(true);
    const { data: r, error } = await supabase.functions.invoke('tenant-campaign-sender', { body: { mode: 'test' } });
    setTesting(false);
    if (error) { toast.error('Test send failed'); return; }
    const ok = (r?.results ?? []).filter((x: any) => x.ok).length;
    toast.success(`Test sent to ${ok} of ${(r?.results ?? []).length} test phones`);
    qc.invalidateQueries({ queryKey: ['crm-tenant-campaign', SLUG] });
  };

  const setWave = async (id: string, status: 'paused' | 'scheduled') => {
    const { error } = await supabase.rpc('crm_tenant_campaign_set_wave', { p_wave_id: id, p_status: status });
    if (error) toast.error(error.message); else { toast.success(status === 'paused' ? 'Wave paused' : 'Wave resumed'); refetch(); }
  };

  if (isLoading) return <div className="space-y-3"><Skeleton className="h-40 w-full rounded-xl" /><Skeleton className="h-64 w-full rounded-xl" /></div>;
  if (!data) return <p className="text-sm text-muted-foreground">Campaign not found.</p>;

  const a = data.audience;
  const waves: any[] = data.waves ?? [];
  const totalSent = waves.reduce((s, w) => s + Number(w.sent), 0);
  const totalFailed = waves.reduce((s, w) => s + Number(w.failed), 0);
  const ck = data.clicks;

  return (
    <div className="space-y-4">
      {/* Hero: who gets it */}
      <Card className="overflow-hidden border-primary/30">
        <div className="bg-gradient-to-br from-primary/15 via-primary/5 to-transparent p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-primary"><Megaphone className="h-4 w-4" /> SMS Campaign</p>
              <h2 className="text-xl font-bold">{data.campaign.name}</h2>
              <p className="text-sm text-muted-foreground">Invites tenants to a short survey for a next Rent Plan that could DOUBLE their rent. Automatic waves, sent from WELILE.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="gap-1.5"><RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />Refresh</Button>
              <Button size="sm" onClick={sendTest} disabled={testing} className="gap-1.5"><Send className="h-4 w-4" />{testing ? 'Sending…' : 'Send test'}</Button>
            </div>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-[auto_1fr] sm:items-end">
            <div>
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Users className="h-3.5 w-3.5" />Tenants who will get this</p>
              <p className="text-5xl font-extrabold tabular-nums text-primary" data-testid="campaign-audience-total">{n(a.total)}</p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(['repaying', 'completed', 'funded'] as const).map((s) => (
                <div key={s} className="rounded-lg border bg-card p-2.5">
                  <p className="text-[11px] text-muted-foreground">{SEGMENT_LABEL[s]}</p>
                  <p className="text-lg font-bold tabular-nums">{n(a[s])}</p>
                  <Progress value={a.total ? (a[s] / a.total) * 100 : 0} className="mt-1 h-1" />
                </div>
              ))}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className="gap-1 font-mono">{link}</Badge>
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => { navigator.clipboard?.writeText(`https://${link}`); toast.success('Link copied'); }}><Copy className="h-3.5 w-3.5" />Copy</Button>
            <a href={data.campaign.destination_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"><ExternalLink className="h-3.5 w-3.5" />Survey form</a>
            <span className="text-muted-foreground">· {n(a.with_rent)} show their rent amount, the rest get the general message</span>
          </div>
        </div>
      </Card>

      {/* Waves */}
      <div className="grid gap-3 md:grid-cols-3">
        {waves.map((w) => {
          const done = Number(w.sent) + Number(w.failed) + Number(w.skipped);
          const pct = w.audience ? Math.min(100, (done / Math.max(w.audience, done || 1)) * 100) : 0;
          return (
            <Card key={w.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">Wave {w.wave_no} · {SEGMENT_LABEL[w.segment]}</CardTitle>
                  <Badge variant={STATUS_TONE[w.status] ?? 'outline'} className="capitalize">{w.status}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{kampala(w.scheduled_at)} Kampala</p>
              </CardHeader>
              <CardContent className="space-y-2">
                <Progress value={pct} className="h-2" />
                <div className="grid grid-cols-4 gap-1 text-center text-xs">
                  <div><p className="font-bold tabular-nums">{n(w.audience)}</p><p className="text-muted-foreground">Tenants</p></div>
                  <div><p className="font-bold tabular-nums text-success">{n(w.sent)}</p><p className="text-muted-foreground">Sent</p></div>
                  <div><p className="font-bold tabular-nums text-destructive">{n(w.failed)}</p><p className="text-muted-foreground">Failed</p></div>
                  <div><p className="font-bold tabular-nums">{n(w.skipped)}</p><p className="text-muted-foreground">Skipped</p></div>
                </div>
                {w.note && <p className="text-[11px] text-muted-foreground">{w.note}</p>}
                {(w.status === 'scheduled' || w.status === 'sending') && (
                  <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={() => setWave(w.id, 'paused')}><Pause className="h-3.5 w-3.5" />Pause wave</Button>
                )}
                {(w.status === 'paused' || w.status === 'stopped') && (
                  <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={() => setWave(w.id, 'scheduled')}><Play className="h-3.5 w-3.5" />Resume wave</Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Clicks */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><MousePointerClick className="h-4 w-4" />Link clicks</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[
              ['SMS sent', totalSent], ['Clicks', ck.total], ['Unique (estimate)', ck.unique_est],
              ['Shared GPS', ck.with_gps], ['Click rate', totalSent ? `${((ck.total / totalSent) * 100).toFixed(1)}%` : '—'],
            ].map(([l, v]) => (
              <div key={String(l)} className="rounded-lg border p-2.5"><p className="text-[11px] text-muted-foreground">{l}</p><p className="text-lg font-bold tabular-nums">{typeof v === 'number' ? n(v) : v}</p></div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">Everyone gets the same link, so a click can't be tied to a named tenant. Link previews (WhatsApp etc.) are left out: {n(ck.bots)}. Failed SMS so far: {n(totalFailed)}.</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Breakdown title="Device" rows={ck.by_device} />
            <Breakdown title="Operating system" rows={ck.by_os} />
            <Breakdown title="Browser" rows={ck.by_browser} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b text-left text-muted-foreground"><th className="py-1.5 pr-2">When</th><th className="pr-2">Device</th><th className="pr-2">IP / area</th><th>GPS</th></tr></thead>
              <tbody>
                {ck.recent.length === 0 && <tr><td colSpan={4} className="py-3 text-center text-muted-foreground">No clicks yet</td></tr>}
                {ck.recent.map((r: any, i: number) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 whitespace-nowrap">{kampala(r.clicked_at)}</td>
                    <td className="pr-2"><span className="inline-flex items-center gap-1"><Smartphone className="h-3 w-3" />{r.os} · {r.browser}</span></td>
                    <td className="pr-2 font-mono">{r.ip_address ?? '—'}{r.city || r.country ? ` · ${[r.city, r.country].filter(Boolean).join(', ')}` : ''}</td>
                    <td>{r.gps_lat != null
                      ? <a className="inline-flex items-center gap-1 text-primary hover:underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${r.gps_lat},${r.gps_lng}`}><MapPin className="h-3 w-3" />Map (±{Math.round(r.gps_accuracy ?? 0)} m)</a>
                      : <span className="text-muted-foreground capitalize">{r.gps_status ?? 'waiting'}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Tests */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Test sends ({data.campaign.test_phones.join(', ')})</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {data.tests.length === 0 && <p className="text-xs text-muted-foreground">No test sent yet.</p>}
          {data.tests.map((t: any, i: number) => (
            <div key={i} className="rounded-lg border p-2.5 text-xs">
              <div className="flex justify-between"><span className="font-mono">{t.phone}</span><Badge variant={t.status === 'sent' ? 'secondary' : 'destructive'}>{t.status}</Badge></div>
              <p className="mt-1 text-muted-foreground">{kampala(t.sent_at)} — {t.message}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
