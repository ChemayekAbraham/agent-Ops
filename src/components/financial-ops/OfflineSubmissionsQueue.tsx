import { useEffect, useMemo, useState } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileImage,
  Loader2,
  MapPin,
  PenLine,
  RefreshCw,
  Smartphone,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

type StatusFilter = 'all' | 'processing' | 'accepted' | 'rejected' | 'needs_attention';

interface SubmissionRow {
  id: string;
  draft_id: string;
  agent_id: string;
  tenant_id: string;
  rent_request_id: string;
  amount: number;
  provisional_receipt_no: string;
  captured_at: string;
  proof_type: string;
  proof_path: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  gps_accuracy: number | null;
  notes: string | null;
  status: string;
  failure_reason: string | null;
  server_receipt_no: string | null;
  processed_at: string | null;
  created_at: string;
}

interface ProfileLite {
  id: string;
  full_name: string | null;
  phone: string | null;
}

const statusBadge = (status: string) => {
  switch (status) {
    case 'accepted':
      return (
        <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 gap-1">
          <CheckCircle2 className="h-3 w-3" /> Accepted
        </Badge>
      );
    case 'rejected':
      return (
        <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive gap-1">
          <XCircle className="h-3 w-3" /> Rejected
        </Badge>
      );
    case 'needs_attention':
      return (
        <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 gap-1">
          <AlertCircle className="h-3 w-3" /> Needs attention
        </Badge>
      );
    case 'processing':
    default:
      return (
        <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary gap-1">
          <Clock className="h-3 w-3" /> Processing
        </Badge>
      );
  }
};

const proofIcon = (type: string) => {
  if (type === 'photo') return <FileImage className="h-3.5 w-3.5" />;
  if (type === 'signature') return <PenLine className="h-3.5 w-3.5" />;
  if (type === 'sms_code') return <Smartphone className="h-3.5 w-3.5" />;
  return <FileImage className="h-3.5 w-3.5" />;
};

function formatUGX(amount: number) {
  try {
    return new Intl.NumberFormat('en-UG', {
      style: 'currency',
      currency: 'UGX',
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `UGX ${Math.round(amount).toLocaleString()}`;
  }
}

export function OfflineSubmissionsQueue() {
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, ProfileLite>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [selected, setSelected] = useState<SubmissionRow | null>(null);
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [proofLoading, setProofLoading] = useState(false);
  const [resolving, setResolving] = useState(false);

  const load = async () => {
    const { data, error } = await supabase
      .from('offline_collection_submissions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      toast.error('Failed to load offline submissions', { description: error.message });
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const submissions = (data ?? []) as SubmissionRow[];
    setRows(submissions);

    const ids = Array.from(
      new Set(submissions.flatMap((r) => [r.agent_id, r.tenant_id])),
    );
    if (ids.length > 0) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', ids);
      const map: Record<string, ProfileLite> = {};
      (profs ?? []).forEach((p) => { map[p.id] = p as ProfileLite; });
      setProfiles(map);
    }

    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polled every 60s (+ on focus). The old Realtime listener was on offline_collection_submissions, which
  // is not in the publication, so it never fired (doc 147).
  const { lastUpdatedAt, refresh } = usePolling(() => load(), 60_000);

  const counts = useMemo(() => {
    const c = { all: rows.length, processing: 0, accepted: 0, rejected: 0, needs_attention: 0 };
    rows.forEach((r) => {
      if (r.status === 'processing') c.processing += 1;
      else if (r.status === 'accepted') c.accepted += 1;
      else if (r.status === 'rejected') c.rejected += 1;
      else if (r.status === 'needs_attention') c.needs_attention += 1;
    });
    return c;
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (filter === 'all') return rows;
    return rows.filter((r) => r.status === filter);
  }, [rows, filter]);

  const openDetail = async (row: SubmissionRow) => {
    setSelected(row);
    setProofUrl(null);
    if (row.proof_path && row.proof_type !== 'sms_code') {
      setProofLoading(true);
      const { data, error } = await supabase
        .storage
        .from('offline-collection-proof')
        .createSignedUrl(row.proof_path, 600);
      setProofLoading(false);
      if (error) {
        toast.error('Could not load proof file', { description: error.message });
      } else {
        setProofUrl(data?.signedUrl ?? null);
      }
    }
  };

  const markNeedsAttention = async () => {
    if (!selected) return;
    setResolving(true);
    const { error } = await supabase
      .from('offline_collection_submissions')
      .update({
        status: 'needs_attention',
        failure_reason: selected.failure_reason ?? 'Flagged by Financial Ops for manual review',
      })
      .eq('id', selected.id);
    setResolving(false);
    if (error) {
      toast.error('Failed to flag submission', { description: error.message });
      return;
    }
    toast.success('Flagged for manual review');
    setSelected({ ...selected, status: 'needs_attention' });
    load();
  };

  const markResolved = async () => {
    if (!selected) return;
    setResolving(true);
    const { error } = await supabase
      .from('offline_collection_submissions')
      .update({ status: 'rejected' })
      .eq('id', selected.id);
    setResolving(false);
    if (error) {
      toast.error('Failed to update status', { description: error.message });
      return;
    }
    toast.success('Marked as rejected — agent must re-collect');
    setSelected({ ...selected, status: 'rejected' });
    load();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const filters: { id: StatusFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'processing', label: 'Processing', count: counts.processing },
    { id: 'rejected', label: 'Rejected', count: counts.rejected },
    { id: 'needs_attention', label: 'Needs attention', count: counts.needs_attention },
    { id: 'accepted', label: 'Accepted', count: counts.accepted },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold">Offline Collections</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Drafts submitted by agents after attaching proof. Investigate exceptions and reconcile rejections.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setRefreshing(true); load(); }}
          disabled={refreshing}
          className="gap-1.5"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {filters.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              filter === f.id
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-background hover:bg-accent/50 text-muted-foreground'
            }`}
          >
            {f.label}
            <span className="ml-1.5 opacity-70">({f.count})</span>
          </button>
        ))}
      </div>

      {filteredRows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No submissions match this filter yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">{filteredRows.length} submissions</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Receipt</TableHead>
                  <TableHead className="text-xs">Agent / Tenant</TableHead>
                  <TableHead className="text-xs">Amount</TableHead>
                  <TableHead className="text-xs">Proof</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs">Submitted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((row) => {
                  const agent = profiles[row.agent_id];
                  const tenant = profiles[row.tenant_id];
                  return (
                    <TableRow
                      key={row.id}
                      className="cursor-pointer"
                      onClick={() => openDetail(row)}
                    >
                      <TableCell className="font-mono text-xs">
                        <div>{row.server_receipt_no ?? '—'}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {row.provisional_receipt_no}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="font-medium">{agent?.full_name ?? 'Agent'}</div>
                        <div className="text-muted-foreground">→ {tenant?.full_name ?? 'Tenant'}</div>
                      </TableCell>
                      <TableCell className="text-xs font-semibold">
                        {formatUGX(Number(row.amount))}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="gap-1 text-[10px]">
                          {proofIcon(row.proof_type)}
                          {row.proof_type}
                        </Badge>
                      </TableCell>
                      <TableCell>{statusBadge(row.status)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Sheet open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="text-base">Offline Submission</SheetTitle>
                <SheetDescription className="font-mono text-xs">
                  {selected.provisional_receipt_no}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-5 space-y-4">
                <div className="flex items-center justify-between">
                  {statusBadge(selected.status)}
                  <span className="text-xs text-muted-foreground">
                    Captured {formatDistanceToNow(new Date(selected.captured_at), { addSuffix: true })}
                  </span>
                </div>

                {selected.failure_reason && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                    <div className="flex items-start gap-2 text-xs text-destructive">
                      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold mb-0.5">Failure reason</div>
                        <div>{selected.failure_reason}</div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="text-muted-foreground mb-0.5">Agent</div>
                    <div className="font-medium">{profiles[selected.agent_id]?.full_name ?? selected.agent_id.slice(0, 8)}</div>
                    <div className="text-muted-foreground">{profiles[selected.agent_id]?.phone ?? '—'}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Tenant</div>
                    <div className="font-medium">{profiles[selected.tenant_id]?.full_name ?? selected.tenant_id.slice(0, 8)}</div>
                    <div className="text-muted-foreground">{profiles[selected.tenant_id]?.phone ?? '—'}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Amount</div>
                    <div className="font-semibold">{formatUGX(Number(selected.amount))}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Server receipt</div>
                    <div className="font-mono">{selected.server_receipt_no ?? '—'}</div>
                  </div>
                </div>

                {(selected.gps_lat != null && selected.gps_lng != null) && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs flex items-start gap-2">
                    <MapPin className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <div>
                      <div className="font-medium">GPS at capture</div>
                      <div className="text-muted-foreground font-mono">
                        {selected.gps_lat.toFixed(5)}, {selected.gps_lng.toFixed(5)}
                      </div>
                      {selected.gps_accuracy != null && (
                        <div className="text-muted-foreground">±{Math.round(selected.gps_accuracy)}m accuracy</div>
                      )}
                    </div>
                  </div>
                )}

                {selected.notes && (
                  <div className="rounded-lg border border-border p-3">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Agent notes</div>
                    <div className="text-xs">{selected.notes}</div>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    {proofIcon(selected.proof_type)}
                    Proof — {selected.proof_type}
                  </div>
                  {selected.proof_type === 'sms_code' ? (
                    <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
                      Tenant confirmation code captured at submission. Verify against tenant SMS log if disputed.
                    </div>
                  ) : proofLoading ? (
                    <div className="rounded-lg border border-dashed border-border p-6 flex items-center justify-center">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : proofUrl ? (
                    <a href={proofUrl} target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-border overflow-hidden">
                      <img
                        src={proofUrl}
                        alt={`Proof ${selected.proof_type}`}
                        className="w-full max-h-80 object-contain bg-muted/30"
                      />
                    </a>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
                      No proof media on file.
                    </div>
                  )}
                </div>

                {(selected.status === 'processing' || selected.status === 'rejected') && (
                  <div className="flex flex-col gap-2 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={markNeedsAttention}
                      disabled={resolving}
                      className="gap-1.5"
                    >
                      <AlertCircle className="h-3.5 w-3.5" />
                      Flag for manual review
                    </Button>
                    {selected.status !== 'rejected' && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={markResolved}
                        disabled={resolving}
                        className="gap-1.5"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        Reject — require re-collection
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}