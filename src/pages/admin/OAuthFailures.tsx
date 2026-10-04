import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ShieldAlert, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { formatDistanceToNow } from 'date-fns';

type FailureRow = {
  id: string;
  funnel_id: string;
  provider: string;
  stage: string;
  env: string;
  domain: string | null;
  origin: string | null;
  error_message: string | null;
  user_agent: string | null;
  created_at: string;
};

function classifyDevice(ua: string | null): { device: string; browser: string } {
  const u = (ua || '').toLowerCase();
  let device = 'Desktop';
  if (/iphone|ipod/.test(u)) device = 'iPhone';
  else if (/ipad/.test(u)) device = 'iPad';
  else if (/android/.test(u)) device = 'Android';
  else if (/mobile/.test(u)) device = 'Mobile';
  let browser = 'Other';
  if (/fban|fbav|instagram|line|wv\)|; wv\)/.test(u)) browser = 'In-app browser';
  else if (/edg\//.test(u)) browser = 'Edge';
  else if (/chrome\//.test(u) && !/edg\//.test(u)) browser = 'Chrome';
  else if (/crios/.test(u)) browser = 'Chrome iOS';
  else if (/firefox/.test(u)) browser = 'Firefox';
  else if (/safari/.test(u) && !/chrome|crios|android/.test(u)) browser = 'Safari';
  return { device, browser };
}

function classifyReason(msg: string | null): string {
  const m = (msg || '').toLowerCase();
  if (!m) return 'Unknown';
  if (/popup.*(closed|blocked)|window closed/.test(m)) return 'Popup closed / blocked';
  if (/access_denied|denied/.test(m)) return 'User denied consent';
  if (/redirect.*uri|invalid.*redirect/.test(m)) return 'Redirect URI mismatch';
  if (/network|fetch|failed to fetch|timeout/.test(m)) return 'Network / timeout';
  if (/state|csrf|nonce/.test(m)) return 'State / CSRF';
  if (/session|expired|token/.test(m)) return 'Session / token';
  if (/provider|unsupported/.test(m)) return 'Provider config';
  if (/email|account.*exist|identity/.test(m)) return 'Account collision';
  return 'Other';
}

function toCSV(rows: FailureRow[]): string {
  const header = ['created_at', 'provider', 'stage', 'env', 'domain', 'origin', 'device', 'browser', 'reason', 'error_message', 'user_agent'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const { device, browser } = classifyDevice(r.user_agent);
    const reason = classifyReason(r.error_message);
    const cells = [
      r.created_at,
      r.provider,
      r.stage,
      r.env,
      r.domain ?? '',
      r.origin ?? '',
      device,
      browser,
      reason,
      (r.error_message ?? '').replace(/"/g, '""'),
      (r.user_agent ?? '').replace(/"/g, '""'),
    ];
    lines.push(cells.map((c) => `"${String(c)}"`).join(','));
  }
  return lines.join('\n');
}

export default function OAuthFailuresPage() {
  const navigate = useNavigate();
  const [provider, setProvider] = useState<string>('google');
  const [deviceFilter, setDeviceFilter] = useState<string>('all');
  const [reasonFilter, setReasonFilter] = useState<string>('all');

  const sinceIso = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString();
  }, []);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['oauth-failures', provider, sinceIso],
    queryFn: async () => {
      let q = supabase
        .from('oauth_funnel_events')
        .select('id, funnel_id, provider, stage, env, domain, origin, error_message, user_agent, created_at')
        .eq('stage', 'error')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(2000);
      if (provider !== 'all') q = q.eq('provider', provider);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as FailureRow[];
    },
  });

  const enriched = useMemo(() => {
    return (data ?? []).map((r) => {
      const { device, browser } = classifyDevice(r.user_agent);
      return { ...r, device, browser, reason: classifyReason(r.error_message) };
    });
  }, [data]);

  const filtered = useMemo(() => {
    return enriched.filter((r) => {
      if (deviceFilter !== 'all' && r.device !== deviceFilter) return false;
      if (reasonFilter !== 'all' && r.reason !== reasonFilter) return false;
      return true;
    });
  }, [enriched, deviceFilter, reasonFilter]);

  const byRedirectStatus = useMemo(() => {
    const counts: Record<string, number> = { redirected: 0, popup: 0, unknown: 0 };
    const funnelStages = new Map<string, Set<string>>();
    for (const r of enriched) {
      const set = funnelStages.get(r.funnel_id) ?? new Set<string>();
      set.add(r.stage);
      funnelStages.set(r.funnel_id, set);
    }
    for (const r of enriched) {
      const stages = funnelStages.get(r.funnel_id);
      if (stages?.has('redirected')) counts.redirected += 1;
      else counts.popup += 1;
    }
    return counts;
  }, [enriched]);

  const groupCounts = (key: 'device' | 'browser' | 'reason') => {
    const map = new Map<string, number>();
    for (const r of enriched) {
      const k = (r as any)[key] as string;
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  };

  const deviceCounts = groupCounts('device');
  const browserCounts = groupCounts('browser');
  const reasonCounts = groupCounts('reason');

  const handleExport = () => {
    const csv = toCSV(filtered);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `oauth-failures-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => navigate('/admin')} className="gap-2 -ml-2">
            <ArrowLeft className="h-4 w-4" />
            Admin
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport} disabled={filtered.length === 0} className="gap-2">
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-destructive/10 text-destructive flex items-center justify-center">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-black">OAuth Failure Console</h1>
            <p className="text-sm text-muted-foreground">Failed sign-in attempts in the last 7 days, grouped by redirect status, device and error reason.</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="w-40"><SelectValue placeholder="Provider" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All providers</SelectItem>
              <SelectItem value="google">Google</SelectItem>
              <SelectItem value="apple">Apple</SelectItem>
            </SelectContent>
          </Select>
          <Select value={deviceFilter} onValueChange={setDeviceFilter}>
            <SelectTrigger className="w-40"><SelectValue placeholder="Device" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All devices</SelectItem>
              {deviceCounts.map(([k]) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={reasonFilter} onValueChange={setReasonFilter}>
            <SelectTrigger className="w-52"><SelectValue placeholder="Reason" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reasons</SelectItem>
              {reasonCounts.map(([k]) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
            </SelectContent>
          </Select>
          <Badge variant="secondary" className="ml-auto">
            {filtered.length} failure{filtered.length === 1 ? '' : 's'}
          </Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">By redirect status</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="flex justify-between"><span>Full-page redirect flow</span><span className="font-semibold">{byRedirectStatus.redirected}</span></div>
              <div className="flex justify-between"><span>Popup flow (no redirect)</span><span className="font-semibold">{byRedirectStatus.popup}</span></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">By device</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm max-h-40 overflow-auto">
              {deviceCounts.map(([k, v]) => (
                <div key={k} className="flex justify-between"><span>{k}</span><span className="font-semibold">{v}</span></div>
              ))}
              {deviceCounts.length === 0 && <p className="text-muted-foreground">No data</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">By error reason</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm max-h-40 overflow-auto">
              {reasonCounts.map(([k, v]) => (
                <div key={k} className="flex justify-between"><span className="truncate mr-2">{k}</span><span className="font-semibold">{v}</span></div>
              ))}
              {reasonCounts.length === 0 && <p className="text-muted-foreground">No data</p>}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Recent failures</CardTitle></CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : error ? (
              <p className="p-4 text-sm text-destructive">Failed to load: {(error as Error).message}</p>
            ) : filtered.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground text-center">No failures match the current filters.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Device</TableHead>
                      <TableHead>Browser</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Domain</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.slice(0, 500).map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap text-xs">{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</TableCell>
                        <TableCell className="text-xs">{r.provider}</TableCell>
                        <TableCell className="text-xs">{r.device}</TableCell>
                        <TableCell className="text-xs">{r.browser}</TableCell>
                        <TableCell className="text-xs"><Badge variant="outline">{r.reason}</Badge></TableCell>
                        <TableCell className="text-xs">{r.domain ?? '—'}</TableCell>
                        <TableCell className="text-xs max-w-[280px] truncate" title={r.error_message ?? ''}>{r.error_message ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {filtered.length > 500 && (
                  <p className="p-3 text-xs text-muted-foreground text-center">Showing first 500 of {filtered.length}. Export CSV for the full list.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}