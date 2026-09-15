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
import { FileText, ArrowRight, Clock, CheckCircle, XCircle, TrendingUp, Search, Loader2, Check, X, AlertTriangle, ChevronDown, ChevronUp, Phone, MessageCircle, Mail, Calendar, BadgeCheck } from 'lucide-react';
import { format } from 'date-fns';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { usePromissoryOpsReport, PROMISSORY_RANGES, type PromissoryRange } from '@/hooks/usePromissoryOpsReport';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { AgentCallMenu } from '../PromissoryNotesQueue';

const QUICK_LIST_SIZE = 6;

type PromissoryStatus = 'pending' | 'activated' | 'rejected' | 'overdue' | 'fulfilled';

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
    return saved === 'activated' || saved === 'rejected' || saved === 'pending' || saved === 'overdue' || saved === 'fulfilled' ? saved : 'pending';
  });
  const [search, setSearch] = useState('');
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem('promissory-overview-collapsed');
    return saved === 'true';
  });
  const [approveTarget, setApproveTarget] = useState<any>(null);
  const [approveReason, setApproveReason] = useState('');
  const [approving, setApproving] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<any>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [detailNote, setDetailNote] = useState<any>(null);

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
    fulfilled: filteredNotes.filter((n) => n.status === 'fulfilled').length,
  };

  const statusNotes = useMemo(() => {
    const match = (n: any) =>
      selected === 'pending' ? n.status === 'pending'
      : selected === 'activated' ? n.status === 'activated'
      : selected === 'rejected' ? n.status === 'cancelled' || n.status === 'defaulted'
      : selected === 'fulfilled' ? n.status === 'fulfilled'
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

  React.useEffect(() => {
    localStorage.setItem('promissory-overview-collapsed', String(isCollapsed));
  }, [isCollapsed]);

  const openLabel = {
    pending: 'Open awaiting review',
    activated: 'Open approved',
    rejected: 'Open rejected',
    overdue: 'Open overdue',
    fulfilled: 'Open completed',
  }[selected];

  return (
    <Card
      className="rounded-2xl bg-primary/[0.04] border border-primary/30 border-l-4 border-l-primary cursor-pointer hover:bg-primary/[0.07] transition-colors shadow-sm"
      onClick={() => onOpen(activeFilter)}
      role="button"
      aria-label="Open Promissory Notes"
    >
      <CardContent className="p-4 space-y-2.5">
        <div className="flex items-center gap-2.5">
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
              {isCollapsed ? 'Tap to expand filters & queue preview' : 'Review partner commitments, approve notes &amp; track collections'}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              className="h-9 w-9 px-0"
              onClick={(e) => { e.stopPropagation(); setIsCollapsed((c) => !c); }}
              aria-label={isCollapsed ? 'Expand Promissory Notes panel' : 'Collapse Promissory Notes panel'}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? <ChevronDown className="h-5 w-5" /> : <ChevronUp className="h-5 w-5" />}
            </Button>
            <Button size="sm" className="gap-1.5" onClick={(e) => { e.stopPropagation(); onOpen(activeFilter); }} aria-label={openLabel}>
              {openLabel} <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {isCollapsed && !isLoading && (
          <div className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{counts.pending.toLocaleString()}</span> awaiting review
            {' · '}
            <span className="font-semibold text-foreground">{formatUGX(kpis.promised_total)}</span> promised
          </div>
        )}

        <div
          className={cn(
            'grid transition-all duration-300 ease-in-out',
            isCollapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
          )}
        >
        <div className="overflow-hidden">
        <div className="space-y-2.5" aria-hidden={isCollapsed}>

        <div className="rounded-2xl border bg-background/70 p-4 space-y-2.5" onClick={(e) => e.stopPropagation()}>
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
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">Quick view</p>
            <div className="flex flex-wrap gap-2">
              {([
                { key: 'pending' as PromissoryStatus, label: 'Awaiting review', count: counts.pending },
                { key: 'fulfilled' as PromissoryStatus, label: 'Completed', count: counts.fulfilled },
              ]).map(({ key, label, count }) => {
                const active = selected === key;
                return (
                  <button
                    key={key}
                    onClick={() => setSelected(key)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all',
                      active
                        ? 'bg-primary text-primary-foreground shadow-sm ring-2 ring-primary/30'
                        : 'bg-background text-muted-foreground hover:bg-accent border'
                    )}
                    aria-pressed={active}
                  >
                    {label}
                    {!isLoading && (
                      <span className={cn('tabular-nums rounded-full px-1.5', active ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-foreground')}>
                        {count.toLocaleString()}
                      </span>
                    )}
                  </button>
                );
              })}
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

          <div className="flex flex-col sm:flex-row sm:items-end gap-2.5">
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
          <div className="rounded-2xl border bg-background/60 p-3">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium uppercase tracking-wide">Awaiting review</span>
            </div>
            <p className="text-sm font-bold mt-1">{isLoading ? '…' : counts.pending.toLocaleString()}</p>
          </div>
          <div className="rounded-2xl border bg-background/60 p-3">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <CheckCircle className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium uppercase tracking-wide">Approved</span>
            </div>
            <p className="text-sm font-bold mt-1">{isLoading ? '…' : counts.activated.toLocaleString()}</p>
          </div>
          <div className="rounded-2xl border bg-background/60 p-3">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium uppercase tracking-wide">Promised</span>
            </div>
            <p className="text-sm font-bold mt-1 truncate">{isLoading ? '…' : formatUGX(kpis.promised_total)}</p>
          </div>
        </div>

        {!isLoading && statusNotes.length > 0 && (
          <div className="rounded-2xl border bg-background/60 divide-y">
            {statusNotes.map((note: any) => (
              <div
                key={note.id}
                className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent/60 transition-colors"
                onClick={(e) => { e.stopPropagation(); setDetailNote(note); }}
                role="button"
                aria-label={`View details for ${note.partner_name || 'promissory note'}`}
              >
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

        </div>
        </div>
        </div>
      </CardContent>

      {/* Details drawer */}
      <Sheet open={!!detailNote} onOpenChange={(open) => { if (!open) setDetailNote(null); }}>
        <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl" onClick={(e) => e.stopPropagation()}>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              Promissory Note Details
            </SheetTitle>
          </SheetHeader>
          {detailNote && (() => {
            const statusMeta: Record<string, string> = {
              pending: 'Awaiting review',
              activated: 'Approved',
              fulfilled: 'Completed',
              cancelled: 'Rejected',
              defaulted: 'Defaulted',
            };
            const outstanding = Number(detailNote.outstanding ?? (Number(detailNote.amount) - Number(detailNote.total_collected)));
            const progress = Number(detailNote.amount) > 0 ? Math.min(100, (Number(detailNote.total_collected) / Number(detailNote.amount)) * 100) : 0;
            const overdue = isOverdue(detailNote);
            return (
              <div className="space-y-4 mt-4 overflow-y-auto max-h-[calc(85vh-80px)] pb-6">
                <div className="flex items-center justify-between">
                  <Badge variant={detailNote.status === 'pending' ? 'secondary' : 'outline'} className="text-xs">
                    {statusMeta[detailNote.status] ?? detailNote.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(detailNote.created_at), 'dd MMM yyyy HH:mm')}
                  </span>
                </div>

                {detailNote.fulfilment_due_on && outstanding > 0 && (
                  <div className={cn(
                    'flex items-center gap-2 rounded-md border p-2.5 text-xs font-medium',
                    overdue ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'border-primary/30 bg-primary/5 text-primary',
                  )}>
                    <Calendar className="h-3.5 w-3.5" />
                    Expected to be fulfilled by {format(new Date(detailNote.fulfilment_due_on), 'dd MMM yyyy')}
                    {overdue && ' — overdue'}
                  </div>
                )}

                <div className="rounded-2xl border bg-background/60 p-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase">Partner</p>
                  <p className="font-semibold text-sm">{detailNote.partner_name || 'Unknown partner'}</p>
                  {detailNote.whatsapp_number && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MessageCircle className="h-3.5 w-3.5" />
                      <span>{detailNote.whatsapp_number}</span>
                    </div>
                  )}
                  {detailNote.phone_number && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Phone className="h-3.5 w-3.5" />
                      <span>{detailNote.phone_number}</span>
                    </div>
                  )}
                  {detailNote.email && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Mail className="h-3.5 w-3.5" />
                      <span>{detailNote.email}</span>
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border bg-background/60 p-3 space-y-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase">Financial</p>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div>
                      <p className="text-xs text-muted-foreground">Promised</p>
                      <p className="font-bold text-sm">{formatUGX(Number(detailNote.amount))}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Collected</p>
                      <p className="font-bold text-sm">{formatUGX(Number(detailNote.total_collected))}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Outstanding</p>
                      <p className="font-bold text-sm text-primary">{formatUGX(outstanding)}</p>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-muted-foreground">
                      <span>Progress</span>
                      <span>{progress.toFixed(0)}%</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2">
                      <div className="bg-primary rounded-full h-2 transition-all" style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border bg-background/60 p-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase">Details</p>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    {detailNote.contribution_type && (
                      <div>
                        <p className="text-xs text-muted-foreground">Type</p>
                        <p className="font-medium capitalize">{detailNote.contribution_type}</p>
                      </div>
                    )}
                    {detailNote.deduction_day && (
                      <div>
                        <p className="text-xs text-muted-foreground">Deduction day</p>
                        <p className="font-medium">Day {detailNote.deduction_day}</p>
                      </div>
                    )}
                    {detailNote.next_deduction_date && (
                      <div>
                        <p className="text-xs text-muted-foreground">Next deduction</p>
                        <p className="font-medium">{format(new Date(detailNote.next_deduction_date), 'dd MMM yyyy')}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-xs text-muted-foreground">Agent</p>
                      <p className="font-medium">{detailNote.agent_name || 'No agent'}</p>
                      {detailNote.agent_phone && <p className="text-xs text-muted-foreground">{detailNote.agent_phone}</p>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {detailNote.agent_phone && (
                      <Button asChild size="sm" variant="outline" className="h-10 gap-2">
                        <a href={`tel:${detailNote.agent_phone}`}>
                          <Phone className="h-4 w-4" />
                          Call agent
                        </a>
                      </Button>
                    )}
                    {(detailNote.phone_number || detailNote.whatsapp_number) && (
                      <Button asChild size="sm" variant="outline" className="h-10 gap-2">
                        <a href={`tel:${detailNote.phone_number || detailNote.whatsapp_number}`}>
                          <Phone className="h-4 w-4" />
                          Call partner
                        </a>
                      </Button>
                    )}
                  </div>
                  {detailNote.notes && (
                    <div className="pt-2 border-t">
                      <p className="text-xs text-muted-foreground">Notes</p>
                      <p className="text-sm">{detailNote.notes}</p>
                    </div>
                  )}
                </div>

                <div className="flex gap-2">
                  {detailNote.status === 'pending' && (
                    <Button
                      className="flex-1"
                      onClick={() => { setApproveReason(''); setApproveTarget(detailNote); }}
                    >
                      <BadgeCheck className="h-4 w-4 mr-2" />
                      Approve & Pay UGX 1,500
                    </Button>
                  )}
                  {detailNote.status === 'activated' && (
                    <Button
                      variant="outline"
                      className="flex-1 border-destructive/40 text-destructive hover:bg-destructive/10"
                      onClick={() => { setRejectReason(''); setRejectTarget(detailNote); }}
                    >
                      <XCircle className="h-4 w-4 mr-2" />
                      Reject & Reverse Bonus
                    </Button>
                  )}
                </div>
              </div>
            );
          })()}
        </SheetContent>
      </Sheet>

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
