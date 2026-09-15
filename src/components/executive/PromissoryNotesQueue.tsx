import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';

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
import { Search, User, Phone, Calendar, TrendingUp, CheckCircle, Clock, AlertTriangle, XCircle, Mail, MessageCircle, FileText, Trash2, BadgeCheck, MapPin, RefreshCw, ChevronLeft, ChevronRight, Download, FileSpreadsheet, FileDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useEffect } from 'react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { usePromissoryOpsReport, PROMISSORY_RANGES } from '@/hooks/usePromissoryOpsReport';
import { formatUGX } from '@/lib/rentCalculations';


const SWIPE_THRESHOLD = 90;

/**
 * Swipeable wrapper for mobile promissory note cards.
 * Swipe right on a pending note to approve, swipe left on an approved note to reject.
 * Vertical scrolling is untouched — only clear horizontal swipes engage.
 */
function SwipeableNoteCard({
  note,
  onOpen,
  onApprove,
  onReject,
  children,
}: {
  note: { id: string; status: string };
  onOpen: () => void;
  onApprove: () => void;
  onReject: () => void;
  children: React.ReactNode;
}) {
  const [dx, setDx] = useState(0);
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const swiping = useRef(false);
  const moved = useRef(false);

  const canApprove = note.status === 'pending';
  const canReject = note.status === 'activated';
  const enabled = canApprove || canReject;

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!enabled) return;
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    swiping.current = false;
    moved.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (startX.current === null || startY.current === null) return;
    const deltaX = e.touches[0].clientX - startX.current;
    const deltaY = e.touches[0].clientY - startY.current;
    if (!swiping.current) {
      if (Math.abs(deltaX) > 12 && Math.abs(deltaX) > Math.abs(deltaY)) {
        swiping.current = true;
        moved.current = true;
      } else if (Math.abs(deltaY) > 12) {
        startX.current = null;
        return;
      } else {
        return;
      }
    }
    // Resist directions that have no action
    let d = deltaX;
    if (d > 0 && !canApprove) d = d * 0.2;
    if (d < 0 && !canReject) d = d * 0.2;
    setDx(Math.max(-140, Math.min(140, d)));
  };

  const handleTouchEnd = () => {
    if (swiping.current) {
      if (dx >= SWIPE_THRESHOLD && canApprove) onApprove();
      else if (dx <= -SWIPE_THRESHOLD && canReject) onReject();
    }
    startX.current = null;
    startY.current = null;
    swiping.current = false;
    setDx(0);
  };

  const handleClick = () => {
    if (moved.current) {
      moved.current = false;
      return;
    }
    onOpen();
  };

  return (
    <div className="relative overflow-hidden rounded-lg">
      {/* Reveal layers behind the card */}
      {dx > 8 && canApprove && (
        <div className="absolute inset-0 flex items-center bg-emerald-600 pl-4 text-white text-xs font-semibold rounded-lg">
          <CheckCircle className="h-4 w-4 mr-1.5" /> Approve
        </div>
      )}
      {dx < -8 && canReject && (
        <div className="absolute inset-0 flex items-center justify-end bg-destructive pr-4 text-white text-xs font-semibold rounded-lg">
          Reject <XCircle className="h-4 w-4 ml-1.5" />
        </div>
      )}
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={dx !== 0 ? { transform: `translateX(${dx}px)` } : undefined}
        className={cn(
          'relative w-full text-left rounded-lg border bg-card p-3.5 hover:bg-muted/40 active:bg-muted/60',
          dx === 0 && 'transition-transform',
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function PromissoryNotesQueue({
  initialStatusFilter,
  initialSearch,
  initialRange,
}: {
  initialStatusFilter?: string;
  initialSearch?: string;
  initialRange?: string;
}) {
  const queryClient = useQueryClient();
  const { roles } = useAuth();
  const canReverseBonus = (roles || []).some((r: string) => ['ceo', 'coo', 'cfo', 'super_admin'].includes(r));
  const [search, setSearch] = useState(initialSearch ?? '');
  const [statusFilter, setStatusFilter] = useState<string>(() =>
    initialStatusFilter ?? localStorage.getItem('promissory-queue-status-filter') ?? 'all'
  );
  const { range, setRange, report, isLoading, refetch, error: reportError } = usePromissoryOpsReport();
  useEffect(() => {
    if (initialRange && initialRange !== range) {
      setRange(initialRange as any);
    }
  }, []);
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
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkReason, setBulkReason] = useState('');
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [sortBy, setSortBy] = useState<'default' | 'fulfilment_asc' | 'fulfilment_desc'>(() =>
    (localStorage.getItem('promissory-queue-sort') as any) || 'default'
  );


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

  const notes = report.notes;
  const kpis = report.kpis;

  const filtered = notes.filter(n => {
    const haystack = [
      n.partner_name, n.whatsapp_number, n.phone_number, n.email,
      n.agent_name, n.came_in_name, n.lead_partner_name,
      n.came_in ? 'came in registered' : 'not registered',
      n.journey_stage,
      (n.portfolio_count ?? 0) > 0 ? 'portfolio' : '',
    ].filter(Boolean).join(' ').toLowerCase();
    const matchesSearch = !search || haystack.includes(search.toLowerCase());
    const matchesStatus =
      statusFilter === 'all'
        ? true
        : statusFilter === 'came_in'
        ? !!n.came_in
        : statusFilter === 'not_registered'
        ? !n.came_in
        : statusFilter === 'portfolio_pending' || statusFilter === 'portfolio_active'
        ? n.journey_stage === statusFilter
        : n.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const sortedFiltered = [...filtered].sort((a, b) => {
    if (sortBy === 'default') return 0;
    const aDate = a.fulfilment_due_on ? new Date(a.fulfilment_due_on).getTime() : Infinity;
    const bDate = b.fulfilment_due_on ? new Date(b.fulfilment_due_on).getTime() : Infinity;
    if (aDate === bDate) return 0;
    return sortBy === 'fulfilment_asc' ? aDate - bDate : bDate - aDate;
  });

  const statusCounts = notes.reduce((acc, n) => {
    acc[n.status] = (acc[n.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const exportRows = sortedFiltered.map(n => ({
    Partner: n.partner_name || '',
    Agent: n.agent_name || '',
    Phone: n.phone_number || '',
    WhatsApp: n.whatsapp_number || '',
    Email: n.email || '',
    'Amount (UGX)': Number(n.amount || 0),
    'Collected (UGX)': Number(n.total_collected || 0),
    'Outstanding (UGX)': Number(n.outstanding || 0),
    Status: n.status || '',
    Registered: n.came_in ? 'Yes' : 'No',
    'Created at': n.created_at ? format(new Date(n.created_at), 'yyyy-MM-dd HH:mm') : '',
    'Fulfils by': n.fulfilment_due_on ? format(new Date(n.fulfilment_due_on), 'yyyy-MM-dd') : '',
  }));

  const downloadFile = (content: Blob, filename: string) => {
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportStamp = format(new Date(), 'yyyy-MM-dd-HHmm');
  const exportBase = `promissory-notes-${statusFilter}-${exportStamp}`;

  const handleExportCsv = () => {
    if (exportRows.length === 0) {
      toast.error('Nothing to export with the current filters.');
      return;
    }
    const headers = Object.keys(exportRows[0]);
    const escape = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      headers.join(','),
      ...exportRows.map(row => headers.map(h => escape((row as any)[h])).join(',')),
    ].join('\n');
    downloadFile(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `${exportBase}.csv`);
    toast.success(`Exported ${exportRows.length.toLocaleString()} promissory notes as CSV.`);
  };

  const handleExportPdf = async () => {
    if (exportRows.length === 0) {
      toast.error('Nothing to export with the current filters.');
      return;
    }
    try {
      const [{ default: JsPDF }, autoTableMod] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ]);
      const autoTable = (autoTableMod as any).default ?? autoTableMod;
      const doc = new JsPDF({ orientation: 'landscape' });
      doc.setFontSize(14);
      doc.text('Promissory Notes', 14, 14);
      doc.setFontSize(9);
      doc.setTextColor(100);
      doc.text(
        `Exported ${format(new Date(), 'yyyy-MM-dd HH:mm')} · Filter: ${statusFilter} · ${exportRows.length.toLocaleString()} notes`,
        14,
        20,
      );
      const headers = Object.keys(exportRows[0]);
      autoTable(doc, {
        startY: 24,
        head: [headers],
        body: exportRows.map(row => headers.map(h => String((row as any)[h] ?? ''))),
        styles: { fontSize: 7, cellPadding: 1.5 },
        headStyles: { fillColor: [30, 64, 175] },
      });
      doc.save(`${exportBase}.pdf`);
      toast.success(`Exported ${exportRows.length.toLocaleString()} promissory notes as PDF.`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to export PDF.');
    }
  };

  const NOTES_PER_PAGE = 10;
  const totalPages = Math.max(1, Math.ceil(sortedFiltered.length / NOTES_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pagedNotes = sortedFiltered.slice((safePage - 1) * NOTES_PER_PAGE, safePage * NOTES_PER_PAGE);
  useEffect(() => { setPage(1); }, [search, statusFilter, range, sortBy]);
  useEffect(() => { localStorage.setItem('promissory-queue-status-filter', statusFilter); }, [statusFilter]);
  useEffect(() => { localStorage.setItem('promissory-queue-sort', sortBy); }, [sortBy]);

  const allPageSelected = pagedNotes.length > 0 && pagedNotes.every(n => selectedIds.includes(n.id));
  const toggleSelect = (id: string) =>
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const toggleSelectPage = () =>
    setSelectedIds(prev => {
      const pageIds = pagedNotes.map(n => n.id);
      return allPageSelected ? prev.filter(id => !pageIds.includes(id)) : Array.from(new Set([...prev, ...pageIds]));
    });

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0 || bulkReason.trim().length < 10) return;
    setBulkDeleting(true);
    try {
      const { data, error } = await supabase.rpc('bulk_delete_promissory_notes' as any, {
        p_note_ids: selectedIds,
        p_reason: bulkReason.trim(),
      });
      if (error) throw error;
      const res = (data as any) || {};
      if (res.status === 'error') throw new Error(res.message || 'Bulk delete failed');
      const blocked = (res.blocked as any[]) || [];
      toast.success(`${res.deleted || 0} promissory note(s) deleted`);
      if (blocked.length > 0) {
        toast.warning(`${blocked.length} note(s) skipped — ${blocked[0]?.reason || 'linked to partner money'}`);
      }
      setSelectedIds([]);
      setBulkOpen(false);
      setBulkReason('');
      queryClient.invalidateQueries({ queryKey: ['promissory-ops-report'] });
      refetch();
    } catch (e: any) {
      toast.error(e.message || 'Could not delete the selected notes');
    } finally {
      setBulkDeleting(false);
    }
  };


  const statusConfig: Record<string, { icon: any; color: string; label: string }> = {
    pending: { icon: Clock, color: 'bg-amber-100 text-amber-700 border-amber-200', label: 'Pending' },
    activated: { icon: CheckCircle, color: 'bg-emerald-100 text-emerald-700 border-emerald-200', label: 'Activated' },
    fulfilled: { icon: TrendingUp, color: 'bg-primary/10 text-primary border-primary/20', label: 'Fulfilled' },
    defaulted: { icon: AlertTriangle, color: 'bg-destructive/10 text-destructive border-destructive/20', label: 'Defaulted' },
    cancelled: { icon: XCircle, color: 'bg-muted text-muted-foreground border-border', label: 'Cancelled' },
  };

  // Partner journey after a promissory note: matched by phone/email on registration,
  // then a portfolio awaiting approval, then a live portfolio.
  const stageConfig: Record<string, { label: string; color: string }> = {
    not_registered: { label: 'Not registered', color: 'bg-muted text-muted-foreground border-border' },
    came_in: { label: 'Came in', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    portfolio_pending: { label: 'Portfolio pending', color: 'bg-amber-100 text-amber-700 border-amber-200' },
    portfolio_active: { label: 'Portfolio active', color: 'bg-primary/10 text-primary border-primary/20' },
  };
  const stageOf = (n: any) => stageConfig[n?.journey_stage as string] || (n?.came_in ? stageConfig.came_in : stageConfig.not_registered);

  // When a partner registers, the backend matches them on phone/WhatsApp or email
  // and returns the name they registered with. Ops must see that name next to the
  // name written on the note so a mismatch is visible, never silently accepted.
  const normName = (v?: string | null) =>
    (v || '').toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean).sort().join(' ');
  const matchBasisLabel: Record<string, string> = {
    linked_account: 'linked account',
    whatsapp_number: 'WhatsApp number',
    phone_number: 'phone number',
    email: 'email',
  };
  const cameInIdentity = (n: any) => {
    if (!n?.came_in || !n?.came_in_name) return null;
    const serverBasis = n.came_in_match_basis ? matchBasisLabel[String(n.came_in_match_basis)] : null;
    return {
      registeredName: String(n.came_in_name),
      matchedOn: serverBasis || (n.partner_user_id && n.came_in_user_id === n.partner_user_id
        ? 'linked account'
        : n.email
        ? 'phone or email'
        : 'phone'),
      matchedValue: n.came_in_matched_value ? String(n.came_in_matched_value) : null,
      matches: normName(n.came_in_name) === normName(n.partner_name),
    };
  };

  // Proxy agent commission on promissory-linked partners: 2% when the partner
  // first creates a portfolio, 1% on every later top-up. Rates come from the
  // server (promissory_commission_rate), never hardcoded in the UI.
  const pct = (rate: number) => `${(Number(rate || 0) * 100).toFixed(Number(rate || 0) * 100 % 1 === 0 ? 0 : 1)}%`;
  const commissionOf = (n: any) => {
    const creationRate = Number(n?.commission_creation_rate ?? report?.rates?.portfolio_creation ?? 0.02);
    const topupRate = Number(n?.commission_topup_rate ?? report?.rates?.portfolio_topup ?? 0.01);
    const creationPaid = Number(n?.creation_commission_paid || 0);
    const topupPaid = Number(n?.topup_commission_paid || 0);
    const expected = Number(n?.creation_commission_expected || 0);
    return {
      creationRate, topupRate, creationPaid, topupPaid,
      total: creationPaid + topupPaid,
      topupCount: Number(n?.topup_commission_count || 0),
      expected,
      pendingCreation: creationPaid <= 0 && expected > 0,
    };
  };

  const statuses = ['all', 'pending', 'activated', 'fulfilled', 'defaulted', 'cancelled'];

  const kpiCards: { label: string; value: React.ReactNode; hint?: string; tone: string }[] = [
    { label: 'Promissory notes', value: kpis.notes_count, hint: `${kpis.approved_notes} approved`, tone: 'bg-primary/5 border-primary/20' },
    { label: 'Partners came in', value: kpis.partners_came_in, hint: `of ${kpis.notes_count} notes`, tone: 'bg-emerald-50 border-emerald-200' },
    { label: 'Created a portfolio', value: kpis.partners_with_portfolio, hint: `${kpis.partners_portfolio_active} active · ${kpis.partners_portfolio_pending} pending`, tone: 'bg-sky-50 border-sky-200' },
    { label: 'Receivable', value: <CompactAmount value={Number(kpis.receivable)} />, hint: 'outstanding on live notes', tone: 'bg-amber-50 border-amber-200' },
    { label: 'Promised vs fulfilled', value: <CompactAmount value={Number(kpis.promised_total)} />, hint: `fulfilled ${Math.round(Number(kpis.promised_total) > 0 ? (Number(kpis.fulfilled_total) / Number(kpis.promised_total)) * 100 : 0)}%`, tone: 'bg-sky-50 border-sky-200' },
    { label: 'Proxy agents', value: kpis.proxy_agents, hint: `${kpis.proxies_approved} approved`, tone: 'bg-violet-50 border-violet-200' },
    { label: 'Lead attachments', value: kpis.lead_attachments, hint: 'active proxy attachments', tone: 'bg-muted/40 border-border' },
    { label: 'Pending commission', value: <CompactAmount value={Number(kpis.pending_commission)} />, hint: `${kpis.pending_commission_count} requests`, tone: 'bg-amber-50 border-amber-200' },
    { label: 'Approved commission', value: <CompactAmount value={Number(kpis.approved_commission)} />, hint: `${kpis.approved_commission_count} paid`, tone: 'bg-emerald-50 border-emerald-200' },
    { label: 'Proxies pending review', value: kpis.proxies_pending, hint: 'awaiting approval', tone: 'bg-rose-50 border-rose-200' },
    { label: 'Self supporting tenants', value: kpis.self_supporting_tenants, hint: `${kpis.self_supporting_partners} partner${kpis.self_supporting_partners === 1 ? '' : 's'} · ${formatUGX(Number(kpis.self_support_committed))}`, tone: 'bg-teal-50 border-teal-200' },
    {
      label: 'Proxy agent commission',
      value: <CompactAmount value={Number(kpis.promissory_commission_paid_total || 0)} />,
      hint: `${pct(report?.rates?.portfolio_creation ?? 0.02)} creation ${formatUGX(Number(kpis.promissory_creation_commission_paid || 0))} · ${pct(report?.rates?.portfolio_topup ?? 0.01)} top-up ${formatUGX(Number(kpis.promissory_topup_commission_paid || 0))}`,
      tone: 'bg-violet-50 border-violet-200',
    },
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
              'px-3.5 py-2 sm:py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all',
              range === r.key ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            )}
          >
            {r.label}
          </button>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto shrink-0">
              <Download className="h-3.5 w-3.5 mr-1" /> Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleExportCsv}>
              <FileSpreadsheet className="h-4 w-4 mr-2" /> Download CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { void handleExportPdf(); }}>
              <FileDown className="h-4 w-4 mr-2" /> Download PDF
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="sm" className="shrink-0" onClick={() => refetch()}>
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

      {/* Search & Filter — sticky on phones so it stays reachable while scrolling */}
      <div className="sticky top-0 z-20 -mx-1 px-1 py-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 space-y-2 rounded-b-lg">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by partner, agent, phone or email..." className="pl-9 h-11 sm:h-10" />
      </div>

      <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
        {statuses.map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              'px-3.5 py-2 sm:py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all',
              statusFilter === s ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            )}
          >
            {s === 'all' ? `All (${notes.length})` : `${s.charAt(0).toUpperCase() + s.slice(1)} (${statusCounts[s] || 0})`}
          </button>
        ))}
        <button
          onClick={() => setStatusFilter('came_in')}
          className={cn(
            'px-3.5 py-2 sm:py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all',
            statusFilter === 'came_in' ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
          )}
        >
          Came in ({kpis.partners_came_in})
        </button>
        <button
          onClick={() => setStatusFilter('not_registered')}
          className={cn(
            'px-3.5 py-2 sm:py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all',
            statusFilter === 'not_registered' ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
          )}
        >
          Not registered ({kpis.notes_count - kpis.partners_came_in})
        </button>
        <button
          onClick={() => setStatusFilter('portfolio_pending')}
          className={cn(
            'px-3.5 py-2 sm:py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all',
            statusFilter === 'portfolio_pending' ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
          )}
        >
          Portfolio pending ({kpis.partners_portfolio_pending})
        </button>
        <button
          onClick={() => setStatusFilter('portfolio_active')}
          className={cn(
            'px-3.5 py-2 sm:py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all',
            statusFilter === 'portfolio_active' ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
          )}
        >
          Portfolio active ({kpis.partners_portfolio_active})
        </button>
      </div>
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
              {/* Bulk selection bar */}
              <div className="flex flex-wrap items-center gap-2 pb-2 mb-2 border-b">
                <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer">
                  <Checkbox
                    checked={allPageSelected}
                    onCheckedChange={toggleSelectPage}
                    aria-label="Select all notes on this page"
                  />
                  Select page
                </label>
                <span className="text-[11px] text-muted-foreground">{selectedIds.length} selected</span>
                {selectedIds.length > 0 && (
                  <>
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setSelectedIds([])}>
                      Clear
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-7 px-2 text-[11px] ml-auto"
                      onClick={() => { setBulkReason(''); setBulkOpen(true); }}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      Delete {selectedIds.length}
                    </Button>
                  </>
                )}
              </div>

              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-2 pr-2 w-8"></th>
                      <th className="py-2 pr-3 font-medium">Agent</th>
                          <th className="py-2 pr-3 font-medium">Promissory note</th>
                      <th className="py-2 pr-3 font-medium text-right">Promised</th>
                      <th className="py-2 pr-3 font-medium text-right">Fulfilled</th>
                      <th className="py-2 pr-3 font-medium">Created</th>
                      <th className="py-2 pr-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedNotes.map(note => {
                      const config = statusConfig[note.status] || statusConfig.pending;
                      const StatusIcon = config.icon;
                      return (
                        <tr key={note.id} className="border-b last:border-0 cursor-pointer hover:bg-muted/40" onClick={() => setSelectedNote(note)}>
                          <td className="py-2 pr-2" onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={selectedIds.includes(note.id)}
                              onCheckedChange={() => toggleSelect(note.id)}
                              aria-label={`Select note for ${note.partner_name}`}
                            />
                          </td>
                          <td className="py-2 pr-3 truncate max-w-[160px]">{note.agent_name}</td>
                          <td className="py-2 pr-3">
                            <span className="font-medium block truncate max-w-[160px]">{note.partner_name}</span>
                            <span className="text-[10px] text-muted-foreground">{note.whatsapp_number}</span>
                            {(() => {
                              const ci = cameInIdentity(note);
                              if (!ci) return null;
                              return (
                                <span
                                  className={cn(
                                    'block truncate max-w-[160px] text-[10px]',
                                    ci.matches ? 'text-emerald-700' : 'text-amber-700 font-medium',
                                  )}
                                  title={`Registered as "${ci.registeredName}" · matched on ${ci.matchedOn}${ci.matchedValue ? ` (${ci.matchedValue})` : ''}${ci.matches ? '' : ' · name differs from the note'}`}
                                >
                                  Registered partner: {ci.registeredName}{ci.matches ? '' : ' ⚠'}
                                </span>
                              );
                            })()}
                          </td>

                          <td className="py-2 pr-3 text-right font-medium"><CompactAmount value={Number(note.amount)} /></td>
                          <td className="py-2 pr-3 text-right font-medium text-emerald-600"><CompactAmount value={Number(note.total_collected)} /></td>
                          <td className="py-2 pr-3">
                            {format(new Date(note.created_at), 'dd MMM yyyy')}
                            {note.fulfilment_due_on && Number(note.outstanding ?? (Number(note.amount) - Number(note.total_collected))) > 0 && (
                              <span className={cn(
                                'block text-[10px]',
                                new Date(note.fulfilment_due_on) < new Date() ? 'text-destructive font-medium' : 'text-muted-foreground',
                              )}>
                                Fulfils by {format(new Date(note.fulfilment_due_on), 'dd MMM yyyy')}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3">
                            <div className="flex flex-wrap items-center gap-1">
                              <Badge variant="outline" className={cn('text-[10px]', config.color)}>
                                <StatusIcon className="h-3 w-3 mr-1" />
                                {config.label}
                              </Badge>
                              <Badge variant="outline" className={cn('text-[10px]', stageOf(note).color)}>
                                {stageOf(note).label}
                              </Badge>
                              {note.came_in && (
                                <span title="Partner came in" className="inline-flex">
                                  <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" />
                                </span>
                              )}
                              {(() => {
                                const c = commissionOf(note);
                                if (c.total <= 0 && !c.pendingCreation) return null;
                                return (
                                  <Badge
                                    variant="outline"
                                    className={cn('text-[10px]', c.total > 0
                                      ? 'bg-violet-50 text-violet-700 border-violet-200'
                                      : 'bg-muted/50 text-muted-foreground border-border')}
                                    title={`Proxy agent commission — ${pct(c.creationRate)} on portfolio creation, ${pct(c.topupRate)} on each top-up`}
                                  >
                                    {c.total > 0
                                      ? <>Agent {formatUGX(c.total)}</>
                                      : <>Agent {pct(c.creationRate)} ≈ {formatUGX(c.expected)}</>}
                                  </Badge>
                                );
                              })()}

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
                  const config = statusConfig[note.status] || statusConfig.pending;
                  const StatusIcon = config.icon;
                  return (
                    <SwipeableNoteCard
                      key={note.id}
                      note={note}
                      onOpen={() => setSelectedNote(note)}
                      onApprove={() => { setApproveReason(''); setApproveTarget(note); }}
                      onReject={() => { setRejectReason(''); setRejectTarget(note); }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2 min-w-0">
                          <span onClick={(e) => e.stopPropagation()} className="pt-0.5">
                            <Checkbox
                              checked={selectedIds.includes(note.id)}
                              onCheckedChange={() => toggleSelect(note.id)}
                              aria-label={`Select note for ${note.partner_name}`}
                            />
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">Promissory note: {note.partner_name}</p>
                            <p className="text-[11px] text-muted-foreground truncate">Agent: {note.agent_name}</p>
                            {(() => {
                              const ci = cameInIdentity(note);
                              if (!ci) return null;
                              return (
                                <p className={cn('text-[11px] truncate', ci.matches ? 'text-emerald-700' : 'text-amber-700 font-medium')}>
                                  Registered partner: {ci.registeredName}{ci.matches ? '' : ' ⚠ differs'}
                                </p>
                              );
                            })()}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Badge variant="outline" className={cn('text-[10px]', config.color)}>
                            <StatusIcon className="h-3 w-3 mr-1" />
                            {config.label}
                          </Badge>
                          <Badge variant="outline" className={cn('text-[10px]', stageOf(note).color)}>
                            {stageOf(note).label}
                          </Badge>
                        </div>
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
                        {(note.portfolio_count ?? 0) > 0 && (
                          <div className="col-span-2">
                            <span className="text-muted-foreground">Portfolio: </span>
                            <span className="font-medium">
                              {note.portfolio_count} · {formatUGX(Number(note.portfolio_amount || 0))}
                            </span>
                          </div>
                        )}
                        {(() => {
                          const c = commissionOf(note);
                          if (c.total <= 0 && !c.pendingCreation) return null;
                          return (
                            <div className="col-span-2">
                              <span className="text-muted-foreground">Agent commission: </span>
                              <span className="font-medium text-violet-700">
                                {c.total > 0
                                  ? `${formatUGX(c.total)} (${pct(c.creationRate)} ${formatUGX(c.creationPaid)} + ${pct(c.topupRate)} top-ups ${formatUGX(c.topupPaid)})`
                                  : `${pct(c.creationRate)} due ≈ ${formatUGX(c.expected)}`}
                              </span>
                            </div>
                          );
                        })()}
                        <div className="col-span-2 text-muted-foreground flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {format(new Date(note.created_at), 'dd MMM yyyy')}
                          {note.came_in && <span className="ml-auto text-emerald-700 font-medium">Came in</span>}
                        </div>
                        {note.fulfilment_due_on && Number(note.amount) - Number(note.total_collected) > 0 && (
                          <div className={cn(
                            'col-span-2 flex items-center gap-1 font-medium',
                            new Date(note.fulfilment_due_on) < new Date() ? 'text-destructive' : 'text-primary',
                          )}>
                            <Calendar className="h-3 w-3" />
                            Fulfils by {format(new Date(note.fulfilment_due_on), 'dd MMM yyyy')}
                            {new Date(note.fulfilment_due_on) < new Date() && ' (overdue)'}
                          </div>
                        )}
                      </div>
                    </SwipeableNoteCard>
                  );
                })}

              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between gap-2 pt-3 mt-1 border-t">
                <span className="text-[11px] text-muted-foreground">
                  {(safePage - 1) * NOTES_PER_PAGE + 1}–{Math.min(safePage * NOTES_PER_PAGE, filtered.length)} of {filtered.length}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="h-10 w-10 sm:h-7 sm:w-auto sm:px-2" disabled={safePage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-[11px] text-muted-foreground">Page {safePage} of {totalPages}</span>
                  <Button variant="outline" size="sm" className="h-10 w-10 sm:h-7 sm:w-auto sm:px-2" disabled={safePage >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
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
                {selectedNote.fulfilment_due_on && outstanding > 0 && (
                  <div className={cn(
                    'flex items-center gap-2 rounded-md border p-2.5 text-xs font-medium',
                    new Date(selectedNote.fulfilment_due_on) < new Date()
                      ? 'border-destructive/40 bg-destructive/5 text-destructive'
                      : 'border-primary/30 bg-primary/5 text-primary',
                  )}>
                    <Calendar className="h-3.5 w-3.5" />
                    Expected to be fulfilled by {format(new Date(selectedNote.fulfilment_due_on), 'dd MMM yyyy')}
                    {new Date(selectedNote.fulfilment_due_on) < new Date() && ' — overdue'}
                  </div>
                )}

                {/* Partner Info */}
                <Card>
                  <CardContent className="p-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase">Partner comparison</p>
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <p className="text-[11px] text-muted-foreground">Promissory note name</p>
                        <p className="font-semibold">{selectedNote.partner_name}</p>
                      </div>
                    </div>
                    {(() => {
                      const ci = cameInIdentity(selectedNote);
                      if (!ci) {
                        return (
                          <p className="text-[11px] text-muted-foreground">
                            No registered account matched this note's phone or email yet.
                          </p>
                        );
                      }
                      return (
                        <div className={cn('rounded-md border p-2 text-xs', ci.matches ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50')}>
                          <div className="grid gap-1 sm:grid-cols-2">
                            <div>
                              <p className="text-[11px] text-muted-foreground">Registered partner name</p>
                              <p className="font-medium">{ci.registeredName}</p>
                            </div>
                            <div>
                              <p className="text-[11px] text-muted-foreground">Promissory note name</p>
                              <p className="font-medium">{selectedNote.partner_name}</p>
                            </div>
                          </div>
                          <p className="text-muted-foreground">
                            Matched on {ci.matchedOn}{ci.matchedValue ? ` (${ci.matchedValue})` : ''}
                          </p>
                          {!ci.matches && (
                            <p className="mt-1 font-medium text-amber-700">
                              Registered name differs from the promissory note — verify before approval.
                            </p>
                          )}
                          {selectedNote.came_in_at && (
                            <p className="text-muted-foreground">
                              Registered {format(new Date(selectedNote.came_in_at), 'dd MMM yyyy HH:mm')}
                            </p>
                          )}
                        </div>
                      );
                    })()}
                    {(() => {
                      const c = commissionOf(selectedNote);
                      return (
                        <div className="rounded-md border border-violet-200 bg-violet-50 p-2 text-xs space-y-0.5">
                          <p className="font-medium text-violet-800">Proxy agent commission</p>
                          <p className="text-muted-foreground">
                            {pct(c.creationRate)} on portfolio creation · {pct(c.topupRate)} on every top-up
                          </p>
                          <p>
                            Creation: <span className="font-medium">{c.creationPaid > 0 ? `${formatUGX(c.creationPaid)} paid` : c.expected > 0 ? `${formatUGX(c.expected)} due` : 'not earned yet'}</span>
                          </p>
                          <p>
                            Top-ups: <span className="font-medium">{formatUGX(c.topupPaid)}</span>
                            {c.topupCount > 0 ? ` (${c.topupCount} top-up${c.topupCount === 1 ? '' : 's'})` : ''}
                          </p>
                          <p className="font-medium">Total earned: {formatUGX(c.total)}</p>
                        </div>
                      );
                    })()}
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

      {/* Bulk delete confirmation */}
      <AlertDialog open={bulkOpen} onOpenChange={(open) => { if (!open && !bulkDeleting) { setBulkOpen(false); setBulkReason(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.length} promissory note(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected notes for both Partner Ops and the agents who created them, together with their release, pledge, plan-intent, override and reversal records so no orphan data is left behind.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Notes tied to partner money (self-support commitments or pending portfolios) are skipped automatically.
            </p>
            <Label htmlFor="bulk-delete-reason">Reason (min 10 characters)</Label>
            <Textarea
              id="bulk-delete-reason"
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
              placeholder="e.g. Duplicate test notes captured during agent training"
              rows={3}
            />
            <p className="text-[11px] text-muted-foreground text-right">{bulkReason.trim().length}/10 characters</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleBulkDelete(); }}
              disabled={bulkDeleting || bulkReason.trim().length < 10}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {bulkDeleting ? 'Deleting…' : `Delete ${selectedIds.length}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>

  );
}
