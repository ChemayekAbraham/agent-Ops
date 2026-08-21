import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Search, User, Phone, Calendar, TrendingUp, CheckCircle, Clock, AlertTriangle, XCircle, Mail, MessageCircle, FileText, Trash2, BadgeCheck, MapPin, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect } from 'react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { usePromissoryOpsReport, PROMISSORY_RANGES } from '@/hooks/usePromissoryOpsReport';
import { formatUGX } from '@/lib/rentCalculations';


export function PromissoryNotesQueue() {
  const queryClient = useQueryClient();
  const { roles } = useAuth();
  const canReverseBonus = (roles || []).some((r: string) => ['ceo', 'coo', 'cfo', 'super_admin'].includes(r));
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedNote, setSelectedNote] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [page, setPage] = useState(1);
  const [approveTarget, setApproveTarget] = useState<any>(null);
  const [approveReason, setApproveReason] = useState('');
  const [approving, setApproving] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<any>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [leadSearch, setLeadSearch] = useState('');
  const [selectedLead, setSelectedLead] = useState<any>(null);

  const { data: leadCandidates = [], isFetching: leadLoading } = useQuery({
    queryKey: ['partner-lead-candidates', leadSearch],
    enabled: !!approveTarget && leadSearch.trim().length >= 2,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_lead_candidates' as any, {
        p_search: leadSearch.trim(),
      });
      if (error) throw error;
      return (data as any[]) || [];
    },
  });

  const handleReverseBonus = async () => {
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
      if (res?.status === 'reversed') {
        const legs = Array.isArray(res?.legs) ? res.legs : [];
        const summary = legs.length
          ? legs
              .map((l: any) => `${l.role || l.payee_role || 'payee'}: ${l.recovered ?? l.amount ?? 0}${l.arrears ? ` (arrears ${l.arrears})` : ''}`)
              .join(' · ')
          : 'No wallet legs recovered.';
        toast.success(`Bonus reversed — ${summary}`);
      } else {
        toast.info(res?.message || `Reversal returned status: ${res?.status ?? 'unknown'}`);
      }
      setRejectTarget(null);
      setRejectReason('');
      setSelectedNote(null);
      queryClient.invalidateQueries({ queryKey: ['promissory-ops-report'] });
    } catch (err: any) {
      toast.error(err?.message || 'Failed to reverse promissory note bonus.');
    } finally {
      setRejecting(false);
    }
  };

  const handleApprove = async () => {
    if (!approveTarget) return;
    const reason = approveReason.trim();
    if (reason.length < 20) {
      toast.error('Please provide a reason of at least 20 characters.');
      return;
    }
    setApproving(true);
    try {
      if (selectedLead?.user_id && approveTarget.agent_id) {
        const { error: assignError } = await supabase
          .from('partner_lead_assignments' as any)
          .insert({
            lead_user_id: selectedLead.user_id,
            agent_id: approveTarget.agent_id,
            reason,
          } as any);
        // 23505 = unique violation: an active assignment already exists. Continue.
        if (assignError && (assignError as any).code !== '23505') {
          throw assignError;
        }
      }
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
      setSelectedLead(null);
      setLeadSearch('');
      setSelectedNote(null);
      queryClient.invalidateQueries({ queryKey: ['promissory-ops-report'] });
    } catch (err: any) {
      toast.error(err?.message || 'Failed to approve promissory note.');
    } finally {
      setApproving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const reason = deleteReason.trim();
    if (reason.length < 10) {
      toast.error('Please provide a reason of at least 10 characters.');
      return;
    }
    setDeleting(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const actorId = userData?.user?.id;

      // Record the deletion in the audit trail BEFORE removing the record
      const { error: auditError } = await supabase.from('audit_logs').insert({
        user_id: actorId,
        action_type: 'delete',
        action: 'delete_promissory_note',
        table_name: 'promissory_notes',
        record_id: String(deleteTarget.id),
        metadata: {
          reason,
          partner_name: deleteTarget.partner_name,
          whatsapp_number: deleteTarget.whatsapp_number,
          amount: deleteTarget.amount,
          total_collected: deleteTarget.total_collected,
          status: deleteTarget.status,
          agent_id: deleteTarget.agent_id,
          agent_name: deleteTarget.agent_name,
          deleted_at: new Date().toISOString(),
        },
      });
      if (auditError) throw auditError;

      const { error: delError } = await supabase
        .from('promissory_notes')
        .delete()
        .eq('id', deleteTarget.id);
      if (delError) throw delError;

      toast.success('Promissory note deleted and logged.');
      setDeleteTarget(null);
      setDeleteReason('');
      setSelectedNote(null);
      queryClient.invalidateQueries({ queryKey: ['promissory-ops-report'] });
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete promissory note.');
    } finally {
      setDeleting(false);
    }
  };

  const { range, setRange, report, isLoading, refetch, error: reportError } = usePromissoryOpsReport();
  const notes = report.notes;
  const kpis = report.kpis;

  const filtered = notes.filter(n => {
    const haystack = [
      n.partner_name, n.whatsapp_number, n.phone_number, n.email,
      n.agent_name, n.came_in_name, n.lead_partner_name,
      n.came_in ? 'came in registered' : 'not registered',
    ].filter(Boolean).join(' ').toLowerCase();
    const matchesSearch = !search || haystack.includes(search.toLowerCase());
    const matchesStatus =
      statusFilter === 'all'
        ? true
        : statusFilter === 'came_in'
        ? !!n.came_in
        : statusFilter === 'not_registered'
        ? !n.came_in
        : n.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const statusCounts = notes.reduce((acc, n) => {
    acc[n.status] = (acc[n.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const NOTES_PER_PAGE = 10;
  const totalPages = Math.max(1, Math.ceil(filtered.length / NOTES_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pagedNotes = filtered.slice((safePage - 1) * NOTES_PER_PAGE, safePage * NOTES_PER_PAGE);
  useEffect(() => { setPage(1); }, [search, statusFilter, range]);

  const statusConfig: Record<string, { icon: any; color: string; label: string }> = {
    pending: { icon: Clock, color: 'bg-amber-100 text-amber-700 border-amber-200', label: 'Pending' },
    activated: { icon: CheckCircle, color: 'bg-emerald-100 text-emerald-700 border-emerald-200', label: 'Activated' },
    fulfilled: { icon: TrendingUp, color: 'bg-primary/10 text-primary border-primary/20', label: 'Fulfilled' },
    defaulted: { icon: AlertTriangle, color: 'bg-destructive/10 text-destructive border-destructive/20', label: 'Defaulted' },
    cancelled: { icon: XCircle, color: 'bg-muted text-muted-foreground border-border', label: 'Cancelled' },
  };

  const getNoteStatusConfig = (note: any) => {
    const base = statusConfig[note.status] || statusConfig.pending;
    if (note.status === 'activated' && note.came_in) {
      return { ...base, label: 'Joined' };
    }
    return base;
  };

  const statuses = ['all', 'pending', 'activated', 'fulfilled', 'defaulted', 'cancelled'];

  const kpiCards: { label: string; value: React.ReactNode; hint?: string; tone: string }[] = [
    { label: 'Promissory notes', value: kpis.notes_count, hint: `${kpis.approved_notes} approved`, tone: 'bg-primary/5 border-primary/20' },
    { label: 'Partners came in', value: kpis.partners_came_in, hint: `of ${kpis.notes_count} notes`, tone: 'bg-emerald-50 border-emerald-200' },
    { label: 'Receivable', value: <CompactAmount value={Number(kpis.receivable)} />, hint: 'outstanding on live notes', tone: 'bg-amber-50 border-amber-200' },
    { label: 'Promised vs fulfilled', value: <CompactAmount value={Number(kpis.promised_total)} />, hint: `fulfilled ${Math.round(Number(kpis.promised_total) > 0 ? (Number(kpis.fulfilled_total) / Number(kpis.promised_total)) * 100 : 0)}%`, tone: 'bg-sky-50 border-sky-200' },
    { label: 'Proxy agents', value: kpis.proxy_agents, hint: `${kpis.proxies_approved} approved`, tone: 'bg-violet-50 border-violet-200' },
    { label: 'Lead attachments', value: kpis.lead_attachments, hint: 'active proxy attachments', tone: 'bg-muted/40 border-border' },
    { label: 'Pending commission', value: <CompactAmount value={Number(kpis.pending_commission)} />, hint: `${kpis.pending_commission_count} requests`, tone: 'bg-amber-50 border-amber-200' },
    { label: 'Approved commission', value: <CompactAmount value={Number(kpis.approved_commission)} />, hint: `${kpis.approved_commission_count} paid`, tone: 'bg-emerald-50 border-emerald-200' },
    { label: 'Proxies pending review', value: kpis.proxies_pending, hint: 'awaiting approval', tone: 'bg-rose-50 border-rose-200' },
    { label: 'Self supporting tenants', value: kpis.self_supporting_tenants, hint: `${kpis.self_supporting_partners} partner${kpis.self_supporting_partners === 1 ? '' : 's'} · ${formatUGX(Number(kpis.self_support_committed))}`, tone: 'bg-teal-50 border-teal-200' },
  ];

  return (
    <div className="space-y-4">
      {/* Range selector */}
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
        {PROMISSORY_RANGES.map(r => (
          <button
            key={r.key}
            onClick={() => setRange(r.key)}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all',
              range === r.key ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            )}
          >
            {r.label}
          </button>
        ))}
        <Button variant="ghost" size="sm" className="ml-auto shrink-0" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
        </Button>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2">
        {kpiCards.map(k => (
          <Card key={k.label} className={k.tone}>
            <CardContent className="p-3">
              <p className="text-[11px] text-muted-foreground leading-tight">{k.label}</p>
              <p className="text-base font-bold mt-0.5">{k.value}</p>
              {k.hint && <p className="text-[10px] text-muted-foreground truncate">{k.hint}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Search & Filter */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by partner, agent, phone or email..." className="pl-9" />
      </div>

      <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
        {statuses.map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all',
              statusFilter === s ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            )}
          >
            {s === 'all' ? `All (${notes.length})` : `${s.charAt(0).toUpperCase() + s.slice(1)} (${statusCounts[s] || 0})`}
          </button>
        ))}
        <button
          onClick={() => setStatusFilter('came_in')}
          className={cn(
            'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all',
            statusFilter === 'came_in' ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
          )}
        >
          Came in ({kpis.partners_came_in})
        </button>
        <button
          onClick={() => setStatusFilter('not_registered')}
          className={cn(
            'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all',
            statusFilter === 'not_registered' ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
          )}
        >
          Not registered ({kpis.notes_count - kpis.partners_came_in})
        </button>
      </div>

      {/* Notes list */}
      <Card>
        <CardContent className="p-3">
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground text-sm">Loading promissory notes...</div>
          ) : reportError ? (
            <div className="text-center py-8 text-sm space-y-2">
              <p className="text-destructive">Could not load promissory notes: {reportError.message}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">No promissory notes found</div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-2 pr-3 font-medium">Agent</th>
                      <th className="py-2 pr-3 font-medium">Partner</th>
                      <th className="py-2 pr-3 font-medium text-right">Promised</th>
                      <th className="py-2 pr-3 font-medium text-right">Fulfilled</th>
                      <th className="py-2 pr-3 font-medium">Registered</th>
                      <th className="py-2 pr-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedNotes.map(note => {
                      const config = getNoteStatusConfig(note);
                      const StatusIcon = config.icon;
                      return (
                        <tr key={note.id} className="border-b last:border-0 cursor-pointer hover:bg-muted/40" onClick={() => setSelectedNote(note)}>
                          <td className="py-2 pr-3 truncate max-w-[160px]">{note.agent_name}</td>
                          <td className="py-2 pr-3">
                            <span className="font-medium block truncate max-w-[160px]">{note.partner_name}</span>
                            <span className="text-[10px] text-muted-foreground">{note.whatsapp_number}</span>
                          </td>
                          <td className="py-2 pr-3 text-right font-medium"><CompactAmount value={Number(note.amount)} /></td>
                          <td className="py-2 pr-3 text-right font-medium text-emerald-600"><CompactAmount value={Number(note.total_collected)} /></td>
                          <td className="py-2 pr-3">{format(new Date(note.created_at), 'dd MMM yyyy')}</td>
                          <td className="py-2 pr-3">
                            <div className="flex items-center gap-1">
                              <Badge variant="outline" className={cn('text-[10px]', config.color)}>
                                <StatusIcon className="h-3 w-3 mr-1" />
                                {config.label}
                              </Badge>
                              {note.came_in && (
                                <span title="Partner came in" className="inline-flex">
                                  <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" />
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden space-y-2">
                {pagedNotes.map(note => {
                  const config = getNoteStatusConfig(note);
                  const StatusIcon = config.icon;
                  return (
                    <button
                      key={note.id}
                      type="button"
                      onClick={() => setSelectedNote(note)}
                      className="w-full text-left rounded-lg border p-3 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{note.partner_name}</p>
                          <p className="text-[11px] text-muted-foreground truncate">Agent: {note.agent_name}</p>
                        </div>
                        <Badge variant="outline" className={cn('text-[10px] shrink-0', config.color)}>
                          <StatusIcon className="h-3 w-3 mr-1" />
                          {config.label}
                        </Badge>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                        <div>
                          <span className="text-muted-foreground">Promised: </span>
                          <span className="font-medium"><CompactAmount value={Number(note.amount)} /></span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Fulfilled: </span>
                          <span className="font-medium text-emerald-600"><CompactAmount value={Number(note.total_collected)} /></span>
                        </div>
                        <div className="col-span-2 text-muted-foreground flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {format(new Date(note.created_at), 'dd MMM yyyy')}
                          {note.came_in && <span className="ml-auto text-emerald-700 font-medium">Came in</span>}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between gap-2 pt-3 mt-1 border-t">
                <span className="text-[11px] text-muted-foreground">
                  {(safePage - 1) * NOTES_PER_PAGE + 1}–{Math.min(safePage * NOTES_PER_PAGE, filtered.length)} of {filtered.length}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="h-7 px-2" disabled={safePage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-[11px] text-muted-foreground">Page {safePage} of {totalPages}</span>
                  <Button variant="outline" size="sm" className="h-7 px-2" disabled={safePage >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Detail Sheet */}
      <Sheet open={!!selectedNote} onOpenChange={(open) => { if (!open) setSelectedNote(null); }}>
        <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              Promissory Note Details
            </SheetTitle>
          </SheetHeader>
          {selectedNote && (() => {
            const config = statusConfig[selectedNote.status] || statusConfig.pending;
            const StatusIcon = config.icon;
            const outstanding = Number(selectedNote.amount) - Number(selectedNote.total_collected);
            const progress = Number(selectedNote.amount) > 0 ? Math.min(100, (Number(selectedNote.total_collected) / Number(selectedNote.amount)) * 100) : 0;

            return (
              <div className="space-y-4 mt-4 overflow-y-auto max-h-[calc(85vh-80px)] pb-6">
                {/* Status */}
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className={cn('text-xs', config.color)}>
                    <StatusIcon className="h-3 w-3 mr-1" />
                    {config.label}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(selectedNote.created_at), 'dd MMM yyyy HH:mm')}
                  </span>
                </div>

                {/* Partner Info */}
                <Card>
                  <CardContent className="p-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase">Partner</p>
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-muted-foreground" />
                      <span className="font-semibold">{selectedNote.partner_name}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MessageCircle className="h-3.5 w-3.5" />
                      <span>{selectedNote.whatsapp_number}</span>
                    </div>
                    {selectedNote.phone_number && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Phone className="h-3.5 w-3.5" />
                        <span>{selectedNote.phone_number}</span>
                      </div>
                    )}
                    {(selectedNote.partner_address || selectedNote.agent_address) && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <MapPin className="h-3.5 w-3.5 shrink-0" />
                        <span>{selectedNote.partner_address || selectedNote.agent_address}</span>
                      </div>
                    )}
                    {selectedNote.email && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Mail className="h-3.5 w-3.5" />
                        <span>{selectedNote.email}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Financial Summary */}
                <Card>
                  <CardContent className="p-3 space-y-3">
                    <p className="text-xs font-medium text-muted-foreground uppercase">Financial</p>
                    <div className="grid grid-cols-3 gap-3 text-center">
                      <div>
                        <p className="text-xs text-muted-foreground">Promised</p>
                        <p className="font-bold text-sm"><CompactAmount value={Number(selectedNote.amount)} /></p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Collected</p>
                        <p className="font-bold text-sm text-emerald-600"><CompactAmount value={Number(selectedNote.total_collected)} /></p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Outstanding</p>
                        <p className="font-bold text-sm text-primary"><CompactAmount value={outstanding} /></p>
                      </div>
                    </div>
                    {/* Progress bar */}
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px] text-muted-foreground">
                        <span>Progress</span>
                        <span>{progress.toFixed(0)}%</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2">
                        <div className="bg-primary rounded-full h-2 transition-all" style={{ width: `${progress}%` }} />
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Schedule & Agent */}
                <Card>
                  <CardContent className="p-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase">Details</p>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Type</p>
                        <p className="font-medium capitalize">{selectedNote.contribution_type}</p>
                      </div>
                      {selectedNote.deduction_day && (
                        <div>
                          <p className="text-xs text-muted-foreground">Deduction Day</p>
                          <p className="font-medium">Day {selectedNote.deduction_day}</p>
                        </div>
                      )}
                      {selectedNote.next_deduction_date && (
                        <div>
                          <p className="text-xs text-muted-foreground">Next Deduction</p>
                          <p className="font-medium">{format(new Date(selectedNote.next_deduction_date), 'dd MMM yyyy')}</p>
                        </div>
                      )}
                      <div>
                        <p className="text-xs text-muted-foreground">Agent</p>
                        <p className="font-medium">{selectedNote.agent_name}</p>
                        {selectedNote.agent_phone && <p className="text-xs text-muted-foreground">{selectedNote.agent_phone}</p>}
                      </div>
                    </div>
                    {selectedNote.notes && (
                      <div className="pt-2 border-t">
                        <p className="text-xs text-muted-foreground">Notes</p>
                        <p className="text-sm">{selectedNote.notes}</p>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Danger zone: delete with audit trail */}
                <div className="flex gap-2">
                  {!selectedNote.approval_bonus_paid ? (
                    <Button
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                      onClick={() => { setApproveReason(''); setApproveTarget(selectedNote); }}
                    >
                      <BadgeCheck className="h-4 w-4 mr-2" />
                      Approve & Pay UGX 1,500
                    </Button>
                  ) : (
                    <Button className="flex-1" variant="outline" disabled>
                      <CheckCircle className="h-4 w-4 mr-2 text-emerald-600" />
                      Approved
                    </Button>
                  )}
                  {selectedNote.approval_bonus_paid && canReverseBonus && (
                    <Button
                      variant="outline"
                      className="flex-1 border-destructive/40 text-destructive hover:bg-destructive/10"
                      onClick={() => { setRejectReason(''); setRejectTarget(selectedNote); }}
                    >
                      <XCircle className="h-4 w-4 mr-2" />
                      Reject & Reverse Bonus
                    </Button>
                  )}
                  <Button
                    variant="destructive"
                    className="flex-1"
                    onClick={() => { setDeleteReason(''); setDeleteTarget(selectedNote); }}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete Promissory Note
                  </Button>
                </div>
              </div>
            );
          })()}
        </SheetContent>
      </Sheet>

      {/* Delete confirmation with mandatory reason */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open && !deleting) { setDeleteTarget(null); setDeleteReason(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete promissory note?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes {deleteTarget?.partner_name}'s promissory note. A reason is required and this action is recorded in the audit trail against your account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-reason">Reason for deletion (min 10 characters)</Label>
            <Textarea
              id="delete-reason"
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="e.g. Duplicate entry created in error by agent"
              rows={3}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete(); }}
              disabled={deleting || deleteReason.trim().length < 10}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting…' : 'Delete & Log'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Approve confirmation with mandatory reason */}
      <AlertDialog open={!!approveTarget} onOpenChange={(open) => { if (!open && !approving) { setApproveTarget(null); setApproveReason(''); setSelectedLead(null); setLeadSearch(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve promissory note?</AlertDialogTitle>
            <AlertDialogDescription>
              This marks {approveTarget?.partner_name}'s promissory note as verified and credits UGX 1,500 to {approveTarget?.agent_name}'s wallet. A reason is required and this action is recorded in the audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="approve-lead">Lead partner growth (optional)</Label>
            {selectedLead ? (
              <div className="flex items-center justify-between gap-2 rounded-md border p-2">
                <div>
                  <p className="text-sm font-medium">{selectedLead.display_name}</p>
                  {selectedLead.position_title && (
                    <p className="text-xs text-muted-foreground">{selectedLead.position_title}</p>
                  )}
                </div>
                <Button variant="ghost" size="sm" onClick={() => { setSelectedLead(null); setLeadSearch(''); }}>Clear</Button>
              </div>
            ) : (
              <div className="space-y-2">
                <Input
                  id="approve-lead"
                  value={leadSearch}
                  onChange={(e) => setLeadSearch(e.target.value)}
                  placeholder="Search enrolled employees by name"
                />
                {leadSearch.trim().length >= 2 && (
                  <div className="max-h-40 overflow-y-auto rounded-md border divide-y">
                    {leadLoading && <p className="p-2 text-xs text-muted-foreground">Searching…</p>}
                    {!leadLoading && leadCandidates.length === 0 && (
                      <p className="p-2 text-xs text-muted-foreground">No enrolled employees match that search.</p>
                    )}
                    {leadCandidates.map((c: any) => (
                      <button
                        key={c.user_id}
                        type="button"
                        className="w-full px-2 py-1.5 text-left hover:bg-muted"
                        onClick={() => setSelectedLead(c)}
                      >
                        <span className="block text-sm font-medium">{c.display_name}</span>
                        {c.position_title && (
                          <span className="block text-xs text-muted-foreground">{c.position_title}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Leave empty to approve without a lead. The agent is still paid; no override is paid to anyone.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="approve-reason">Reason for approval (min 20 characters)</Label>
            <Textarea
              id="approve-reason"
              value={approveReason}
              onChange={(e) => setApproveReason(e.target.value)}
              placeholder="e.g. Verified partner details and confirmed the signed promissory note document"
              rows={3}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleApprove(); }}
              disabled={approving || approveReason.trim().length < 20}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {approving ? 'Approving…' : 'Approve & Pay'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject an already-approved note and reverse the paid bonus */}
      <AlertDialog open={!!rejectTarget} onOpenChange={(open) => { if (!open && !rejecting) { setRejectTarget(null); setRejectReason(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject approved promissory note?</AlertDialogTitle>
            <AlertDialogDescription>
              This reverses the approval of {rejectTarget?.partner_name}'s promissory note. A reason of at least 20 characters is required and this action is recorded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-destructive">
              This reverses the bonus already paid. Money will be debited from the agent's wallet, and from the lead's wallet where an override was paid. If a wallet is short, the balance becomes recoverable arrears.
            </p>
            <Label htmlFor="reject-reason">Reason for rejection (min 20 characters)</Label>
            <Textarea
              id="reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. Promissory note document could not be verified with the partner on follow-up"
              rows={3}
            />
            <p className="text-[11px] text-muted-foreground text-right">{rejectReason.trim().length}/20 characters</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rejecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleReverseBonus(); }}
              disabled={rejecting || rejectReason.trim().length < 20}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {rejecting ? 'Reversing…' : 'Reject & Reverse'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
