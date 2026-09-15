import React, { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { FileText, ArrowRight, Clock, CheckCircle, XCircle, TrendingUp, Search, Loader2, Check, X, AlertTriangle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { usePromissoryOpsReport, PROMISSORY_RANGES, type PromissoryRange } from '@/hooks/usePromissoryOpsReport';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { AgentCallMenu } from '../PromissoryNotesQueue';

const QUICK_LIST_SIZE = 6;

type PromissoryStatus = 'pending' | 'activated' | 'rejected' | 'overdue';

export interface PromissoryOverviewFilter {
  status?: PromissoryStatus;
  search?: string;
  range?: PromissoryRange;
}

const PILL_CONFIG: { key: PromissoryStatus; label: string; icon: React.ElementType }[] = [
  { key: 'pending', label: 'Awaiting Review', icon: Clock },
  { key: 'activated', label: 'Approved', icon: CheckCircle },
  { key: 'rejected', label: 'Rejected', icon: XCircle },
  { key: 'overdue', label: 'Overdue', icon: AlertTriangle },
];

function matchesSearch(note: any, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  const haystack = [
    note.partner_name,
    note.agent_name,
    note.whatsapp_number,
    note.phone_number,
    note.email,
    note.came_in_name,
    note.lead_partner_name,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q);
}

/**
 * Prominent overview entry point for the Promissory Notes workspace.
 * Surfaces live queue stats so Partner Ops can see workload at a glance.
 */
export function PromissoryNotesOverviewCard({ onOpen }: { onOpen: (filter?: PromissoryOverviewFilter) => void }) {
  const { report, isLoading, range, setRange } = usePromissoryOpsReport();
  const { kpis, notes } = report;
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<PromissoryStatus>(() => {
    const saved = localStorage.getItem('promissory-queue-status-filter');
    return saved === 'activated' || saved === 'rejected' || saved === 'pending' || saved === 'overdue' ? saved : 'pending';
  });
  const [search, setSearch] = useState('');
  const [approveTarget, setApproveTarget] = useState<any>(null);
  const [approveReason, setApproveReason] = useState('');
  const [approving, setApproving] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<any>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  const isOverdue = (n: any) => {
    if (!n.fulfilment_due_on) return false;
    const due = new Date(n.fulfilment_due_on);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (due >= today) return false;
    const outstanding = Number(n.outstanding ?? (Number(n.amount) - Number(n.total_collected)));
    return outstanding > 0;
  };

  const filteredNotes = useMemo(() => notes.filter((n) => matchesSearch(n, search)), [notes, search]);

  const counts = {
    pending: filteredNotes.filter((n) => n.status === 'pending').length,
    activated: filteredNotes.filter((n) => n.status === 'activated').length,
    rejected: filteredNotes.filter((n) => n.status === 'cancelled' || n.status === 'defaulted').length,
    overdue: filteredNotes.filter(isOverdue).length,
  };

  const statusNotes = useMemo(() => {
    const match = (n: any) =>
      selected === 'pending' ? n.status === 'pending'
      : selected === 'activated' ? n.status === 'activated'
      : selected === 'rejected' ? n.status === 'cancelled' || n.status === 'defaulted'
      : isOverdue(n);
    return filteredNotes.filter(match).slice(0, QUICK_LIST_SIZE);
  }, [filteredNotes, selected]);

  const handleQuickApprove = async () => {
    if (!approveTarget) return;
    const reason = approveReason.trim();
    if (reason.length < 20) {
      toast.error('Please provide a reason of at least 20 characters.');
      return;
    }
    setApproving(true);
    try {
      const { data, error } = await supabase.rpc('approve_promissory_note', {
        p_note_id: approveTarget.id,
        p_reason: reason,
      });
      if (error) throw error;
      const res = data as any;
      if (res?.status === 'error') throw new Error(res.message);
      if (res?.status === 'already_approved') {
        toast.info('This promissory note was already approved.');
      } else {
        toast.success('Approved — UGX 1,500 credited to the agent’s wallet.');
      }
      setApproveTarget(null);
      setApproveReason('');
      queryClient.invalidateQueries({ queryKey: ['promissory-ops-report'] });
    } catch (err: any) {
      toast.error(err?.message || 'Failed to approve promissory note.');
    } finally {
      setApproving(false);
    }
  };

  const handleQuickReject = async () => {
    if (!rejectTarget) return;
    const reason = rejectReason.trim();
    if (reason.length < 20) {
      toast.error('Please provide a reason of at least 20 characters.');
      return;
    }
    setRejecting(true);
    try {
      const { data, error } = await supabase.rpc('reverse_promissory_note_bonus' as any, {
        p_note_id: rejectTarget.id,
        p_reason: reason,
      });
      if (error) throw error;
      const res = data as any;
      if (res?.status === 'error') throw new Error(res.message);
      toast.success(res?.status === 'reversed' ? 'Rejected — bonus reversed.' : (res?.message || 'Note rejected.'));
      setRejectTarget(null);
      setRejectReason('');
      queryClient.invalidateQueries({ queryKey: ['promissory-ops-report'] });
    } catch (err: any) {
      toast.error(err?.message || 'Failed to reject promissory note.');
    } finally {
      setRejecting(false);
    }
  };

  const activeFilter: PromissoryOverviewFilter = { status: selected, search, range };

  const selectedLabel = PILL_CONFIG.find((p) => p.key === selected)?.label ?? 'Awaiting Review';
  const rangeLabel = PROMISSORY_RANGES.find((r) => r.key === range)?.label ?? 'All time';
  const filtersChanged = selected !== 'pending' || !!search.trim() || range !== 'all';

  React.useEffect(() => {
    localStorage.setItem('promissory-queue-status-filter', selected);
  }, [selected]);

  const openLabel = {
    pending: 'Open awaiting review',
    activated: 'Open approved',
    rejected: 'Open rejected',
    overdue: 'Open overdue',
  }[selected];

  return (
    <Card
      className="bg-primary/[0.04] border border-primary/30 border-l-4 border-l-primary cursor-pointer hover:bg-primary/[0.07] transition-colors shadow-sm"
      onClick={() => onOpen(activeFilter)}
      role="button"
      aria-label="Open Promissory Notes"
    >
      <CardContent className="p-4 sm:p-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-2xl bg-primary/15 shrink-0">
            <FileText className="h-7 w-7 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-lg font-bold text-foreground">Promissory Notes</p>
              {!isLoading && (
                <Badge variant="secondary" className="text-xs font-semibold">
                  {kpis.notes_count.toLocaleString()} total
                </Badge>
              )}
              {counts.pending > 0 && (
                <Badge variant="destructive" className="text-xs font-semibold">
                  {counts.pending.toLocaleString()} awaiting review
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Review partner commitments, approve notes &amp; track collections
            </p>
          </div>
          <Button size="sm" className="gap-1.5 shrink-0" onClick={(e) => { e.stopPropagation(); onOpen(activeFilter); }} aria-label={openLabel}>
            {openLabel} <ArrowRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="rounded-lg border bg-background/70 p-3 space-y-3" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Filters</p>
            <div className="flex items-center gap-2">
              <p className="text-[11px] text-muted-foreground">
                Showing <span className="font-semibold text-foreground">{selectedLabel}</span>
                {' · '}<span className="font-semibold text-foreground">{rangeLabel}</span>
                {search.trim() ? <> · search “<span className="font-semibold text-foreground">{search.trim()}</span>”</> : null}
              </p>
              {filtersChanged && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px] gap-1"
                  onClick={() => { setSelected('pending'); setSearch(''); setRange('all'); }}
                >
                  <X className="h-3 w-3" /> Clear filters
                </Button>
              )}
            </div>
          </div>

          <div>
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">Status</p>
            <div className="flex flex-wrap gap-2">
              {PILL_CONFIG.map(({ key, label, icon: Icon }) => {
                const active = selected === key;
                return (
                  <button
                    key={key}
                    onClick={() => setSelected(key)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all',
                      active
                        ? 'bg-primary text-primary-foreground shadow-sm ring-2 ring-primary/30'
                        : 'bg-background text-muted-foreground hover:bg-accent border'
                    )}
                    aria-pressed={active}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span>{label}</span>
                    {!isLoading && (
                      <span className={cn('ml-0.5 tabular-nums', active ? 'text-primary-foreground/80' : 'text-muted-foreground/80')}>
                        {counts[key].toLocaleString()}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">Search</p>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Partner, agent, phone or email..."
                  className="h-8 pl-8 pr-7 text-xs"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">Date range</p>
              <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
                {PROMISSORY_RANGES.map((r) => (
                  <button
                    key={r.key}
                    onClick={() => setRange(r.key)}
                    className={cn(
                      'shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium transition-all',
                      range === r.key
                        ? 'bg-primary text-primary-foreground ring-2 ring-primary/30'
                        : 'bg-background text-muted-foreground hover:bg-accent border'
                    )}
                    aria-pressed={range === r.key}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>


        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border bg-background/60 p-2.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium uppercase tracking-wide">Awaiting review</span>
            </div>
            <p className="text-sm font-bold mt-1">{isLoading ? '…' : counts.pending.toLocaleString()}</p>
          </div>
          <div className="rounded-lg border bg-background/60 p-2.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <CheckCircle className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium uppercase tracking-wide">Approved</span>
            </div>
            <p className="text-sm font-bold mt-1">{isLoading ? '…' : counts.activated.toLocaleString()}</p>
          </div>
          <div className="rounded-lg border bg-background/60 p-2.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium uppercase tracking-wide">Promised</span>
            </div>
            <p className="text-sm font-bold mt-1 truncate">{isLoading ? '…' : formatUGX(kpis.promised_total)}</p>
          </div>
        </div>

        {!isLoading && statusNotes.length > 0 && (
          <div className="rounded-lg border bg-background/60 divide-y">
            {statusNotes.map((note: any) => (
              <div key={note.id} className="flex items-center gap-2 px-3 py-2" onClick={(e) => e.stopPropagation()}>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold truncate">{note.partner_name || 'Unknown partner'}</p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {note.agent_name ? (
                      <>
                        Agent: <AgentCallMenu note={note} className="text-[10px] font-medium" />
                      </>
                    ) : 'No agent'}
                    {note.promised_amount ? ` · ${formatUGX(Number(note.promised_amount))}` : ''}
                  </p>
                </div>
                {selected === 'pending' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[10px] gap-1 shrink-0 border-emerald-500/40 text-emerald-700 hover:bg-emerald-50"
                    onClick={() => { setApproveReason(''); setApproveTarget(note); }}
                    aria-label={`Approve ${note.partner_name || 'note'}`}
                  >
                    <Check className="h-3 w-3" /> Approve
                  </Button>
                )}
                {selected === 'activated' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[10px] gap-1 shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={() => { setRejectReason(''); setRejectTarget(note); }}
                    aria-label={`Reject ${note.partner_name || 'note'}`}
                  >
                    <X className="h-3 w-3" /> Reject
                  </Button>
                )}
              </div>
            ))}
            {counts[selected] > QUICK_LIST_SIZE && (
              <button
                className="w-full px-3 py-1.5 text-[10px] text-primary font-medium hover:underline text-center"
                onClick={(e) => { e.stopPropagation(); onOpen(activeFilter); }}
              >
                View all {counts[selected].toLocaleString()} →
              </button>
            )}
          </div>
        )}
      </CardContent>

      <AlertDialog open={!!approveTarget} onOpenChange={(open) => { if (!open && !approving) { setApproveTarget(null); setApproveReason(''); } }}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve promissory note?</AlertDialogTitle>
            <AlertDialogDescription>
              This marks {approveTarget?.partner_name}'s promissory note as verified and credits UGX 1,500 to {approveTarget?.agent_name}'s wallet. A reason is required and this action is recorded in the audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={approveReason}
            onChange={(e) => setApproveReason(e.target.value)}
            placeholder="Reason for approval (min 20 characters)"
            className="min-h-[80px] text-sm"
          />
          <AlertDialogFooter>
            <Button variant="outline" disabled={approving} onClick={() => { setApproveTarget(null); setApproveReason(''); }}>
              Cancel
            </Button>
            <Button disabled={approving || approveReason.trim().length < 20} onClick={handleQuickApprove}>
              {approving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              {approving ? 'Approving…' : 'Approve & Pay'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!rejectTarget} onOpenChange={(open) => { if (!open && !rejecting) { setRejectTarget(null); setRejectReason(''); } }}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject approved promissory note?</AlertDialogTitle>
            <AlertDialogDescription>
              This reverses the approval of {rejectTarget?.partner_name}'s promissory note. A reason of at least 20 characters is required and this action is recorded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason for rejection (min 20 characters)"
            className="min-h-[80px] text-sm"
          />
          <AlertDialogFooter>
            <Button variant="outline" disabled={rejecting} onClick={() => { setRejectTarget(null); setRejectReason(''); }}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={rejecting || rejectReason.trim().length < 20} onClick={handleQuickReject}>
              {rejecting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              {rejecting ? 'Rejecting…' : 'Reject & Reverse'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
