import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import {
  ShieldQuestion, CheckCircle2, XCircle, Phone, Loader2, UserCircle, MapPin,
  ChevronDown, ChevronUp, Search, FileDown, Clock, BadgeCheck, RefreshCw, X,
  Inbox, FileClock, ShieldOff,
} from 'lucide-react';
import { ReverseVerificationDialog } from './ReverseVerificationDialog';
import { cn } from '@/lib/utils';
import {
  generateLc1VerificationReportPdf,
  lc1ReportFileName,
  type Lc1ReportRow,
  type Lc1ReportScope,
} from '@/lib/generateLc1VerificationReportPdf';

/** Inbox buckets. `agent_requested` / `rent_linked` are focused slices of `pending`. */
export type Lc1InboxStatus = 'agent_requested' | 'rent_linked' | 'pending' | 'verified' | 'rejected';

export interface Lc1InboxRow extends Lc1ReportRow {
  agent_request_open?: boolean | null;
  has_open_rent_request?: boolean | null;
  open_rent_requests?: number | null;
}

const TABS: Lc1InboxStatus[] = ['agent_requested', 'rent_linked', 'pending', 'verified', 'rejected'];

interface Props {
  onResolved?: () => void;
  /** Full-page mode: always expanded, larger page size, export controls. */
  standalone?: boolean;
  /** Which bucket to open on. */
  initialStatus?: Lc1InboxStatus;
}

const PAGE = 25;

const TAB_META: Record<Lc1InboxStatus, { label: string; icon: typeof Clock; cls: string }> = {
  agent_requested: { label: 'Agent requested', icon: Inbox, cls: 'bg-blue-100 text-blue-700 border-blue-300' },
  rent_linked: { label: 'Rent application waiting', icon: FileClock, cls: 'bg-teal-100 text-teal-700 border-teal-300' },
  pending: { label: 'Pending', icon: Clock, cls: 'bg-amber-100 text-amber-700 border-amber-300' },
  verified: { label: 'Approved', icon: BadgeCheck, cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
  rejected: { label: 'Rejected', icon: XCircle, cls: 'bg-rose-100 text-rose-700 border-rose-300' },
};

/** Applies the bucket filter to a `v_lc1_verification_inbox` query. */
function applyBucket(q: any, bucket: Lc1InboxStatus) {
  // Chairpersons still being vetted by their Service Centre manager are not yet
  // Landlord Ops work — they arrive here only once the manager passes them on.
  const base = q.neq('service_center_status', 'pending');
  if (bucket === 'agent_requested') return base.eq('status', 'pending').eq('agent_request_open', true);
  if (bucket === 'rent_linked') return base.eq('status', 'pending').eq('has_open_rent_request', true);
  return base.eq('status', bucket);
}

function StatusBadge({ status }: { status: string | null }) {
  if (status === 'verified') {
    return <Badge className="bg-emerald-500/15 text-emerald-700 border-0 text-[10px] font-bold gap-0.5"><BadgeCheck className="h-3 w-3" />Approved</Badge>;
  }
  if (status === 'rejected') {
    return <Badge className="bg-destructive/15 text-destructive border-0 text-[10px] font-bold gap-0.5"><XCircle className="h-3 w-3" />Rejected</Badge>;
  }
  return <Badge className="bg-amber-500/15 text-amber-700 border-0 text-[10px] font-bold gap-0.5"><Clock className="h-3 w-3" />Pending</Badge>;
}

/**
 * THE single LC1 chairperson verification inbox ("Agents requesting LC1
 * verification").
 *
 * Source of truth: `v_lc1_verification_inbox` — every LC1 chairperson with its
 * canonical `verification_status`, whether or not an agent raised a request
 * row. This removes the historic split where agent-raised items landed here
 * while everything else only appeared in the separate "GPS & LC1 Verification"
 * screen (and where verifications done here never wrote a status, so 30 rows
 * were invisible everywhere).
 *
 * Decisions go exclusively through the `set_lc1_verification` RPC so status,
 * `verified` flag, request trail, audit log, borrower notification and the
 * agent rejection penalty always move together.
 */
export function Lc1VerificationInboxPanel({ onResolved, standalone = false, initialStatus = 'agent_requested' }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();

  const [status, setStatus] = useState<Lc1InboxStatus>(initialStatus);
  const [rows, setRows] = useState<Lc1InboxRow[]>([]);
  const [counts, setCounts] = useState<Record<Lc1InboxStatus, number>>({
    agent_requested: 0, rent_linked: 0, pending: 0, verified: 0, rejected: 0,
  });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [isOpen, setIsOpen] = useState(standalone);
  const [exporting, setExporting] = useState(false);
  const [reverseRow, setReverseRow] = useState<{ id: string; name: string | null } | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [decideId, setDecideId] = useState<string | null>(null);
  const [decision, setDecision] = useState<'verified' | 'rejected'>('verified');
  const [reason, setReason] = useState('');

  const pageSize = standalone ? PAGE : 10;

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const applySearch = useCallback((q: any) => {
    if (debounced.length < 2) return q;
    const digits = debounced.replace(/\D/g, '');
    const parts = [
      `lc1_name.ilike.%${debounced}%`,
      `lc1_phone.ilike.%${debounced}%`,
      `lc1_village.ilike.%${debounced}%`,
      `lc1_district.ilike.%${debounced}%`,
      `agent_name.ilike.%${debounced}%`,
    ];
    if (digits.length >= 3 && digits !== debounced) parts.push(`lc1_phone.ilike.%${digits}%`);
    return q.or(parts.join(','));
  }, [debounced]);

  const loadCounts = useCallback(async () => {
    const next: Record<Lc1InboxStatus, number> = {
      agent_requested: 0, rent_linked: 0, pending: 0, verified: 0, rejected: 0,
    };
    await Promise.all(TABS.map(async (s) => {
      let q = (supabase as any)
        .from('v_lc1_verification_inbox')
        .select('lc1_id', { count: 'exact', head: true });
      q = applyBucket(q, s);
      q = applySearch(q);
      const { count } = await q;
      next[s] = count || 0;
    }));
    setCounts(next);
  }, [applySearch]);

  const load = useCallback(async () => {
    setLoading(true);
    let q = (supabase as any)
      .from('v_lc1_verification_inbox')
      .select('*', { count: 'exact' });
    q = applyBucket(q, status);
    q = applySearch(q);
    // Open buckets: agent-raised requests first (they block a rent application),
    // then oldest registrations. Decided buckets: newest decision first.
    q = (status === 'verified' || status === 'rejected')
      ? q.order('verified_at', { ascending: false, nullsFirst: false }).order('resolved_at', { ascending: false, nullsFirst: false })
      : q.order('request_id', { ascending: false, nullsFirst: false }).order('requested_at', { ascending: true });
    const { data, error, count } = await q.range(page * pageSize, page * pageSize + pageSize - 1);
    if (error) {
      console.error('[LC1 inbox] load failed', error);
      setRows([]);
    } else {
      setRows((data ?? []) as Lc1InboxRow[]);
      setTotal(count || 0);
    }
    setLoading(false);
  }, [status, page, pageSize, applySearch]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadCounts(); }, [loadCounts]);

  // Live updates: new agent requests / newly registered chairpersons.
  useEffect(() => {
    const channel = supabase
      .channel('lc1-verification-inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lc1_verification_requests' }, () => { load(); loadCounts(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lc1_chairpersons' }, () => { loadCounts(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load, loadCounts]);

  const openDecide = (row: Lc1InboxRow, preset: 'verified' | 'rejected') => {
    setDecideId(row.lc1_id);
    setDecision(preset);
    setReason('');
  };

  const submitDecision = async (row: Lc1InboxRow) => {
    if (!user) return;
    const note = reason.trim();
    if (note.length < 10) {
      toast({ title: 'Reason required', description: 'Give at least 10 characters explaining this decision.', variant: 'destructive' });
      return;
    }
    setBusyId(row.lc1_id);
    const { data, error } = await supabase.rpc('set_lc1_verification' as any, {
      p_lc1_id: row.lc1_id,
      p_status: decision,
      p_reason: note,
    } as any);
    setBusyId(null);
    if (error) {
      toast({ title: decision === 'verified' ? 'Verify failed' : 'Reject failed', description: error.message || 'Could not update this chairperson', variant: 'destructive' });
      return;
    }
    const result = (data ?? {}) as { agent_id?: string | null; agent_charged?: boolean; charge_amount?: number };
    const charged = !!result.agent_charged && (result.charge_amount ?? 0) > 0;
    toast({
      title: decision === 'verified' ? '✅ LC1 chairperson approved' : 'Request rejected',
      description: `${row.lc1_name || 'LC1 chairperson'} is now ${decision === 'verified' ? 'approved — it appears under LC1 Chairpersons' : 'rejected'}.`
        + (charged ? ` UGX ${result.charge_amount!.toLocaleString()} was charged to the registering agent.` : ''),
    });

    if (decision === 'rejected' && result.agent_id) {
      supabase.functions.invoke('send-push-notification', {
        body: {
          userIds: [result.agent_id],
          payload: {
            title: '🚫 LC1 chairperson rejected',
            body: `The LC1 chairperson "${row.lc1_name || 'chairperson'}" you registered was rejected. Reason: ${note}.`
              + (charged ? ` UGX ${result.charge_amount!.toLocaleString()} was debited from your wallet.` : ''),
            type: 'warning',
            url: '/dashboard/agent',
          },
        },
      }).catch((e) => console.error('send-push-notification (lc1 rejection) failed', e));
    }

    setDecideId(null);
    setReason('');
    setRows(prev => prev.filter(r => r.lc1_id !== row.lc1_id));
    load();
    loadCounts();
    onResolved?.();
  };

  const exportReport = async (scope: Lc1ReportScope) => {
    setExporting(true);
    try {
      const { data, error } = await supabase.rpc('ops_lc1_verification_report' as any, {
        p_status: scope,
        p_search: debounced.length >= 2 ? debounced : null,
        p_limit: 3000,
      } as any);
      if (error) throw error;
      const reportRows = (data ?? []) as Lc1ReportRow[];
      const blob = generateLc1VerificationReportPdf(reportRows, {
        scope,
        search: debounced.length >= 2 ? debounced : null,
        totalMatches: scope === 'all'
          ? counts.pending + counts.verified + counts.rejected
          : counts[scope as Lc1InboxStatus] ?? 0,
        generatedBy: (user as any)?.email ?? null,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const filename = lc1ReportFileName(scope);
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: 'Report ready', description: `${reportRows.length.toLocaleString()} chairpersons exported.` });

      // Bulk export of up to 3000 LC1 chairperson verification records at
      // once, not logged before this. Plain client-side insert so the
      // audit_logs IP-capture trigger sees the real browser IP directly.
      // Never blocks the actual download.
      (async () => {
        try {
          const { data: { user: actor } } = await supabase.auth.getUser();
          await supabase.from('audit_logs').insert({
            user_id: actor?.id ?? null,
            action_type: 'pdf_report_exported',
            table_name: 'export',
            record_id: null,
            metadata: { filename, row_count: reportRows.length },
          });
        } catch (e) {
          console.warn('[Lc1VerificationInboxPanel] audit log insert failed:', e);
        }
      })();
    } catch (e: any) {
      toast({ title: 'Export failed', description: e?.message || 'Could not build the report', variant: 'destructive' });
    } finally {
      setExporting(false);
    }
  };

  const pages = Math.max(1, Math.ceil(total / pageSize));
  // The section badge counts real agent-raised work, not the registration backlog.
  const headerCount = counts.agent_requested;

  const body = (
    <div className="space-y-3">
      {/* Status tabs */}
      <div className="flex flex-wrap gap-1.5">
        {TABS.map(s => {
          const meta = TAB_META[s];
          const Icon = meta.icon;
          const active = status === s;
          return (
            <button
              key={s}
              onClick={() => { setStatus(s); setPage(0); }}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 h-8 rounded-full text-[11px] font-bold border transition-all',
                active ? `${meta.cls} shadow-sm` : 'bg-background text-muted-foreground border-border hover:bg-muted',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {meta.label}
              <span className={cn('text-[9px] font-bold px-1 rounded-full', active ? 'bg-white/50' : 'bg-black/5')}>
                {counts[s].toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>

      {/* Bucket explainer — keeps the registration backlog from being mistaken for agent work */}
      <p className="text-[10px] text-muted-foreground leading-snug">
        {status === 'agent_requested'
          ? 'Chairpersons an agent explicitly raised for verification and is still waiting on. This is the real inbox.'
          : status === 'rent_linked'
          ? 'Chairpersons attached to a rent application still moving through approval — verifying these unblocks a tenant.'
          : status === 'pending'
          ? 'Every unverified chairperson in the register, including bulk field registrations nobody has requested. Large by design.'
          : `Chairpersons already ${status === 'verified' ? 'approved' : 'rejected'}.`}
      </p>

      {/* Search + export */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chairperson, phone, village, district or agent…"
            className="h-9 text-sm pl-8 pr-8"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2" aria-label="Clear search">
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 sm:flex gap-2 shrink-0">
          <Button size="sm" variant="outline" className="h-9 text-[11px] font-bold min-w-0" disabled={exporting} onClick={() => exportReport(status)}>
            {exporting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileDown className="h-3.5 w-3.5 mr-1 shrink-0" />}
            <span className="truncate">Export {TAB_META[status].label.toLowerCase()}</span>
          </Button>
          <Button size="sm" variant="outline" className="h-9 text-[11px] font-bold min-w-0" disabled={exporting} onClick={() => exportReport('all')}>
            <FileDown className="h-3.5 w-3.5 mr-1 shrink-0" />
            <span className="truncate">Full register</span>
          </Button>
          <Button size="sm" variant="ghost" className="h-9 text-[11px] font-bold" onClick={() => { load(); loadCounts(); }}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground py-8">
          No {TAB_META[status].label.toLowerCase()} LC1 chairpersons{debounced ? ' for this search' : ''}.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {rows.map(row => (
            <li key={row.lc1_id} className="rounded-xl border border-border bg-background p-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-sm text-foreground truncate">{row.lc1_name || 'Unnamed LC1 chairperson'}</p>
                  {row.lc1_phone && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                      <Phone className="h-3 w-3 shrink-0" /> {row.lc1_phone}
                    </p>
                  )}
                  {(row.lc1_village || row.lc1_district) && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {[row.lc1_village, row.lc1_district].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-1 truncate">
                    <UserCircle className="h-3.5 w-3.5 shrink-0" />
                    {row.source === 'agent_request' ? 'Requested by ' : 'Registered by '}
                    <span className="font-medium text-foreground">{row.agent_name || 'Unknown agent'}</span>
                    {row.agent_phone ? ` · ${row.agent_phone}` : ''}
                  </p>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1">
                  <StatusBadge status={row.status} />
                  {row.agent_request_open && row.status === 'pending' && (
                    <Badge variant="outline" className="text-[9px] border-amber-500/40 text-amber-700">Agent raised</Badge>
                  )}
                  {row.has_open_rent_request && row.status === 'pending' && (
                    <Badge variant="outline" className="text-[9px] border-teal-500/40 text-teal-700">
                      {(row.open_rent_requests ?? 1) > 1
                        ? `${row.open_rent_requests} rent applications waiting`
                        : 'Rent application waiting'}
                    </Badge>
                  )}
                </div>
              </div>

              {(row.agent_note || row.reason || row.reject_comment) && (
                <p className="text-[11px] text-muted-foreground rounded-lg bg-muted px-2 py-1.5 break-words">
                  <span className="font-semibold">
                    {row.status === 'pending' ? 'Agent note: ' : 'Decision reason: '}
                  </span>
                  {row.status === 'pending' ? (row.agent_note || row.reason) : (row.reason || row.reject_comment)}
                </p>
              )}

              {row.status !== 'pending' && (
                <p className="text-[10px] text-muted-foreground">
                  {row.status === 'verified' ? 'Approved' : 'Rejected'}
                  {(row.reviewer_name || row.resolved_by_name) ? ` by ${row.reviewer_name || row.resolved_by_name}` : ''}
                  {(row.verified_at || row.resolved_at) ? ` · ${new Date((row.verified_at || row.resolved_at) as string).toLocaleDateString()}` : ''}
                </p>
              )}

              {decideId === row.lc1_id ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    {(['verified', 'rejected'] as const).map(d => (
                      <button
                        key={d}
                        onClick={() => setDecision(d)}
                        className={cn(
                          'h-9 rounded-xl border text-[11px] font-bold transition-colors',
                          decision === d
                            ? d === 'verified' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-destructive text-white border-destructive'
                            : 'bg-background border-border text-muted-foreground',
                        )}
                      >
                        {d === 'verified' ? 'Approve' : 'Reject'}
                      </button>
                    ))}
                  </div>
                  <Textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={decision === 'rejected'
                      ? 'Why is this LC1 chairperson rejected? (shown to the agent, min 10 characters)'
                      : 'What confirmed this LC1 chairperson? (min 10 characters)'}
                    className="min-h-[64px] text-sm"
                  />
                  <p className="text-[10px] text-muted-foreground">{reason.trim().length}/10 characters minimum</p>
                  {decision === 'rejected' && (
                    <p className="text-[10px] text-amber-700">
                      Rejecting charges the registering agent UGX 2,000 and notifies them.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className={cn('flex-1', decision === 'verified' ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : '')}
                      variant={decision === 'rejected' ? 'destructive' : 'default'}
                      disabled={busyId === row.lc1_id || reason.trim().length < 10}
                      onClick={() => submitDecision(row)}
                    >
                      {busyId === row.lc1_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
                      Confirm {decision === 'verified' ? 'approval' : 'rejection'}
                    </Button>
                    <Button size="sm" variant="ghost" className="flex-1" disabled={busyId === row.lc1_id} onClick={() => { setDecideId(null); setReason(''); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 text-[11px] font-bold"
                    disabled={row.status === 'verified'}
                    onClick={() => openDecide(row, 'verified')}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-[11px] font-bold border-rose-500/40 text-rose-700 hover:bg-rose-50"
                    disabled={row.status === 'rejected'}
                    onClick={() => openDecide(row, 'rejected')}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1" /> Reject
                  </Button>
                  {row.status === 'verified' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="col-span-2 h-8 text-[11px] font-bold border-destructive/40 text-destructive hover:bg-destructive/5"
                      onClick={() => setReverseRow({ id: row.lc1_id, name: row.lc1_name || null })}
                    >
                      <ShieldOff className="h-3.5 w-3.5 mr-1" /> Reverse verification
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Pagination */}
      {total > pageSize && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button size="sm" variant="outline" className="h-8 text-[11px]" disabled={page === 0 || loading} onClick={() => setPage(p => Math.max(0, p - 1))}>
            Previous
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Page {page + 1} of {pages.toLocaleString()} · {total.toLocaleString()} {TAB_META[status].label.toLowerCase()}
          </p>
          <Button size="sm" variant="outline" className="h-8 text-[11px]" disabled={page + 1 >= pages || loading} onClick={() => setPage(p => p + 1)}>
            Next
          </Button>
        </div>
      )}

      {/* Ops-only: undo a verification (and its bonus payment) done by mistake */}
      {reverseRow && (
        <ReverseVerificationDialog
          open
          onOpenChange={(v) => { if (!v) setReverseRow(null); }}
          entityType="lc1"
          entityId={reverseRow.id}
          entityName={reverseRow.name}
          onReversed={() => { setReverseRow(null); load(); loadCounts(); onResolved?.(); }}
        />
      )}
    </div>
  );

  if (standalone) {
    return <div className="space-y-3">{body}</div>;
  }

  return (
    <div className="rounded-2xl border-2 border-amber-500/50 bg-amber-50/60 dark:bg-amber-500/5 p-4 space-y-3 shadow-sm">
      <button
        type="button"
        onClick={() => setIsOpen(v => !v)}
        className="w-full flex items-center gap-2.5 text-left group"
        aria-expanded={isOpen}
      >
        <div className="p-2 rounded-xl bg-amber-500/15">
          <ShieldQuestion className="h-[18px] w-[18px] text-amber-600 shrink-0" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm leading-tight flex items-center gap-2">
            Agents requesting LC1 verification
            {headerCount > 0 && <Badge className="bg-amber-600 text-white hover:bg-amber-600">{headerCount.toLocaleString()}</Badge>}
          </p>
          <p className="text-[11px] text-muted-foreground leading-snug">
            Agent-raised requests come first; the full unverified register is on the Pending tab.
          </p>
        </div>
        <div className="ml-auto shrink-0 p-1.5 rounded-md hover:bg-amber-500/10 transition-colors">
          {isOpen ? <ChevronUp className="h-4 w-4 text-amber-700" /> : <ChevronDown className="h-4 w-4 text-amber-700" />}
        </div>
      </button>
      {isOpen && body}
    </div>
  );
}