import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ShieldCheck, Download, Loader2, RefreshCw, RadioTower } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { supabase } from '@/integrations/supabase/client';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

/**
 * Every source that sends a one-time code / verification SMS.
 * Matched by prefix so future variants (e.g. `sms-otp:custom`,
 * `finops-cash-deposit-resend`) show up without another code change.
 */
const CODE_SOURCE_PREFIXES = [
  'sms-otp', // login + phone verification codes (incl. sms-otp:custom)
  'password-reset-sms',
  'issue-landlord-payout-otp',
  'verify-landlord-payout-otp',
  'cash-deposit-request-code',
  'cash-deposit-verify-code',
  'agent-cash-deposit-create',
  'agent-cash-deposit-resend',
  'finops-cash-deposit-initiate',
  'finops-cash-deposit-resend',
];

/** Groups used by the purpose filter. */
function purposeOf(source: string | null): 'login' | 'password' | 'cash_deposit' | 'landlord_payout' | 'other' {
  const s = source ?? '';
  if (s.startsWith('sms-otp')) return 'login';
  if (s.startsWith('password-reset')) return 'password';
  if (s.includes('cash-deposit')) return 'cash_deposit';
  if (s.includes('landlord-payout-otp')) return 'landlord_payout';
  return 'other';
}

const PURPOSE_LABELS: Record<string, string> = {
  login: 'Login / phone code',
  password: 'Password reset code',
  cash_deposit: 'Cash deposit code',
  landlord_payout: 'Landlord payout code',
  other: 'Other code',
};

type LogRow = {
  id: string;
  created_at: string;
  recipient_phone: string;
  recipient_user_id: string | null;
  recipient_name: string | null;
  status: string;
  provider: string | null;
  provider_message_id: string | null;
  provider_response: any;
  source: string | null;
  cost: string | null;
  error: string | null;
};

function statusVariant(s: string): 'default' | 'destructive' | 'secondary' | 'outline' {
  if (s === 'delivered') return 'default';
  if (s === 'failed') return 'destructive';
  if (s === 'skipped') return 'outline';
  return 'secondary';
}

/** Human summary of what the carrier actually said for this attempt. */
function carrierSummary(r: LogRow): string {
  const pr = r.provider_response ?? {};
  const raw = pr.provider_response ?? pr;
  const per = Array.isArray(raw?.per_recipient) ? raw.per_recipient[0] : null;
  const report = pr.delivery_report ?? pr.delivery_report_error ?? null;
  const bits: string[] = [];
  if (raw?.message) bits.push(String(raw.message));
  else if (raw?.status) bits.push(`gateway: ${raw.status}`);
  if (per?.status) bits.push(`carrier: ${per.status}${per.statusCode ? ` (${per.statusCode})` : ''}`);
  if (per?.credits) bits.push(`${per.credits} credit${per.credits > 1 ? 's' : ''}`);
  const handset = report?.sms_status ?? report?.delivery_status ?? report?.status_text;
  if (handset) bits.push(`handset: ${handset}`);
  if (r.error) bits.push(r.error);
  return bits.join(' · ') || '—';
}

function toCSV(rows: LogRow[]): string {
  const header = ['created_at', 'source', 'status', 'provider', 'provider_message_id', 'recipient_phone', 'recipient_name', 'cost', 'carrier_response', 'error'];
  const escape = (v: any) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.created_at, r.source ?? '', r.status, r.provider ?? '', r.provider_message_id ?? '', r.recipient_phone, r.recipient_name ?? '', r.cost ?? '', carrierSummary(r), r.error ?? ''].map(escape).join(','));
  }
  return lines.join('\n');
}

export default function OtpDeliveryLogPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [purposeFilter, setPurposeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [sweeping, setSweeping] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['otp-delivery-log'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sms_delivery_log')
        .select('id, created_at, recipient_phone, recipient_user_id, recipient_name, status, provider, provider_message_id, provider_response, source, cost, error')
        .or(CODE_SOURCE_PREFIXES.map((p) => `source.like.${p}%`).join(','))
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as LogRow[];
    },
    refetchInterval: 60_000,
  });

  const runSweep = async () => {
    setSweeping(true);
    try {
      const { data: res, error } = await supabase.functions.invoke('sms-yoola-delivery-sweep', {
        body: { limit: 250, since_hours: 72 },
      });
      if (error) throw error;
      toast.success(`Checked ${(res as any)?.checked ?? 0} carrier delivery reports`);
      await refetch();
    } catch (e: any) {
      toast.error(e?.message || 'Could not fetch carrier delivery reports');
    } finally {
      setSweeping(false);
    }
  };

  const filtered = useMemo(() => {
    const rows = data ?? [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (purposeFilter !== 'all' && purposeOf(r.source) !== purposeFilter) return false;
      if (!q) return true;
      return (
        (r.recipient_phone || '').toLowerCase().includes(q) ||
        (r.recipient_name || '').toLowerCase().includes(q) ||
        (r.provider_message_id || '').toLowerCase().includes(q) ||
        (r.source || '').toLowerCase().includes(q) ||
        (r.error || '').toLowerCase().includes(q)
      );
    });
  }, [data, search, statusFilter, purposeFilter]);

  const counts = useMemo(() => {
    const rows = data ?? [];
    const by = (s: string) => rows.filter((r) => r.status === s).length;
    return {
      total: rows.length,
      delivered: by('delivered'),
      awaiting: rows.filter((r) => ['accepted', 'sent', 'pending', 'queued'].includes(r.status)).length,
      failed: by('failed'),
    };
  }, [data]);

  const download = () => {
    const blob = new Blob([toCSV(filtered)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `otp-delivery-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b bg-card">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <ShieldCheck className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold leading-tight">Verification Code Delivery Log</h1>
            <p className="text-xs text-muted-foreground">Every code sent, with the carrier response and handset delivery result</p>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={runSweep} disabled={sweeping}>
              <RadioTower className={`h-4 w-4 mr-1 ${sweeping ? 'animate-pulse' : ''}`} />
              Check carrier reports
            </Button>
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button size="sm" variant="outline" onClick={download} disabled={!filtered.length}>
              <Download className="h-4 w-4 mr-1" /> CSV
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Codes (last 1000)</div><div className="text-2xl font-semibold">{counts.total}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Confirmed on handset</div><div className="text-2xl font-semibold text-emerald-600">{counts.delivered}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Accepted, not yet confirmed</div><div className="text-2xl font-semibold text-amber-600">{counts.awaiting}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Failed to reach</div><div className="text-2xl font-semibold text-destructive">{counts.failed}</div></CardContent></Card>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Sends</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                placeholder="Search phone, name, message id, source, error…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="sm:max-w-md"
              />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="sm:w-52"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All outcomes</SelectItem>
                  <SelectItem value="delivered">Delivered to handset</SelectItem>
                  <SelectItem value="accepted">Accepted by gateway</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="pending">Pending report</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="skipped">Skipped provider</SelectItem>
                </SelectContent>
              </Select>
              <Select value={purposeFilter} onValueChange={setPurposeFilter}>
                <SelectTrigger className="sm:w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All code types</SelectItem>
                  <SelectItem value="login">Login / phone code</SelectItem>
                  <SelectItem value="password">Password reset code</SelectItem>
                  <SelectItem value="cash_deposit">Cash deposit code</SelectItem>
                  <SelectItem value="landlord_payout">Landlord payout code</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {isLoading ? (
              <div className="py-12 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : filtered.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">No code sends match the current filters.</div>
            ) : (
              <div className="border rounded-md overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Recipient</TableHead>
                      <TableHead>Carrier response</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="text-xs whitespace-nowrap">
                          <div>{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</div>
                          <div className="text-muted-foreground">{new Date(r.created_at).toLocaleString()}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                          <div className="text-[11px] font-medium mt-1">{PURPOSE_LABELS[purposeOf(r.source)]}</div>
                          <div className="text-[11px] text-muted-foreground">{r.source}</div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="font-medium">{r.provider || '—'}</div>
                          {r.provider_message_id && <div className="text-muted-foreground font-mono">{r.provider_message_id}</div>}
                          {r.cost && <div className="text-muted-foreground">{r.cost}</div>}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="font-medium">{r.recipient_name || '—'}</div>
                          <div className="text-muted-foreground">{r.recipient_phone}</div>
                        </TableCell>
                        <TableCell className="text-xs max-w-[360px]">
                          <div className={r.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                            {carrierSummary(r)}
                          </div>
                          <Collapsible open={openRow === r.id} onOpenChange={(o) => setOpenRow(o ? r.id : null)}>
                            <CollapsibleTrigger asChild>
                              <Button variant="link" size="sm" className="h-auto p-0 text-[11px]">
                                {openRow === r.id ? 'Hide raw response' : 'Raw response'}
                              </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-[10px] leading-snug">
                                {JSON.stringify(r.provider_response ?? {}, null, 2)}
                              </pre>
                            </CollapsibleContent>
                          </Collapsible>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
