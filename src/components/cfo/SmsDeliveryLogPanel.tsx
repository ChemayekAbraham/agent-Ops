import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Loader2, Clock, Download, Search, Filter, MessageSquare, Phone, CheckCircle2, XCircle, RefreshCw, Send, Hourglass } from 'lucide-react';
import { format } from 'date-fns';

interface SmsRow {
  id: string;
  created_at: string;
  recipient_phone: string;
  recipient_user_id: string | null;
  recipient_name: string | null;
  message: string | null;
  status: string;
  provider: string | null;
  provider_message_id: string | null;
  provider_response: unknown;
  cost: string | null;
  reference_id: string | null;
  source: string | null;
  error: string | null;
}

const STATUS_FILTERS = [
  { label: 'All Statuses', value: 'all' },
  { label: 'Delivered', value: 'delivered' },
  { label: 'Sent', value: 'sent' },
  { label: 'Pending', value: 'pending' },
  { label: 'Failed', value: 'failed' },
];

// "sent" = accepted by the gateway (awaiting delivery report); "delivered" =
// carrier-confirmed on the handset; "pending" = intermediate DLR; "failed" =
// rejected at send or DLR failure.
function statusMeta(status: string) {
  switch (status) {
    case 'delivered':
      return { label: 'Delivered', tone: 'success' as const, Icon: CheckCircle2 };
    case 'sent':
      return { label: 'Sent', tone: 'muted' as const, Icon: Send };
    case 'pending':
      return { label: 'Pending', tone: 'muted' as const, Icon: Hourglass };
    case 'failed':
      return { label: 'Failed', tone: 'destructive' as const, Icon: XCircle };
    default:
      return { label: status, tone: 'muted' as const, Icon: Send };
  }
}

export function SmsDeliveryLogPanel() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [detail, setDetail] = useState<SmsRow | null>(null);
  const [isSweepingYoola, setIsSweepingYoola] = useState(false);

  const { data: rows, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['sms-delivery-log', statusFilter],
    queryFn: async () => {
      let q = supabase
        .from('sms_delivery_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (statusFilter !== 'all') q = q.eq('status', statusFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as SmsRow[];
    },
    staleTime: 30_000,
  });

  const filtered = (rows || []).filter((r) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      r.recipient_phone?.toLowerCase().includes(s) ||
      r.recipient_name?.toLowerCase().includes(s) ||
      r.reference_id?.toLowerCase().includes(s) ||
      r.source?.toLowerCase().includes(s) ||
      r.message?.toLowerCase().includes(s) ||
      r.error?.toLowerCase().includes(s)
    );
  });

  const sentCount = (rows || []).filter((r) => r.status === 'sent').length;
  const failedCount = (rows || []).filter((r) => r.status === 'failed').length;
  const deliveredCount = (rows || []).filter((r) => r.status === 'delivered').length;

  const handleExportCSV = () => {
    if (!filtered.length) return;
    const header = 'Date,Status,Recipient,Phone,Reference,Source,Provider Msg ID,Cost,Error,Message\n';
    const csv = header + filtered.map((r) => {
      const cells = [
        format(new Date(r.created_at), 'yyyy-MM-dd HH:mm'),
        r.status,
        r.recipient_name || '',
        r.recipient_phone || '',
        r.reference_id || '',
        r.source || '',
        r.provider_message_id || '',
        r.cost || '',
        r.error || '',
        (r.message || '').replace(/\s+/g, ' '),
      ];
      return cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',');
    }).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename = `sms-delivery-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // Bulk export of many recipients' phone numbers and messages at once,
    // not logged before this. Plain client-side insert so the audit_logs
    // IP-capture trigger sees the real browser IP directly. Never blocks
    // the actual download.
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        await supabase.from('audit_logs').insert({
          user_id: user?.id ?? null,
          action_type: 'csv_exported',
          table_name: 'sms_delivery_log',
          record_id: null,
          metadata: { filename, row_count: filtered.length },
        });
      } catch (e) {
        console.warn('[SmsDeliveryLogPanel] audit log insert failed:', e);
      }
    })();
  };

  const handleRefreshDeliveryReports = async () => {
    setIsSweepingYoola(true);
    try {
      const { error } = await supabase.functions.invoke('sms-yoola-delivery-sweep', {
        body: { limit: 150, since_hours: 96 },
      });
      if (error) console.warn('[SmsDeliveryLogPanel] Yoola delivery sweep failed:', error);
    } finally {
      setIsSweepingYoola(false);
      refetch();
    }
  };

  if (isLoading) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-4 flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="rounded-2xl">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <MessageSquare className="h-3.5 w-3.5" />
              SMS Delivery Log
            </p>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-[10px] gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-600" /> {deliveredCount} delivered
              </Badge>
              <Badge variant="secondary" className="text-[10px] gap-1">
                <Send className="h-3 w-3 text-muted-foreground" /> {sentCount} sent
              </Badge>
              <Badge variant="secondary" className="text-[10px] gap-1">
                <XCircle className="h-3 w-3 text-destructive" /> {failedCount} failed
              </Badge>
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={handleRefreshDeliveryReports} disabled={isFetching || isSweepingYoola}>
                <RefreshCw className={`h-3 w-3 ${isFetching || isSweepingYoola ? 'animate-spin' : ''}`} />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={handleExportCSV} disabled={!filtered.length}>
                <Download className="h-3 w-3" /> CSV
              </Button>
            </div>
          </div>

          <div className="flex gap-2 mb-3 flex-wrap">
            <div className="relative flex-1 min-w-[120px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <Input
                placeholder="Search phone, name, reference..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-7 text-xs pl-7"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-7 text-xs w-[130px]">
                <Filter className="h-3 w-3 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((f) => (
                  <SelectItem key={f.value} value={f.value} className="text-xs">{f.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!filtered.length ? (
            <p className="text-sm text-muted-foreground text-center py-6">No SMS records found.</p>
          ) : (
            <div className="space-y-2 max-h-[560px] overflow-y-auto">
              {filtered.map((r) => {
                const meta = statusMeta(r.status);
                const isFailed = r.status === 'failed';
                const StatusIcon = meta.Icon;
                return (
                  <button
                    key={r.id}
                    onClick={() => setDetail(r)}
                    className="w-full text-left flex items-start gap-3 p-2.5 rounded-xl border border-border/50 hover:bg-muted/30 transition-colors"
                  >
                    <div className="shrink-0 mt-0.5">
                      <StatusIcon
                        className={`h-4 w-4 ${
                          meta.tone === 'success'
                            ? 'text-emerald-600'
                            : meta.tone === 'destructive'
                              ? 'text-destructive'
                              : 'text-muted-foreground'
                        }`}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold truncate flex items-center gap-1.5">
                          <Phone className="h-3 w-3 text-muted-foreground" />
                          {r.recipient_phone}
                          {r.recipient_name && <span className="text-foreground/70 font-normal truncate">· {r.recipient_name}</span>}
                        </p>
                        <Badge
                          variant={isFailed ? 'destructive' : 'secondary'}
                          className="text-[10px] shrink-0 capitalize"
                        >
                          {meta.label}
                        </Badge>
                      </div>
                      {r.message && (
                        <p className="text-[11px] text-foreground/80 truncate mt-0.5">{r.message}</p>
                      )}
                      {isFailed && r.error && (
                        <p className="text-[10px] text-destructive truncate mt-0.5">⚠ {r.error}</p>
                      )}
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Clock className="h-2.5 w-2.5" />
                          {format(new Date(r.created_at), 'MMM d, h:mm a')}
                        </span>
                        {r.reference_id && (
                          <span className="text-[10px] font-mono text-primary truncate">Ref: {r.reference_id}</span>
                        )}
                        {r.source && (
                          <Badge variant="outline" className="text-[9px] py-0">{r.source}</Badge>
                        )}
                        {r.cost && (
                          <span className="text-[10px] text-muted-foreground">{r.cost}</span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-4 w-4" /> SMS Detail
            </DialogTitle>
            <DialogDescription>Provider response and delivery metadata.</DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-2 text-xs">
              <Field label="Status" value={detail.status} />
              <Field label="Recipient" value={`${detail.recipient_name || '—'} (${detail.recipient_phone})`} />
              <Field label="Reference" value={detail.reference_id || '—'} />
              <Field label="Source" value={detail.source || '—'} />
              <Field label="Provider" value={detail.provider || '—'} />
              <Field label="Provider Msg ID" value={detail.provider_message_id || '—'} />
              <Field label="Cost" value={detail.cost || '—'} />
              <Field label="Sent at" value={format(new Date(detail.created_at), 'PPpp')} />
              {detail.error && <Field label="Error" value={detail.error} />}
              <div>
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Message</p>
                <p className="rounded-lg bg-muted/50 p-2 whitespace-pre-wrap">{detail.message || '—'}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Raw provider response</p>
                <pre className="rounded-lg bg-muted/50 p-2 overflow-x-auto text-[10px] max-h-48">
                  {detail.provider_response ? JSON.stringify(detail.provider_response, null, 2) : '—'}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground shrink-0">{label}</span>
      <span className="text-right break-all">{value}</span>
    </div>
  );
}