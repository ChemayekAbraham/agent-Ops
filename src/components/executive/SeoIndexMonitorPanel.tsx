import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Search, RefreshCw, CheckCircle2, AlertTriangle, Clock, Bell } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { toast } from 'sonner';

// The monitor tables are not in the generated Supabase types; cast to keep TS happy.
const sb = supabase as any;

interface Snapshot {
  id: string;
  checked_at: string;
  site_url: string;
  sitemap_submitted_count: number | null;
  sitemap_indexed_count: number | null;
  sitemap_errors: number | null;
  url_verdict: string | null;
  coverage_state: string | null;
  indexing_state: string | null;
  robots_state: string | null;
  google_canonical: string | null;
  pages_indexed: boolean;
  has_errors: boolean;
  alert_type: string | null;
  alert_sent: boolean;
}

interface Settings {
  alert_email: string;
  alerts_enabled: boolean;
}

export function SeoIndexMonitorPanel() {
  const qc = useQueryClient();
  const [emailDraft, setEmailDraft] = useState('');

  const { data: snapshots, isLoading } = useQuery({
    queryKey: ['seo-monitor-snapshots'],
    queryFn: async () => {
      const { data, error } = await sb
        .from('seo_index_monitor_snapshots')
        .select('*')
        .order('checked_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as Snapshot[];
    },
    staleTime: 60_000,
  });

  const { data: settings } = useQuery({
    queryKey: ['seo-monitor-settings'],
    queryFn: async () => {
      const { data, error } = await sb
        .from('seo_index_monitor_settings')
        .select('alert_email, alerts_enabled')
        .eq('id', true)
        .maybeSingle();
      if (error) throw error;
      return (data ?? { alert_email: '', alerts_enabled: true }) as Settings;
    },
  });

  useEffect(() => {
    if (settings?.alert_email) setEmailDraft(settings.alert_email);
  }, [settings?.alert_email]);

  const latest = snapshots?.[0];

  const refresh = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('seo-index-monitor', {
        body: { force: true },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ['seo-monitor-snapshots'] });
      if (data?.alert_sent) toast.success('Check complete — alert email sent.');
      else toast.success('Search Console check complete.');
    },
    onError: (e: any) => toast.error(`Check failed: ${e.message ?? e}`),
  });

  const saveSettings = useMutation({
    mutationFn: async (patch: Partial<Settings>) => {
      const { error } = await sb
        .from('seo_index_monitor_settings')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', true);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-monitor-settings'] });
      toast.success('Alert settings saved.');
    },
    onError: (e: any) => toast.error(`Could not save: ${e.message ?? e}`),
  });

  const canonicalOnWelileapp =
    latest?.google_canonical?.includes('welileapp.com') ?? false;

  return (
    <Card className="border-2">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          <Search className="w-5 h-5 text-primary" />
          <CardTitle className="text-base sm:text-lg">Google Indexing Monitor · welileapp.com</CardTitle>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          <RefreshCw className={`w-4 h-4 mr-1.5 ${refresh.isPending ? 'animate-spin' : ''}`} />
          Check now
        </Button>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Current status */}
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : latest ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatusTile
              label="Pages indexed"
              value={`${latest.sitemap_indexed_count ?? 0} / ${latest.sitemap_submitted_count ?? 0}`}
              tone={latest.pages_indexed ? 'good' : 'neutral'}
            />
            <StatusTile
              label="Indexing errors"
              value={latest.has_errors ? 'Detected' : 'None'}
              tone={latest.has_errors ? 'bad' : 'good'}
            />
            <StatusTile
              label="Robots / indexing"
              value={latest.robots_state === 'ALLOWED' && latest.indexing_state === 'INDEXING_ALLOWED' ? 'Allowed' : (latest.indexing_state ?? '—')}
              tone={latest.robots_state === 'ALLOWED' && latest.indexing_state === 'INDEXING_ALLOWED' ? 'good' : 'bad'}
            />
            <StatusTile
              label="Google canonical"
              value={canonicalOnWelileapp ? 'welileapp.com' : (latest.google_canonical?.replace(/^https?:\/\//, '').replace(/\/$/, '') ?? '—')}
              tone={canonicalOnWelileapp ? 'good' : 'neutral'}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No checks recorded yet. Click “Check now”.</p>
        )}

        {latest && (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            Last checked {formatDistanceToNow(new Date(latest.checked_at), { addSuffix: true })} · runs automatically every 6 hours
          </p>
        )}

        {/* Alert settings */}
        <div className="rounded-lg border p-3 sm:p-4 space-y-3 bg-muted/30">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bell className="w-4 h-4" /> Email alerts
          </div>
          <p className="text-xs text-muted-foreground">
            You’ll be emailed when pages first start appearing in Google with no indexing errors, and if an indexing error is detected.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="flex-1">
              <Label htmlFor="seo-alert-email" className="text-xs">Alert email</Label>
              <Input
                id="seo-alert-email"
                type="email"
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <Button
              size="sm"
              onClick={() => saveSettings.mutate({ alert_email: emailDraft.trim() })}
              disabled={saveSettings.isPending || !emailDraft.trim() || emailDraft.trim() === settings?.alert_email}
            >
              Save email
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="seo-alert-toggle" className="text-sm">Alerts enabled</Label>
            <Switch
              id="seo-alert-toggle"
              checked={settings?.alerts_enabled ?? true}
              onCheckedChange={(v) => saveSettings.mutate({ alerts_enabled: v })}
            />
          </div>
        </div>

        {/* History */}
        {snapshots && snapshots.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Checked</TableHead>
                  <TableHead className="text-right">Indexed</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Alert</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshots.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {format(new Date(s.checked_at), 'dd MMM, HH:mm')}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {s.sitemap_indexed_count ?? 0}/{s.sitemap_submitted_count ?? 0}
                    </TableCell>
                    <TableCell>
                      {s.has_errors ? (
                        <Badge variant="destructive" className="gap-1"><AlertTriangle className="w-3 h-3" />Error</Badge>
                      ) : s.pages_indexed ? (
                        <Badge className="gap-1 bg-success text-success-foreground"><CheckCircle2 className="w-3 h-3" />Indexed</Badge>
                      ) : (
                        <Badge variant="secondary">Pending</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {s.alert_type ? (
                        <span className={s.alert_sent ? 'text-foreground' : 'text-muted-foreground'}>
                          {s.alert_type === 'first_indexation' ? 'First indexation' : 'Errors'}
                          {s.alert_sent ? ' · sent' : ''}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusTile({ label, value, tone }: { label: string; value: string; tone: 'good' | 'bad' | 'neutral' }) {
  const toneCls =
    tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-destructive' : 'text-foreground';
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-sm sm:text-base font-semibold mt-0.5 break-words ${toneCls}`}>{value}</p>
    </div>
  );
}
