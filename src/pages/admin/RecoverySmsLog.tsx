import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, MessageSquare, Download, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { formatDistanceToNow } from 'date-fns';

type LogRow = {
  id: string;
  created_at: string;
  recipient_phone: string;
  recipient_user_id: string | null;
  recipient_name: string | null;
  message: string | null;
  status: 'sent' | 'failed' | 'queued' | string;
  provider: string | null;
  provider_message_id: string | null;
  provider_response: any;
  reference_id: string | null;
  error: string | null;
};

function statusVariant(s: string): 'default' | 'destructive' | 'secondary' {
  if (s === 'sent') return 'default';
  if (s === 'failed') return 'destructive';
  return 'secondary';
}

function toCSV(rows: LogRow[]): string {
  const header = ['created_at','status','provider','provider_message_id','recipient_phone','recipient_name','recipient_user_id','advance_id','error','message'];
  const escape = (v: any) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.created_at, r.status, r.provider ?? '', r.provider_message_id ?? '', r.recipient_phone, r.recipient_name ?? '', r.recipient_user_id ?? '', r.reference_id ?? '', r.error ?? '', r.message ?? ''].map(escape).join(','));
  }
  return lines.join('\n');
}

export default function RecoverySmsLogPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<'all' | 'sent' | 'failed' | 'queued'>('all');
  const [search, setSearch] = useState('');

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['recovery-sms-log'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sms_delivery_log')
        .select('id, created_at, recipient_phone, recipient_user_id, recipient_name, message, status, provider, provider_message_id, provider_response, reference_id, error')
        .eq('source', 'withdrawal_recovery_advance')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as LogRow[];
    },
  });

  const filtered = useMemo(() => {
    const rows = data ?? [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!q) return true;
      return (
        (r.recipient_phone || '').toLowerCase().includes(q) ||
        (r.recipient_name || '').toLowerCase().includes(q) ||
        (r.recipient_user_id || '').toLowerCase().includes(q) ||
        (r.reference_id || '').toLowerCase().includes(q) ||
        (r.error || '').toLowerCase().includes(q)
      );
    });
  }, [data, search, statusFilter]);

  const counts = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      sent: rows.filter((r) => r.status === 'sent').length,
      failed: rows.filter((r) => r.status === 'failed').length,
      queued: rows.filter((r) => r.status === 'queued').length,
    };
  }, [data]);

  const download = () => {
    const csv = toCSV(filtered);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recovery-sms-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b bg-card">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/admin/dashboard')} aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <MessageSquare className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold leading-tight">Recovery SMS Delivery Log</h1>
            <p className="text-xs text-muted-foreground">Every overdraft auto-recovery SMS attempt, per provider & status</p>
          </div>
          <div className="ml-auto flex gap-2">
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
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Total (last 500)</div><div className="text-2xl font-semibold">{counts.total}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Sent</div><div className="text-2xl font-semibold text-emerald-600">{counts.sent}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Failed</div><div className="text-2xl font-semibold text-destructive">{counts.failed}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Queued</div><div className="text-2xl font-semibold text-amber-600">{counts.queued}</div></CardContent></Card>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Attempts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                placeholder="Search phone, name, user id, advance id, error…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="sm:max-w-md"
              />
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
                <SelectTrigger className="sm:w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="queued">Queued</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {isLoading ? (
              <div className="py-12 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : filtered.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No recovery SMS attempts match the current filters.
              </div>
            ) : (
              <div className="border rounded-md overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Recipient</TableHead>
                      <TableHead>Advance</TableHead>
                      <TableHead>Error / details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((r) => {
                      const attempts = (r.provider_response?.attempts as any[]) || [];
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="text-xs whitespace-nowrap">
                            <div>{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</div>
                            <div className="text-muted-foreground">{new Date(r.created_at).toLocaleString()}</div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                          </TableCell>
                          <TableCell className="text-xs">
                            <div className="font-medium">{r.provider || '—'}</div>
                            {attempts.length > 1 && (
                              <div className="text-muted-foreground">{attempts.length} attempts</div>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            <div className="font-medium">{r.recipient_name || '—'}</div>
                            <div className="text-muted-foreground">{r.recipient_phone}</div>
                          </TableCell>
                          <TableCell className="text-xs font-mono">
                            {r.reference_id ? r.reference_id.slice(0, 8) : '—'}
                          </TableCell>
                          <TableCell className="text-xs max-w-[320px]">
                            {r.error ? (
                              <span className="text-destructive">{r.error}</span>
                            ) : r.provider_message_id ? (
                              <span className="text-muted-foreground">id: {r.provider_message_id}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
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