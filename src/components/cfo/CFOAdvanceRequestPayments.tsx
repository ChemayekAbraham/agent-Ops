import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX, calculateAccessFee, calculateRegistrationFee } from '@/lib/agentAdvanceCalculations';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { format, addDays, differenceInCalendarDays, max as dateMax, min as dateMin, isAfter, startOfMonth, endOfMonth } from 'date-fns';
import { CheckCircle2, Loader2, Pencil, User, Banknote, X, FileText, AlertTriangle, ShieldX, Users, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Sparkles } from 'lucide-react';
import { AgentAdvanceEvaluationDialog } from '@/components/agent/AgentAdvanceEvaluationDialog';
import { AgentLocationBadge } from '@/components/ops/AgentLocationBadge';
import { applyAdvanceTopupForRequest } from '@/lib/disburseAgentAdvance';
import { DuplicateAccountAlert, useAgentDuplicateMap } from '@/components/ops/DuplicateAccountAlert';
import { RejectAsDuplicateDialog, useAgentDuplicateFlags } from '@/components/ops/RejectAsDuplicateDialog';

export function CFOAdvanceRequestPayments({ onViewDisbursed }: { onViewDisbursed?: () => void } = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [editingRate, setEditingRate] = useState<string | null>(null);
  const [adjustedRates, setAdjustedRates] = useState<Record<string, number>>({});
  const [adjustedPrincipals, setAdjustedPrincipals] = useState<Record<string, number>>({});
  const [adjustedCycles, setAdjustedCycles] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  // The same advance-eligibility evaluation popup used by Agent Ops. The CFO
  // opens it on any request to see the agent's 360° evaluation AND edit + approve
  // the advance in a single popup — no separate expander.
  const [evalReq, setEvalReq] = useState<any | null>(null);
  // Row-level details sheet (centered) — opens before the evaluation dialog.
  const [detailReq, setDetailReq] = useState<any | null>(null);
  const [stageFilter, setStageFilter] = useState<'all' | 'pending' | 'ready' | 'cfo_approved' | 'cfo_rejected'>('all');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [rejectingReq, setRejectingReq] = useState<any | null>(null);
  const [rejectReason, setRejectReason] = useState<string>('');
  const [dupRejectReq, setDupRejectReq] = useState<any | null>(null);
  // Table filters — pure client-side, applied on top of the existing stage filter.
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'agent_ops_approved' | 'cfo_approved' | 'cfo_rejected'>('all');
  const [departmentFilter, setDepartmentFilter] = useState<string>('all');
  const [requesterFilter, setRequesterFilter] = useState('');
  const [submittedFrom, setSubmittedFrom] = useState('');
  const [submittedTo, setSubmittedTo] = useState('');
  // Post-disbursement success dialog payload — shows the CFO what was sent and
  // a shortcut to the full list of disbursed advances.
  const [disbursed, setDisbursed] = useState<null | {
    agentName: string;
    agentPhone: string;
    principal: number;
    cycleDays: number;
    rate: number;
    accessFee: number;
    registrationFee: number;
    totalPayable: number;
    daily: number;
  }>(null);

  // Income Statement Impact preview — date range
  const today = new Date();
  const [rangeStart, setRangeStart] = useState<string>(format(startOfMonth(today), 'yyyy-MM-dd'));
  const [rangeEnd, setRangeEnd] = useState<string>(format(endOfMonth(today), 'yyyy-MM-dd'));

  // Fetch fee config
  const { data: feeConfig } = useQuery({
    queryKey: ['advance-fee-config'],
    queryFn: async () => {
      const { data } = await supabase.from('advance_fee_config').select('*').limit(1).maybeSingle();
      return data;
    },
  });

  // Fetch ALL agent advance applications so CFO sees every stage. After Agent Ops
  // approves, a request lands at 'agent_ops_approved' and comes straight to the CFO —
  // there are no intermediate ops desks.
  const { data: allRequests = [], isLoading } = useQuery({
    queryKey: ['cfo-advance-requests'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advance_requests')
        .select('*, profiles!agent_advance_requests_agent_id_fkey(full_name, phone, region, district, sub_county, parish, village, city)')
        .in('status', ['pending', 'agent_ops_approved', 'cfo_approved', 'cfo_rejected'])
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  const pendingApplications = (allRequests as any[]).filter(r => r.status === 'pending');
  const readyToPay = (allRequests as any[]).filter(r => r.status === 'agent_ops_approved');
  const cfoApproved = (allRequests as any[]).filter(r => r.status === 'cfo_approved');
  const cfoRejected = (allRequests as any[]).filter(r => r.status === 'cfo_rejected');
  const requests = stageFilter === 'pending'
    ? pendingApplications
    : stageFilter === 'ready'
      ? readyToPay
      : stageFilter === 'cfo_approved'
        ? cfoApproved
        : stageFilter === 'cfo_rejected'
          ? cfoRejected
          : allRequests.filter((r: any) => r.status !== 'cfo_rejected');

  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    (requests as any[]).forEach((req) => {
      const profile = req.profiles;
      set.add(profile?.district || profile?.region || profile?.city || '—');
    });
    return Array.from(set).sort();
  }, [requests]);

  const filteredRequests = useMemo(() => {
    return (requests as any[]).filter((req) => {
      const profile = req.profiles;
      const department = profile?.district || profile?.region || profile?.city || '—';

      if (statusFilter !== 'all' && req.status !== statusFilter) return false;
      if (departmentFilter !== 'all' && department !== departmentFilter) return false;
      if (requesterFilter.trim()) {
        const term = requesterFilter.toLowerCase();
        const name = (profile?.full_name || '').toLowerCase();
        const phone = (profile?.phone || '').toLowerCase();
        if (!name.includes(term) && !phone.includes(term)) return false;
      }

      const created = new Date(req.created_at);
      if (submittedFrom) {
        const from = new Date(submittedFrom);
        from.setHours(0, 0, 0, 0);
        if (created < from) return false;
      }
      if (submittedTo) {
        const to = new Date(submittedTo);
        to.setHours(23, 59, 59, 999);
        if (created > to) return false;
      }

      return true;
    });
  }, [requests, statusFilter, departmentFilter, requesterFilter, submittedFrom, submittedTo]);

  const hasActiveFilters =
    statusFilter !== 'all' ||
    departmentFilter !== 'all' ||
    requesterFilter !== '' ||
    submittedFrom !== '' ||
    submittedTo !== '';

  const clearFilters = () => {
    setStatusFilter('all');
    setDepartmentFilter('all');
    setRequesterFilter('');
    setSubmittedFrom('');
    setSubmittedTo('');
  };

  const advanceAgentIds = (allRequests as any[]).map((r) => r.agent_id).filter(Boolean);
  const { data: cfoDuplicateMap = {} } = useAgentDuplicateMap(advanceAgentIds);
  const { data: cfoDuplicateFlagMap = {} } = useAgentDuplicateFlags(advanceAgentIds);

  // Update global default rate
  const updateConfigMutation = useMutation({
    mutationFn: async (newRate: number) => {
      if (!user?.id) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('advance_fee_config')
        .update({ default_monthly_rate: newRate, updated_by: user.id })
        .not('id', 'is', null); // update the single row
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Default rate updated');
      queryClient.invalidateQueries({ queryKey: ['advance-fee-config'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Pay advance to agent wallet
  const payMutation = useMutation({
    mutationFn: async (req: any) => {
      if (!user?.id) throw new Error('Not authenticated');
      // Approval gate: disbursement is only allowed once the CFO has approved
      // (and edited) the request. Anything not yet at 'cfo_approved' is blocked.
      if (req.status !== 'cfo_approved') {
        throw new Error('Approve the advance before disbursing to the wallet');
      }
      const adjustedRate = adjustedRates[req.id] ?? Number(req.monthly_rate);
      const principal = adjustedPrincipals[req.id] ?? Number(req.principal);
      const cycleDays = adjustedCycles[req.id] ?? Number(req.cycle_days);
      const isTopup = (req.request_kind ?? 'new') === 'topup';
      const registrationFee = isTopup ? 0 : calculateRegistrationFee(principal);
      const newAccessFee = calculateAccessFee(principal, cycleDays, adjustedRate);
      const newTotal = principal + newAccessFee + registrationFee;
      const newDaily = Math.ceil(newTotal / cycleDays);

      // Single atomic transaction: stamp the request paid, create the advance row
      // (linked by request_id) and post both ledger legs. If any part fails the
      // whole payout rolls back, so a request can never be marked paid without
      // the agent actually receiving the money.
      if (isTopup) {
        await applyAdvanceTopupForRequest(req, principal, Number(req.extend_days ?? cycleDays));
      } else {
        const { error: disburseErr } = await supabase.rpc('disburse_agent_advance_request' as any, {
          p_request_id: req.id,
          p_principal: principal,
          p_cycle_days: cycleDays,
          p_monthly_rate: adjustedRate,
          p_repayment_frequency: req.repayment_frequency ?? 'daily',
          p_notes: notes[req.id] || null,
          p_skip_reason: null,
          p_recovery_source: 'wallet_daily',
          p_roi_recovery_percent: 0,
        } as any);
        if (disburseErr) throw disburseErr;
      }

      // Registration fee is already included in `total_payable` and is recovered
      //    through the repayment schedule — it must NOT be debited from the wallet
      //    at disbursement (that double-charged the agent and zeroed small advances).

      // Notify the agent by SMS that the advance was disbursed (fire-and-forget).
      supabase.functions.invoke('notify-agent-advance-disbursed', {
        body: { agent_id: req.agent_id, amount: principal, request_id: req.id },
      }).catch((e) => console.error('advance disbursement SMS failed', e));
    },
    onSuccess: (_data, req: any) => {
      const adjustedRate = adjustedRates[req.id] ?? Number(req.monthly_rate);
      const principal = adjustedPrincipals[req.id] ?? Number(req.principal);
      const cycleDays = adjustedCycles[req.id] ?? Number(req.cycle_days);
      const registrationFee = calculateRegistrationFee(principal);
      const accessFee = calculateAccessFee(principal, cycleDays, adjustedRate);
      const totalPayable = principal + accessFee + registrationFee;
      const daily = Math.ceil(totalPayable / cycleDays);
      toast.success('Advance paid to agent wallet!');
      setDisbursed({
        agentName: req.profiles?.full_name || 'Agent',
        agentPhone: req.profiles?.phone || '',
        principal,
        cycleDays,
        rate: adjustedRate,
        accessFee,
        registrationFee,
        totalPayable,
        daily,
      });
      queryClient.invalidateQueries({ queryKey: ['cfo-advance-requests'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // CFO approval = approval + disbursement. Stamping the approval fields alone
  // left requests parked at 'cfo_approved' with no advance row and no ledger
  // legs, so approval now always completes the existing disbursement path.
  const approveMutation = useMutation({
    mutationFn: async (req: any) => {
      if (!user?.id) throw new Error('Not authenticated');
      const adjustedRate = adjustedRates[req.id] ?? Number(req.monthly_rate);
      const principal = adjustedPrincipals[req.id] ?? Number(req.principal);
      const cycleDays = adjustedCycles[req.id] ?? Number(req.cycle_days);
      if (principal <= 0) throw new Error('Principal must be greater than zero');
      const isTopup = (req.request_kind ?? 'new') === 'topup';
      const registrationFee = isTopup ? 0 : calculateRegistrationFee(principal);
      const newAccessFee = calculateAccessFee(principal, cycleDays, adjustedRate);
      const newTotal = principal + newAccessFee + registrationFee;
      const newDaily = Math.ceil(newTotal / cycleDays);

      const { error } = await supabase.from('agent_advance_requests').update({
        status: 'cfo_approved',
        cfo_approved_by: user.id,
        cfo_approved_at: new Date().toISOString(),
        cfo_adjusted_rate: adjustedRate !== Number(req.monthly_rate) ? adjustedRate : null,
        cfo_notes: notes[req.id] || null,
        principal,
        cycle_days: cycleDays,
        registration_fee: registrationFee,
        access_fee: newAccessFee,
        total_payable: newTotal,
        daily_payment: newDaily,
        monthly_rate: adjustedRate,
      }).eq('id', req.id);
      if (error) throw error;

      // Same disbursement path used by "Approve & Disburse" — one atomic RPC
      // that stamps the request paid, creates the advance row and posts both
      // ledger legs (wallet credit + platform cash out).
      if (isTopup) {
        await applyAdvanceTopupForRequest(req, principal, Number(req.extend_days ?? cycleDays));
      } else {
        const { error: disburseErr } = await supabase.rpc('disburse_agent_advance_request' as any, {
          p_request_id: req.id,
          p_principal: principal,
          p_cycle_days: cycleDays,
          p_monthly_rate: adjustedRate,
          p_repayment_frequency: req.repayment_frequency ?? 'daily',
          p_notes: notes[req.id] || null,
          p_skip_reason: null,
          p_recovery_source: 'wallet_daily',
          p_roi_recovery_percent: 0,
        } as any);
        if (disburseErr) throw disburseErr;
      }

      supabase.functions.invoke('notify-agent-advance-disbursed', {
        body: { agent_id: req.agent_id, amount: principal, request_id: req.id },
      }).catch((e) => console.error('advance disbursement SMS failed', e));
    },
    onSuccess: (_data, req: any) => {
      const adjustedRate = adjustedRates[req.id] ?? Number(req.monthly_rate);
      const principal = adjustedPrincipals[req.id] ?? Number(req.principal);
      const cycleDays = adjustedCycles[req.id] ?? Number(req.cycle_days);
      const registrationFee = calculateRegistrationFee(principal);
      const accessFee = calculateAccessFee(principal, cycleDays, adjustedRate);
      const totalPayable = principal + accessFee + registrationFee;
      toast.success('Advance approved & disbursed to agent wallet!');
      setDisbursed({
        agentName: req.profiles?.full_name || 'Agent',
        agentPhone: req.profiles?.phone || '',
        principal,
        cycleDays,
        rate: adjustedRate,
        accessFee,
        registrationFee,
        totalPayable,
        daily: Math.ceil(totalPayable / cycleDays),
      });
      queryClient.invalidateQueries({ queryKey: ['cfo-advance-requests'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Allow the CFO to re-open an approved request for further editing before payout.
  const revokeApprovalMutation = useMutation({
    mutationFn: async (req: any) => {
      if (!user?.id) throw new Error('Not authenticated');
      const { error } = await supabase.from('agent_advance_requests').update({
        status: 'pending',
        cfo_approved_by: null,
        cfo_approved_at: null,
      }).eq('id', req.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Approval revoked — request re-opened for editing');
      queryClient.invalidateQueries({ queryKey: ['cfo-advance-requests'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // CFO rejects a request outright (no money moves). Records reason for the audit trail.
  const rejectMutation = useMutation({
    mutationFn: async ({ req, reason }: { req: any; reason: string }) => {
      if (!user?.id) throw new Error('Not authenticated');
      const trimmed = reason.trim();
      if (trimmed.length < 5) throw new Error('Rejection reason must be at least 5 characters');
      const { error } = await supabase.from('agent_advance_requests').update({
        status: 'cfo_rejected',
        rejection_reason: trimmed,
        cfo_notes: notes[req.id] || trimmed,
        cfo_approved_by: user.id,
        cfo_approved_at: new Date().toISOString(),
      }).eq('id', req.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Request rejected — agent notified');
      setRejectingReq(null);
      setRejectReason('');
      setEvalReq(null);
      queryClient.invalidateQueries({ queryKey: ['cfo-advance-requests'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // SHORT PATH: approve (locking in any edits) AND disburse in one action.
  // Collapses the old two-step "Approve → then Disburse" into a single confirm.
  // Runs the exact same ledger movement as payMutation but also stamps the
  // approval fields in the same update, so nothing about the money flow changes.
  const approveAndPayMutation = useMutation({
    mutationFn: async (req: any) => {
      if (!user?.id) throw new Error('Not authenticated');
      const adjustedRate = adjustedRates[req.id] ?? Number(req.monthly_rate);
      const principal = adjustedPrincipals[req.id] ?? Number(req.principal);
      const cycleDays = adjustedCycles[req.id] ?? Number(req.cycle_days);
      if (principal <= 0) throw new Error('Principal must be greater than zero');
      const isTopup = (req.request_kind ?? 'new') === 'topup';
      const registrationFee = isTopup ? 0 : calculateRegistrationFee(principal);
      const newAccessFee = calculateAccessFee(principal, cycleDays, adjustedRate);
      const newTotal = principal + newAccessFee + registrationFee;
      const newDaily = Math.ceil(newTotal / cycleDays);
      const nowIso = new Date().toISOString();

      // 1. Stamp the CFO approval FIRST. `disburse_agent_advance_request` enforces a
      // mandatory CFO gate and refuses anything that is not already `cfo_approved`
      // with a recorded approver, so skipping this step made every one-click
      // "Approve & Disburse" fail with "Disbursement blocked — CFO approval is
      // required". Same fields, same values as the two-step approve path.
      const { error: approveErr } = await supabase.from('agent_advance_requests').update({
        status: 'cfo_approved',
        cfo_approved_by: user.id,
        cfo_approved_at: nowIso,
        cfo_adjusted_rate: adjustedRate !== Number(req.monthly_rate) ? adjustedRate : null,
        cfo_notes: notes[req.id] || null,
        principal,
        cycle_days: cycleDays,
        registration_fee: registrationFee,
        access_fee: newAccessFee,
        total_payable: newTotal,
        daily_payment: newDaily,
        monthly_rate: adjustedRate,
      }).eq('id', req.id).select('id').maybeSingle();
      if (approveErr) throw approveErr;

      // 2. Disburse: one atomic transaction that stamps the request paid, creates the
      // advance row and posts both ledger legs. Rolls back entirely on any failure
      // (no "paid but no money" state).
      if (isTopup) {
        await applyAdvanceTopupForRequest(req, principal, Number(req.extend_days ?? cycleDays));
      } else {
        const { error: disburseErr } = await supabase.rpc('disburse_agent_advance_request' as any, {
          p_request_id: req.id,
          p_principal: principal,
          p_cycle_days: cycleDays,
          p_monthly_rate: adjustedRate,
          p_repayment_frequency: req.repayment_frequency ?? 'daily',
          p_notes: notes[req.id] || null,
          p_skip_reason: null,
          p_recovery_source: 'wallet_daily',
          p_roi_recovery_percent: 0,
        } as any);
        if (disburseErr) throw disburseErr;
      }

      // Registration fee stays inside `total_payable` (recovered via repayments).
      //    No upfront wallet debit — see disburseAgentAdvance.ts.

      // Notify the agent by SMS (fire-and-forget).
      supabase.functions.invoke('notify-agent-advance-disbursed', {
        body: { agent_id: req.agent_id, amount: principal, request_id: req.id },
      }).catch((e) => console.error('advance disbursement SMS failed', e));
    },
    onSuccess: (_data, req: any) => {
      const adjustedRate = adjustedRates[req.id] ?? Number(req.monthly_rate);
      const principal = adjustedPrincipals[req.id] ?? Number(req.principal);
      const cycleDays = adjustedCycles[req.id] ?? Number(req.cycle_days);
      const registrationFee = calculateRegistrationFee(principal);
      const accessFee = calculateAccessFee(principal, cycleDays, adjustedRate);
      const totalPayable = principal + accessFee + registrationFee;
      const daily = Math.ceil(totalPayable / cycleDays);
      toast.success('Approved & disbursed to agent wallet!');
      setDisbursed({
        agentName: req.profiles?.full_name || 'Agent',
        agentPhone: req.profiles?.phone || '',
        principal,
        cycleDays,
        rate: adjustedRate,
        accessFee,
        registrationFee,
        totalPayable,
        daily,
      });
      queryClient.invalidateQueries({ queryKey: ['cfo-advance-requests'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Portfolio-level revenue economics across all pending requests
  const revenueTotals = useMemo(() => {
    let principal = 0, accessFee = 0, regFee = 0;
    for (const req of readyToPay) {
      const p = adjustedPrincipals[req.id] ?? Number(req.principal);
      const d = adjustedCycles[req.id] ?? Number(req.cycle_days);
      const r = adjustedRates[req.id] ?? Number(req.monthly_rate);
      principal += p;
      accessFee += calculateAccessFee(p, d, r);
      regFee += calculateRegistrationFee(p);
    }
    return { principal, accessFee, regFee, gross: accessFee + regFee };
  }, [readyToPay, adjustedPrincipals, adjustedCycles, adjustedRates]);

  // Income Statement Impact — recognize Registration Fee at payout date,
  // Access Fee straight-line across cycle days. Only counts revenue whose
  // recognition window overlaps the selected [rangeStart, rangeEnd].
  const incomeImpact = useMemo(() => {
    const startD = new Date(rangeStart + 'T00:00:00');
    const endD = new Date(rangeEnd + 'T23:59:59');
    if (isNaN(startD.getTime()) || isNaN(endD.getTime()) || isAfter(startD, endD)) {
      return { rows: [] as any[], regFee: 0, accessFee: 0, principalDisbursed: 0, total: 0 };
    }
    let regFeeTotal = 0, accessFeeTotal = 0, principalDisbursed = 0;
    const rows: Array<{
      id: string; name: string; principal: number; cycleDays: number;
      regFee: number; accessFeeInRange: number; daysInRange: number; total: number;
    }> = [];

    for (const req of readyToPay) {
      const p = adjustedPrincipals[req.id] ?? Number(req.principal);
      const d = adjustedCycles[req.id] ?? Number(req.cycle_days);
      const r = adjustedRates[req.id] ?? Number(req.monthly_rate);
      const payoutDate = today; // payout is "now" in the preview
      const cycleEnd = addDays(payoutDate, d - 1);

      const regFee = (payoutDate >= startD && payoutDate <= endD) ? calculateRegistrationFee(p) : 0;

      const overlapStart = dateMax([payoutDate, startD]);
      const overlapEnd = dateMin([cycleEnd, endD]);
      const daysInRange = isAfter(overlapStart, overlapEnd)
        ? 0
        : differenceInCalendarDays(overlapEnd, overlapStart) + 1;

      const fullAccessFee = calculateAccessFee(p, d, r);
      const accessFeeInRange = d > 0 ? Math.round((fullAccessFee * daysInRange) / d) : 0;

      const principalIfInRange = (payoutDate >= startD && payoutDate <= endD) ? p : 0;
      principalDisbursed += principalIfInRange;
      regFeeTotal += regFee;
      accessFeeTotal += accessFeeInRange;

      const total = regFee + accessFeeInRange;
      rows.push({
        id: req.id,
        name: req.profiles?.full_name || 'Agent',
        principal: p,
        cycleDays: d,
        regFee,
        accessFeeInRange,
        daysInRange,
        total,
      });
    }

    return {
      rows,
      regFee: regFeeTotal,
      accessFee: accessFeeTotal,
      principalDisbursed,
      total: regFeeTotal + accessFeeTotal,
    };
  }, [readyToPay, adjustedPrincipals, adjustedCycles, adjustedRates, rangeStart, rangeEnd]);

  if (isLoading) {
    return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div>
          <h2 className="text-base font-bold">Agent Advance Applications</h2>
          <p className="text-xs text-muted-foreground">
            Live view of every agent advance application. Select a card to filter the list below.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            {
              key: 'pending',
              label: 'Agent Applied',
              count: pendingApplications.length,
              icon: Users,
              tone: 'purple',
            },
            {
              key: 'cfo_approved',
              label: 'Approved',
              count: cfoApproved.length,
              icon: CheckCircle2,
              tone: 'green',
            },
            {
              key: 'cfo_rejected',
              label: 'Rejected',
              count: cfoRejected.length,
              icon: XCircle,
              tone: 'red',
            },
          ].map((card) => {
            const active = stageFilter === card.key;
            const Icon = card.icon;
            const toneClasses =
              card.tone === 'purple'
                ? {
                    activeBorder: 'border-purple-500 bg-purple-50 ring-1 ring-purple-200 dark:bg-purple-950/20 dark:ring-purple-900/40',
                    activeIcon: 'bg-purple-600 text-white',
                    inactiveIcon: 'bg-purple-100 text-purple-700 dark:bg-purple-950/30 dark:text-purple-400',
                    value: 'text-purple-700 dark:text-purple-400',
                  }
                : card.tone === 'green'
                ? {
                    activeBorder: 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-200 dark:bg-emerald-950/20 dark:ring-emerald-900/40',
                    activeIcon: 'bg-emerald-600 text-white',
                    inactiveIcon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400',
                    value: 'text-emerald-700 dark:text-emerald-400',
                  }
                : {
                    activeBorder: 'border-rose-500 bg-rose-50 ring-1 ring-rose-200 dark:bg-rose-950/20 dark:ring-rose-900/40',
                    activeIcon: 'bg-rose-600 text-white',
                    inactiveIcon: 'bg-rose-100 text-rose-700 dark:bg-rose-950/30 dark:text-rose-400',
                    value: 'text-rose-700 dark:text-rose-400',
                  };
            return (
              <Card
                key={card.key}
                role="button"
                tabIndex={0}
                aria-pressed={active}
                onClick={() => setStageFilter(active ? 'all' : (card.key as typeof stageFilter))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setStageFilter(active ? 'all' : (card.key as typeof stageFilter));
                  }
                }}
                className={cn(
                  'cursor-pointer transition-all hover:shadow-sm border',
                  active && toneClasses.activeBorder,
                  !active && 'border-border bg-card hover:bg-muted/30',
                )}
              >
                <CardContent className="p-3 flex items-center gap-3">
                  <div
                    className={cn(
                      'rounded-full p-2.5 shrink-0 transition-colors',
                      active ? toneClasses.activeIcon : toneClasses.inactiveIcon,
                    )}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-muted-foreground truncate">{card.label}</p>
                    <p className={cn('text-2xl font-bold leading-tight', active ? toneClasses.value : 'text-foreground')}>
                      {card.count}
                    </p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>



      {/* Global Fee Config */}
      {feeConfig && (
        <Card className="border-primary/20">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Global Default Rate</p>
                <p className="text-2xl font-bold text-primary">{Math.round(Number(feeConfig.default_monthly_rate) * 100)}%</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditingRate(editingRate ? null : 'global')}
                className="gap-1"
              >
                <Pencil className="h-3 w-3" /> Edit
              </Button>
            </div>
            {editingRate === 'global' && (
              <div className="space-y-2 mt-3 p-3 rounded-xl bg-muted/50">
                <p className="text-xs text-muted-foreground">
                  Range: {Math.round(Number(feeConfig.min_rate) * 100)}% – {Math.round(Number(feeConfig.max_rate) * 100)}%
                </p>
                <Slider
                  min={Number(feeConfig.min_rate) * 100}
                  max={Number(feeConfig.max_rate) * 100}
                  step={1}
                  value={[Math.round(Number(feeConfig.default_monthly_rate) * 100)]}
                  onValueChange={([v]) => {
                    updateConfigMutation.mutate(v / 100);
                    setEditingRate(null);
                  }}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Requests — compact review table */}
      {requests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Banknote className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No advance requests pending payment</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Filter bar */}
          <Card className="border-muted">
            <CardContent className="p-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
                <div className="space-y-1">
                  <Label htmlFor="adv-status" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Status</Label>
                  <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
                    <SelectTrigger id="adv-status" className="h-8 text-xs">
                      <SelectValue placeholder="All statuses" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="pending">Agent Applied</SelectItem>
                      <SelectItem value="agent_ops_approved">Ready to Pay</SelectItem>
                      <SelectItem value="cfo_approved">Approved</SelectItem>
                      <SelectItem value="cfo_rejected">Rejected</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="adv-dept" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Department</Label>
                  <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
                    <SelectTrigger id="adv-dept" className="h-8 text-xs">
                      <SelectValue placeholder="All departments" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All departments</SelectItem>
                      {departmentOptions.map((d) => (
                        <SelectItem key={d} value={d}>{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="adv-requester" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Requester</Label>
                  <Input
                    id="adv-requester"
                    type="text"
                    placeholder="Search name or phone"
                    value={requesterFilter}
                    onChange={(e) => setRequesterFilter(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Submitted Date Range</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="date"
                      value={submittedFrom}
                      onChange={(e) => setSubmittedFrom(e.target.value)}
                      className="h-8 text-xs"
                    />
                    <span className="text-muted-foreground">-</span>
                    <Input
                      type="date"
                      value={submittedTo}
                      onChange={(e) => setSubmittedTo(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>

                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs w-full"
                    onClick={clearFilters}
                    disabled={!hasActiveFilters}
                  >
                    Clear Filters
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold">
              {stageFilter === 'pending' ? 'Agent-Submitted Applications' : stageFilter === 'ready' ? 'Agent Ops-Approved · Awaiting CFO Approval' : stageFilter === 'cfo_approved' ? 'CFO-Approved · Ready to Disburse' : 'All Agent Advance Applications'}
            </h3>
            <Badge variant="secondary">{filteredRequests.length} of {requests.length} shown</Badge>
          </div>
          <Card>
            <div className="overflow-x-auto">
              {filteredRequests.length === 0 ? (
                <div className="py-8 text-center">
                  <Banknote className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">No requests match the selected filters.</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>Clear filters</Button>
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 border-b">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold">Requester</th>
                      <th className="text-left px-3 py-2 font-semibold">Department</th>
                      <th className="text-left px-3 py-2 font-semibold">Advance Reference</th>
                      <th className="text-left px-3 py-2 font-semibold">Purpose</th>
                      <th className="text-right px-3 py-2 font-semibold">Amount (UGX)</th>
                      <th className="text-left px-3 py-2 font-semibold">Required Date</th>
                      <th className="text-left px-3 py-2 font-semibold">Submitted Date</th>
                      <th className="text-left px-3 py-2 font-semibold">Status</th>
                      <th className="text-right px-3 py-2 font-semibold">Review</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filteredRequests.map((req: any) => {
                      const profile = req.profiles;
                      const isPending = req.status === 'pending';
                      const isCfoApproved = req.status === 'cfo_approved';
                      const isCfoRejected = req.status === 'cfo_rejected';
                      const currentPrincipal = adjustedPrincipals[req.id] ?? Number(req.principal);
                      const department = profile?.district || profile?.region || profile?.city || '—';
                      const openDetails = () => setDetailReq(req);
                      return (
                        <tr
                          key={req.id}
                          tabIndex={0}
                          role="button"
                          aria-label={`Review advance request from ${profile?.full_name || 'agent'}`}
                          onClick={openDetails}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              openDetails();
                            }
                          }}
                          className="cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        >
                          <td className="px-3 py-2">
                            <p className="font-semibold truncate max-w-[160px]">{profile?.full_name || 'Agent'}</p>
                            {(req.request_kind ?? 'new') === 'topup' && (
                              <Badge variant="outline" className="mt-0.5 text-[9px] px-1.5 py-0 h-4 uppercase tracking-wider bg-violet-100 text-violet-800 border-violet-300 dark:bg-violet-950/30 dark:text-violet-400">
                                Top-up +{Number(req.extend_days ?? 0)}d
                              </Badge>
                            )}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{department}</td>
                          <td className="px-3 py-2 font-mono text-[11px]">{req.id.slice(0, 8)}…</td>
                          <td className="px-3 py-2 max-w-[200px] truncate text-muted-foreground">{req.reason || '—'}</td>
                          <td className="px-3 py-2 text-right font-mono font-bold text-primary">{formatUGX(currentPrincipal)}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{format(new Date(req.created_at), 'dd MMM yyyy')}</td>
                          <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{format(new Date(req.created_at), 'dd MMM yyyy')}</td>
                          <td className="px-3 py-2">
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-[9px] px-1.5 py-0 h-4 uppercase tracking-wider',
                                isCfoRejected
                                  ? 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/30 dark:text-rose-400'
                                  : isCfoApproved
                                  ? 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/30 dark:text-emerald-400'
                                  : 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/30 dark:text-amber-400'
                              )}
                            >
                              {isCfoRejected ? 'Rejected' : isCfoApproved ? 'Approved' : 'Pending'}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-[11px] gap-1"
                              onClick={(e) => {
                                e.stopPropagation();
                                openDetails();
                              }}
                            >
                              <Sparkles className="h-3 w-3" /> Review
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </Card>
        </>
      )}

      {/* Centered details sheet — full request + recovery plan. Approve/Reject
          actions hand off to the existing evaluation and rejection dialogs. */}
      {(() => {
        const req = detailReq ? (allRequests as any[]).find((r: any) => r.id === detailReq.id) ?? detailReq : null;
        if (!req) return null;
        const profile = req.profiles;
        const isPending = req.status === 'pending';
        const isCfoApproved = req.status === 'cfo_approved';
        const isCfoRejected = req.status === 'cfo_rejected';
        const currentRate = adjustedRates[req.id] ?? Number(req.monthly_rate);
        const currentPrincipal = adjustedPrincipals[req.id] ?? Number(req.principal);
        const currentCycle = adjustedCycles[req.id] ?? Number(req.cycle_days);
        const regFee = calculateRegistrationFee(currentPrincipal);
        const accessFee = calculateAccessFee(currentPrincipal, currentCycle, currentRate);
        const totalPayable = currentPrincipal + accessFee + regFee;
        const daily = Math.ceil(totalPayable / currentCycle);
        const department = profile?.district || profile?.region || profile?.city || '—';
        return (
          <Dialog open={!!detailReq} onOpenChange={(open) => !open && setDetailReq(null)}>
            <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="text-base">Advance request details</DialogTitle>
                <DialogDescription className="text-xs">
                  Reference <span className="font-mono">{req.id.slice(0, 8)}…</span> · submitted {format(new Date(req.created_at), 'dd MMM yyyy, HH:mm')}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 text-xs">
                {/* Requester */}
                <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/40">
                  <div className="h-8 w-8 rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0">
                    <User className="h-4 w-4 text-emerald-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold truncate flex items-center gap-1.5">
                      <span className="truncate">{profile?.full_name || 'Agent'}</span>
                      {(req.request_kind ?? 'new') === 'topup' && (
                        <Badge variant="outline" className="shrink-0 text-[9px] px-1.5 py-0 h-4 uppercase tracking-wider bg-violet-100 text-violet-800 border-violet-300 dark:bg-violet-950/30 dark:text-violet-400">
                          Top-up +{Number(req.extend_days ?? 0)}d
                        </Badge>
                      )}
                    </p>
                    <p className="text-[10px] text-muted-foreground">{profile?.phone} · {department}</p>
                    <AgentLocationBadge
                      req={{
                        agent_region: profile?.region,
                        agent_district: profile?.district,
                        agent_sub_county: profile?.sub_county,
                        agent_parish: profile?.parish,
                        agent_village: profile?.village,
                        agent_city: profile?.city,
                      }}
                    />
                  </div>
                  <div className="ml-auto shrink-0">
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[9px] px-1.5 py-0 h-4 uppercase tracking-wider',
                        isCfoRejected
                          ? 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/30 dark:text-rose-400'
                          : isCfoApproved
                          ? 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/30 dark:text-emerald-400'
                          : 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/30 dark:text-amber-400'
                      )}
                    >
                      {isCfoRejected ? 'Rejected' : isCfoApproved ? 'Approved' : 'Pending'}
                    </Badge>
                  </div>
                </div>

                {/* Request summary */}
                <div className="rounded-lg border divide-y">
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Purpose</span>
                    <span className="text-right max-w-[60%]">{req.reason || '—'}</span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Amount requested</span>
                    <span className="font-mono font-bold text-primary">{formatUGX(currentPrincipal)}</span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Required date</span>
                    <span>{format(new Date(req.created_at), 'dd MMM yyyy')}</span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Monthly rate</span>
                    <span className="font-mono">{Math.round(currentRate * 100)}%</span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Access fee</span>
                    <span className="font-mono text-emerald-600">+{formatUGX(accessFee)}</span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Registration fee</span>
                    <span className="font-mono text-emerald-600">+{formatUGX(regFee)}</span>
                  </div>
                </div>

                {/* Recovery plan */}
                <div className="rounded-lg border divide-y">
                  <p className="px-3 py-2 font-bold uppercase tracking-wider text-[10px] text-muted-foreground">Recovery plan</p>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Total payable by agent</span>
                    <span className="font-mono font-bold">{formatUGX(totalPayable)}</span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Cycle length</span>
                    <span className="font-mono">{currentCycle} days</span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Repayment frequency</span>
                    <span className="capitalize">{req.repayment_frequency ?? 'daily'}</span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Daily deduction</span>
                    <span className="font-mono font-bold text-rose-500">{formatUGX(daily)}/d</span>
                  </div>
                </div>

                {isCfoRejected && req.rejection_reason && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/20 p-2">
                    <p className="text-[10px] font-bold uppercase text-rose-700 dark:text-rose-400">Rejection reason</p>
                    <p className="text-rose-800 dark:text-rose-300">{req.rejection_reason}</p>
                  </div>
                )}
              </div>

              <DialogFooter className="flex-col gap-2 sm:flex-row">
                {!isCfoRejected && (
                  <Button
                    variant="outline"
                    className="w-full sm:w-auto gap-2 border-rose-300 text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                    onClick={() => {
                      setDetailReq(null);
                      setRejectReason('');
                      setRejectingReq(req);
                    }}
                  >
                    <X className="h-4 w-4" /> Reject
                  </Button>
                )}
                <Button
                  className={cn(
                    'w-full sm:flex-1 gap-2 text-white',
                    isCfoRejected ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700',
                  )}
                  onClick={() => {
                    setDetailReq(null);
                    setEvalReq(req);
                  }}
                >
                  <Sparkles className="h-4 w-4" />
                  {isCfoRejected ? 'View rejection' : isCfoApproved ? 'Review & disburse' : 'Approve'} · {formatUGX(currentPrincipal)}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      })()}

      {/* Confirmation Dialog */}
      {(() => {
        // Look up the request in the full unfiltered list so an active
        // stage filter never hides the confirmation dialog (e.g. the CFO
        // has "Approved · Disburse" selected but the next request is
        // still pending).
        const req = (allRequests as any[]).find((r: any) => r.id === confirmingId);
        if (!req) return null;
        const profile = req.profiles;
        const principal = adjustedPrincipals[req.id] ?? Number(req.principal);
        const cycleDays = adjustedCycles[req.id] ?? Number(req.cycle_days);
        const rate = adjustedRates[req.id] ?? Number(req.monthly_rate);
        const regFee = calculateRegistrationFee(principal);
        const accessFee = calculateAccessFee(principal, cycleDays, rate);
        const totalPayable = principal + accessFee + regFee;
        const daily = Math.ceil(totalPayable / cycleDays);
        const weEarn = accessFee + regFee;
        const originalPrincipal = Number(req.principal);
        const originalCycle = Number(req.cycle_days);
        const principalChanged = principal !== originalPrincipal;
        const cycleChanged = cycleDays !== originalCycle;
        const isApprovedAlready = req.status === 'cfo_approved';
        const busy = payMutation.isPending || approveAndPayMutation.isPending || approveMutation.isPending;

        return (
          <Dialog open={!!confirmingId} onOpenChange={(open) => !open && setConfirmingId(null)}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  Confirm Agent Advance Payout
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Review the edited details before crediting {profile?.full_name || 'Agent'}&apos;s wallet.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 py-2">
                {/* Agent identity */}
                <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/40">
                  <div className="h-8 w-8 rounded-full bg-emerald-500/10 flex items-center justify-center">
                    <User className="h-4 w-4 text-emerald-600" />
                  </div>
                  <div>
                    <p className="text-sm font-bold">{profile?.full_name || 'Agent'}</p>
                    <p className="text-[10px] text-muted-foreground">{profile?.phone}</p>
                  </div>
                </div>

                {/* Key figures */}
                <div className="rounded-lg border divide-y text-xs">
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Principal to Wallet</span>
                    <span className={cn('font-mono font-bold', principalChanged ? 'text-amber-600' : 'text-foreground')}>
                      {formatUGX(principal)}
                      {principalChanged && <span className="ml-1 text-[10px] text-muted-foreground">(was {formatUGX(originalPrincipal)})</span>}
                    </span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Cycle Days</span>
                    <span className={cn('font-mono font-bold', cycleChanged ? 'text-amber-600' : 'text-foreground')}>
                      {cycleDays} days
                      {cycleChanged && <span className="ml-1 text-[10px] text-muted-foreground">(was {originalCycle})</span>}
                    </span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Monthly Rate</span>
                    <span className="font-mono font-bold">{Math.round(rate * 100)}%</span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Access Fee</span>
                    <span className="font-mono font-bold text-emerald-600">+{formatUGX(accessFee)}</span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">Registration Fee</span>
                    <span className="font-mono font-bold text-emerald-600">+{formatUGX(regFee)}</span>
                  </div>
                  <div className="flex justify-between px-3 py-2 bg-muted/30">
                    <span className="font-bold">Total Payable by Agent</span>
                    <span className="font-mono font-bold text-primary">{formatUGX(totalPayable)}</span>
                  </div>
                  <div className="flex justify-between px-3 py-2 bg-muted/30">
                    <span className="font-bold">Daily Deduction</span>
                    <span className="font-mono font-bold text-red-500">{formatUGX(daily)}/d</span>
                  </div>
                </div>

                {/* Ledger entries preview — exactly what create_ledger_transaction will post */}
                <div className="rounded-lg border-2 border-border dark:border-slate-700 bg-muted dark:bg-slate-900/40 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground dark:text-slate-300" />
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground dark:text-slate-300">
                      Ledger entries to be posted
                    </p>
                    <Badge variant="outline" className="text-[9px] uppercase tracking-wider">
                      {regFee > 0 ? '4 legs · 2 txns' : '2 legs · 1 txn'}
                    </Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Double-entry, balanced. <span className="font-mono">source_table=agent_advance_requests</span>, <span className="font-mono">source_id={req.id.slice(0, 8)}…</span>
                  </p>
                  <div className="overflow-x-auto -mx-1">
                    <table className="w-full text-[10px] font-mono">
                      <thead className="text-muted-foreground">
                        <tr className="border-b">
                          <th className="text-left px-1 py-1">#</th>
                          <th className="text-left px-1 py-1">Scope</th>
                          <th className="text-left px-1 py-1">Dir</th>
                          <th className="text-left px-1 py-1">Category</th>
                          <th className="text-right px-1 py-1">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-b">
                          <td className="px-1 py-1">1</td>
                          <td className="px-1 py-1">wallet</td>
                          <td className="px-1 py-1 text-emerald-600">cash_in</td>
                          <td className="px-1 py-1">agent_advance_credit</td>
                          <td className="px-1 py-1 text-right text-emerald-600">+{formatUGX(principal)}</td>
                        </tr>
                        <tr className="border-b">
                          <td className="px-1 py-1">2</td>
                          <td className="px-1 py-1">platform</td>
                          <td className="px-1 py-1 text-red-600">cash_out</td>
                          <td className="px-1 py-1">rent_disbursement</td>
                          <td className="px-1 py-1 text-right text-red-600">-{formatUGX(principal)}</td>
                        </tr>
                        {regFee > 0 && (
                          <>
                            <tr className="border-b">
                              <td className="px-1 py-1">3</td>
                              <td className="px-1 py-1">platform</td>
                              <td className="px-1 py-1 text-emerald-600">cash_in</td>
                              <td className="px-1 py-1">registration_fee_collected</td>
                              <td className="px-1 py-1 text-right text-emerald-600">+{formatUGX(regFee)}</td>
                            </tr>
                            <tr>
                              <td className="px-1 py-1">4</td>
                              <td className="px-1 py-1">wallet</td>
                              <td className="px-1 py-1 text-red-600">cash_out</td>
                              <td className="px-1 py-1">registration_fee_collected</td>
                              <td className="px-1 py-1 text-right text-red-600">-{formatUGX(regFee)}</td>
                            </tr>
                          </>
                        )}
                      </tbody>
                      <tfoot>
                        <tr className="border-t bg-muted/40">
                          <td colSpan={3} className="px-1 py-1 font-bold">Net (must balance)</td>
                          <td className="px-1 py-1 text-right text-muted-foreground">wallet / platform</td>
                          <td className="px-1 py-1 text-right font-bold">
                            {formatUGX(0)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <div className="text-[10px] text-muted-foreground space-y-0.5 pt-1 border-t">
                    <p>· Also inserts <span className="font-mono">agent_advances</span> row (principal {formatUGX(principal)}, outstanding {formatUGX(totalPayable)}, {cycleDays}d, rate {Math.round(rate * 100)}%).</p>
                    <p>· Access fee <span className="font-mono text-emerald-700">+{formatUGX(accessFee)}</span> is recognised over {cycleDays}d by the daily deduction engine — not posted now.</p>
                  </div>
                </div>

                {/* Revenue summary */}
                <div className="rounded-lg border-2 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-1">How Welile earns</p>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground">Gross revenue on this advance</span>
                    <span className="font-mono font-bold text-emerald-700 dark:text-emerald-400">+{formatUGX(weEarn)}</span>
                  </div>
                </div>

                {notes[req.id] && (
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 p-2">
                    <p className="text-[10px] font-bold uppercase text-amber-700 dark:text-amber-400">CFO Note</p>
                    <p className="text-xs text-amber-800 dark:text-amber-300">{notes[req.id]}</p>
                  </div>
                )}
              </div>

              <DialogFooter className="flex-col gap-2 sm:flex-row">
                <Button
                  variant="outline"
                  onClick={() => setConfirmingId(null)}
                  className="w-full sm:w-auto"
                >
                  <X className="h-4 w-4 mr-1" /> Cancel
                </Button>
                <Button
                  onClick={() => {
                    if (isApprovedAlready) {
                      payMutation.mutate(req);
                    } else {
                      approveAndPayMutation.mutate(req);
                    }
                    setConfirmingId(null);
                  }}
                  disabled={busy}
                  className="w-full sm:w-auto gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  {isApprovedAlready ? 'Confirm & Disburse' : 'Approve & Disburse'} {formatUGX(principal)}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      })()}

      {/* Shared advance-eligibility evaluation popup — identical to Agent Ops */}
      <AgentAdvanceEvaluationDialog
        req={evalReq}
        agentId={evalReq?.agent_id}
        agentName={evalReq?.profiles?.full_name}
        onClose={() => setEvalReq(null)}
        footer={evalReq ? (() => {
          const req = evalReq;
          const isCfoApproved = req.status === 'cfo_approved';
          const isCfoRejected = req.status === 'cfo_rejected';
          const currentRate = adjustedRates[req.id] ?? Number(req.monthly_rate);
          const currentPrincipal = adjustedPrincipals[req.id] ?? Number(req.principal);
          const currentCycle = adjustedCycles[req.id] ?? Number(req.cycle_days);
          const regFee = calculateRegistrationFee(currentPrincipal);
          const accessFee = calculateAccessFee(currentPrincipal, currentCycle, currentRate);
          const totalPayable = currentPrincipal + accessFee + regFee;
          const daily = Math.ceil(totalPayable / currentCycle);
          return (
            <div className="space-y-3 w-full">
              <div className="rounded-lg border-2 border-primary/30 bg-primary/5 p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <Pencil className="h-3.5 w-3.5 text-primary" />
                  <p className="text-xs font-bold uppercase tracking-wider text-primary">
                    {isCfoApproved ? 'Approved — disburse' : 'Set final amount & approve'}
                  </p>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Amount (UGX)</Label>
                    <Input
                      type="number"
                      value={currentPrincipal}
                      min={1000}
                      step={1000}
                      disabled={isCfoApproved}
                      onChange={e => setAdjustedPrincipals(prev => ({ ...prev, [req.id]: Math.max(0, Number(e.target.value) || 0) }))}
                      className="h-8 text-sm disabled:opacity-70"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Days</Label>
                    <Input
                      type="number"
                      value={currentCycle}
                      min={1}
                      max={365}
                      disabled={isCfoApproved}
                      onChange={e => setAdjustedCycles(prev => ({ ...prev, [req.id]: Math.max(1, Number(e.target.value) || 1) }))}
                      className="h-8 text-sm disabled:opacity-70"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Rate %</Label>
                    <Input
                      type="number"
                      value={Math.round(currentRate * 100)}
                      min={28}
                      max={33}
                      step={1}
                      disabled={isCfoApproved}
                      onChange={e => {
                        const v = Math.min(33, Math.max(28, Number(e.target.value) || 28));
                        setAdjustedRates(prev => ({ ...prev, [req.id]: v / 100 }));
                      }}
                      className="h-8 text-sm disabled:opacity-70"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 rounded-md border bg-background/60 p-2 text-[11px]">
                  <div><span className="text-muted-foreground">Access fee</span> <span className="font-bold text-emerald-600 float-right">+{formatUGX(accessFee)}</span></div>
                  <div><span className="text-muted-foreground">Reg fee</span> <span className="font-bold text-emerald-600 float-right">+{formatUGX(regFee)}</span></div>
                  <div><span className="text-muted-foreground">Total payable</span> <span className="font-bold text-primary float-right">{formatUGX(totalPayable)}</span></div>
                  <div><span className="text-muted-foreground">Daily</span> <span className="font-bold text-rose-500 float-right">{formatUGX(daily)}/d</span></div>
                </div>

                <Textarea
                  placeholder="CFO note (optional)"
                  value={notes[req.id] || ''}
                  onChange={e => setNotes(prev => ({ ...prev, [req.id]: e.target.value }))}
                  rows={1}
                  className="text-xs"
                />
              </div>

              {isCfoRejected ? (
                <div className="rounded-lg border-2 border-rose-300 bg-rose-50 dark:bg-rose-950/20 p-3">
                  <p className="text-[10px] font-bold uppercase text-rose-700 dark:text-rose-400 mb-1">Rejected by CFO</p>
                  <p className="text-xs text-rose-800 dark:text-rose-300">
                    {req.rejection_reason || 'No reason recorded'}
                  </p>
                </div>
              ) : (
                <>
                <DuplicateAccountAlert
                  dups={req.agent_id ? cfoDuplicateMap[req.agent_id] : undefined}
                  flag={req.agent_id ? cfoDuplicateFlagMap[req.agent_id] : undefined}
                />
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    variant="outline"
                    className="w-full sm:w-auto gap-2 border-rose-300 text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                    onClick={() => {
                      setRejectReason('');
                      setRejectingReq(req);
                    }}
                  >
                    <X className="h-4 w-4" /> Reject
                  </Button>
                  <Button
                    className="w-full sm:flex-1 gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
                    disabled={currentPrincipal <= 0}
                    onClick={() => {
                      const id = req.id;
                      setEvalReq(null);
                      setConfirmingId(id);
                    }}
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {isCfoApproved ? 'Disburse' : 'Approve'} {formatUGX(currentPrincipal)}
                  </Button>
                </div>
                <Button
                  variant="outline"
                  className="w-full gap-2 border-red-400 text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                  onClick={() => setDupRejectReq(req)}
                >
                  <ShieldX className="h-4 w-4" /> Reject as duplicate account &amp; block
                </Button>
                </>
              )}

              {isCfoApproved && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => revokeApprovalMutation.mutate(req)}
                  disabled={revokeApprovalMutation.isPending}
                  className="w-full h-7 text-[11px] text-muted-foreground"
                >
                  {revokeApprovalMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Revoke approval & re-open for editing'}
                </Button>
              )}
            </div>
          );
        })() : null}
      />

      {/* Disbursement success dialog — shows the CFO confirmation, key stats,
          plus a shortcut to jump straight to the next pending request. */}
      <Dialog open={!!disbursed} onOpenChange={(open) => !open && setDisbursed(null)}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto flex flex-col">
          <DialogHeader>
            <div className="mx-auto mb-1 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
              <CheckCircle2 className="h-8 w-8 text-emerald-600" />
            </div>
            <DialogTitle className="text-center text-base">Advance Disbursed</DialogTitle>
            <DialogDescription className="text-center text-xs">
              {disbursed?.principal !== undefined && (
                <>
                  <span className="font-semibold text-foreground">{formatUGX(disbursed.principal)}</span>{' '}
                  credited to <span className="font-semibold text-foreground">{disbursed?.agentName}</span>&apos;s withdrawable wallet.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {disbursed && (
            <div className="rounded-lg border divide-y text-xs">
              <div className="flex justify-between px-3 py-2">
                <span className="text-muted-foreground">Principal to Wallet</span>
                <span className="font-mono font-bold text-emerald-600">{formatUGX(disbursed.principal)}</span>
              </div>
              <div className="flex justify-between px-3 py-2">
                <span className="text-muted-foreground">Cycle Days</span>
                <span className="font-mono font-bold">{disbursed.cycleDays} days</span>
              </div>
              <div className="flex justify-between px-3 py-2">
                <span className="text-muted-foreground">Access + Registration Fees</span>
                <span className="font-mono font-bold text-emerald-600">+{formatUGX(disbursed.accessFee + disbursed.registrationFee)}</span>
              </div>
              <div className="flex justify-between px-3 py-2 bg-muted/30">
                <span className="font-bold">Total Payable by Agent</span>
                <span className="font-mono font-bold text-primary">{formatUGX(disbursed.totalPayable)}</span>
              </div>
              <div className="flex justify-between px-3 py-2 bg-muted/30">
                <span className="font-bold">Daily Deduction</span>
                <span className="font-mono font-bold text-red-500">{formatUGX(disbursed.daily)}/d</span>
              </div>
            </div>
          )}

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end shrink-0 pt-2 border-t bg-background sticky bottom-0">
            <Button
              variant="outline"
              onClick={() => setDisbursed(null)}
              className="w-full sm:w-auto"
            >
              <X className="h-4 w-4 mr-1" /> Dismiss
            </Button>
            {(() => {
              // First still-actionable request (pending or agent-ops approved, or
              // cfo_approved awaiting disbursement) that isn't the one we just paid.
              const nextReq = (allRequests as any[]).find(r =>
                ['pending', 'agent_ops_approved', 'cfo_approved'].includes(r.status)
              );
              if (!nextReq) return null;
              return (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDisbursed(null);
                    setEvalReq(nextReq);
                  }}
                  className="w-full sm:w-auto gap-2"
                >
                  <Sparkles className="h-4 w-4" /> Next request
                </Button>
              );
            })()}
            <Button
              onClick={() => {
                setDisbursed(null);
                // Jump to the dedicated Disbursed & Repayments tab.
                if (onViewDisbursed) {
                  onViewDisbursed();
                } else {
                  requestAnimationFrame(() => {
                    document.getElementById('cfo-disbursed-advances')?.scrollIntoView({
                      behavior: 'smooth',
                      block: 'start',
                    });
                  });
                }
              }}
              className="w-full sm:w-auto gap-2"
            >
              <Banknote className="h-4 w-4" /> View all disbursed advances
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject reason dialog — CFO must supply a reason. */}
      <RejectAsDuplicateDialog
        requestId={dupRejectReq?.id ?? null}
        agentName={dupRejectReq?.profiles?.full_name}
        dups={dupRejectReq?.agent_id ? cfoDuplicateMap[dupRejectReq.agent_id] : undefined}
        onOpenChange={(open) => { if (!open) setDupRejectReq(null); }}
        onDone={() => { setDupRejectReq(null); setEvalReq(null); }}
      />

      <Dialog open={!!rejectingReq} onOpenChange={(open) => {
        if (!open) { setRejectingReq(null); setRejectReason(''); }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <X className="h-5 w-5 text-rose-600" /> Reject Advance Request
            </DialogTitle>
            <DialogDescription className="text-xs">
              {rejectingReq?.profiles?.full_name ? (
                <>Reject <span className="font-semibold text-foreground">{rejectingReq.profiles.full_name}</span>&apos;s request for {formatUGX(Number(rejectingReq?.principal ?? 0))}. The agent and Agent Ops will see the reason.</>
              ) : 'Provide a reason. The agent and Agent Ops will see it.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Reason for rejection</Label>
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={4}
              placeholder="E.g. Insufficient trust score, outstanding advance not settled, exposure too high…"
              className="text-sm"
            />
            <p className="text-[10px] text-muted-foreground">Minimum 5 characters.</p>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => { setRejectingReq(null); setRejectReason(''); }}
              disabled={rejectMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              className="w-full sm:w-auto gap-2 bg-rose-600 hover:bg-rose-700 text-white"
              disabled={rejectReason.trim().length < 5 || rejectMutation.isPending}
              onClick={() => rejectingReq && rejectMutation.mutate({ req: rejectingReq, reason: rejectReason })}
            >
              {rejectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
              Confirm rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
