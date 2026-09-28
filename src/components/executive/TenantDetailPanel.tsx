import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Phone, MessageCircle, User, ArrowLeft, MapPin, FileSearch, Pencil, Save, X, Loader2, ArrowRightLeft, Banknote, Wallet, FileText, FileSpreadsheet, ShieldCheck, ShieldAlert } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { calculateRentRepayment } from '@/lib/rentCalculations';
import { Textarea } from '@/components/ui/textarea';
import TenantAssignAgentDialog from '@/components/shared/TenantAssignAgentDialog';
import { RepaymentPauseControl } from '@/components/ops/RepaymentPauseControl';
import { PaymentPeriodControl } from '@/components/ops/PaymentPeriodControl';
import { CallCentreSmartphonePanel } from './CallCentreSmartphonePanel';
import {
  downloadRentCollectionReceiptPdf,
  downloadRentCollectionReceiptXlsx,
  type RentCollectionReceiptData,
} from '@/lib/rentCollectionReceipt';

const statusColor = (s: string) => {
  const m: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-700',
    tenant_ops_approved: 'bg-blue-100 text-blue-700',
    agent_verified: 'bg-purple-100 text-purple-700',
    funded: 'bg-green-100 text-green-700',
    disbursed: 'bg-teal-100 text-teal-700',
    repaying: 'bg-purple-100 text-purple-700',
    fully_repaid: 'bg-emerald-100 text-emerald-700',
    defaulted: 'bg-destructive/10 text-destructive',
  };
  return m[s] || 'bg-muted';
};

interface TenantProfile {
  id: string;
  full_name: string | null;
  phone: string | null;
  city: string | null;
  created_at: string | null;
  smartphone_status?: string | null;
  smartphone_source?: string | null;
}

interface TenantDetailPanelProps {
  tenantId: string;
  tenantName: string;
  onBack: () => void;
  onViewRegistration?: () => void;
}

export function TenantDetailPanel({ tenantId, tenantName, onBack, onViewRegistration }: TenantDetailPanelProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Profile edit state
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileEdit, setProfileEdit] = useState({ full_name: '', phone: '', city: '' });

  // Request edit state — keyed by request id
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);
  const [savingRequest, setSavingRequest] = useState(false);
  const [requestEdit, setRequestEdit] = useState({ rent_amount: '', duration_days: '', access_fee: '', request_fee: '', outstanding: '', reason: '' });
  // Tracks whether the operator actually edited the Outstanding field. If they
  // only corrected the rent amount, we must NOT recompute repaid from a stale
  // outstanding figure — that silently marks the tenant as (over) paid and
  // drops them out of the agent's owing list.
  const [outstandingTouched, setOutstandingTouched] = useState(false);

  // Total Repaid inline-edit state (stats card)
  const [editingRepaid, setEditingRepaid] = useState(false);
  const [savingRepaid, setSavingRepaid] = useState(false);
  const [repaidEdit, setRepaidEdit] = useState({ amount: '', reason: '' });

  // Outstanding stat inline-edit state
  const [editingOutstanding, setEditingOutstanding] = useState(false);
  const [savingOutstanding, setSavingOutstanding] = useState(false);
  const [outstandingEdit, setOutstandingEdit] = useState({ amount: '', reason: '' });
  const [requestOverrides, setRequestOverrides] = useState<Record<string, Record<string, number>>>({});

  // Transfer agent dialog state
  const [transferReq, setTransferReq] = useState<{ id: string; agent_id: string | null } | null>(null);

  // Rent collection state — collect outstanding from the tenant's wallet first,
  // then fall back to a linked agent's wallet (for tenants without a smartphone).
  const [collectingReqId, setCollectingReqId] = useState<string | null>(null);
  const [collectReason, setCollectReason] = useState('');
  // Custom UGX amount for partial collections — empty means collect the default
  // daily charge. The collector can lower this to take only part of what's owed.
  const [collectAmount, setCollectAmount] = useState('');
  // Last successful collection receipt — drives the download (PDF/Excel) UI.
  const [lastReceipt, setLastReceipt] = useState<RentCollectionReceiptData | null>(null);
  const [downloadingReceipt, setDownloadingReceipt] = useState<'pdf' | 'xlsx' | null>(null);
  // Receipt validation — confirms the receipt amounts (UGX), commission and
  // remaining balance reconcile against the posted collection ledger before
  // the receipt can be downloaded.
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ ok: boolean; issues: string[] } | null>(null);
  const [validationOverride, setValidationOverride] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['tenant-detail', tenantId],
    queryFn: async () => {
      const [profileRes, requestsRes, walletRes, collectionsRes] = await Promise.all([
        supabase.from('profiles').select('id, full_name, phone, city, created_at, smartphone_status, smartphone_source').eq('id', tenantId).maybeSingle(),
        supabase.from('rent_requests').select('id, status, rent_amount, amount_repaid, daily_repayment, repayment_frequency, duration_days, access_fee, request_fee, total_repayment, registration_type, created_at, landlord_id, agent_id, assigned_agent_id').eq('tenant_id', tenantId).order('created_at', { ascending: false }),
        supabase.from('wallet_transactions').select('id, amount, type, created_at, description').or(`sender_id.eq.${tenantId},recipient_id.eq.${tenantId}`).order('created_at', { ascending: false }).limit(10),
        supabase.from('agent_collections').select('id, amount, created_at, agent_id, payment_method, rent_request_id').is('reversed_at', null).eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(200),
      ]);

      const collectionTotalsByRequest = new Map<string, number>();
      for (const c of collectionsRes.data || []) {
        const rentRequestId = (c as any).rent_request_id as string | null;
        if (!rentRequestId) continue;
        collectionTotalsByRequest.set(
          rentRequestId,
          (collectionTotalsByRequest.get(rentRequestId) || 0) + Number((c as any).amount || 0),
        );
      }

      const agentIds = [...new Set((requestsRes.data || []).flatMap(r => [r.assigned_agent_id, r.agent_id]).filter(Boolean))] as string[];
      const agentRes = agentIds.length > 0
        ? await supabase.from('profiles').select('id, full_name, phone').in('id', agentIds)
        : { data: [] as { id: string; full_name: string; phone: string }[] };
      const agentMap = new Map((agentRes.data || []).map(a => [a.id, a]));

      const landlordIds = [...new Set((requestsRes.data || []).map(r => r.landlord_id).filter(Boolean))] as string[];
      const landlordRes = landlordIds.length > 0
        ? await supabase.from('landlords').select('id, name, phone').in('id', landlordIds)
        : { data: [] as { id: string; name: string; phone: string }[] };
      const landlordMap = new Map((landlordRes.data || []).map(l => [l.id, l]));

      return {
        profile: profileRes.data as unknown as TenantProfile | null,
        requests: (requestsRes.data || []).map(r => {
          const effectiveAgentId = r.assigned_agent_id || r.agent_id;
          return {
            ...r,
            amount_repaid: Math.max(
              Number(r.amount_repaid || 0),
              Math.min(
                Number(r.total_repayment || r.rent_amount || 0),
                collectionTotalsByRequest.get(r.id) || 0,
              ),
            ),
            agent_name: (effectiveAgentId && agentMap.get(effectiveAgentId)?.full_name) || 'Not Assigned',
            landlord_name: landlordMap.get(r.landlord_id)?.name || '—',
          };
        }),
        walletTxns: walletRes.data || [],
        collections: (collectionsRes.data || []).slice(0, 10),
      };
    },
  });

  const profile = data?.profile;

  // Tenant migration history — every recorded transfer between agents.
  const { data: transferHistory } = useQuery({
    queryKey: ['tenant-transfer-history', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_tenant_transfer_history', { p_tenant_id: tenantId });
      if (error) throw error;
      return (data || []) as Array<{
        id: string;
        occurred_at: string;
        source: string;
        from_agent_name: string | null;
        to_agent_name: string | null;
        actor_name: string | null;
        reason: string | null;
      }>;
    },
  });
  const rawRequests = data?.requests || [];
  const requests = rawRequests.map((r: any) => (
    requestOverrides[r.id] ? { ...r, ...requestOverrides[r.id] } : r
  ));
  // The true obligation is total_repayment (rent + Welile fees), since amount_repaid
  // is tracked against that same total. rent_amount is only the property's monthly rent
  // kept for context and would understate the obligation, producing negative outstanding.
  const obligationFor = (r: any) =>
    Number(r.total_repayment || 0) > 0
      ? Number(r.total_repayment || 0)
      : Number(r.rent_amount || 0);
  // Only LIVE rent plans create an obligation. Rejected / deleted / cancelled
  // plans, plans still awaiting vetting or approval (no money left the company
  // yet) and closed-out plans must never inflate what the tenant owes today —
  // otherwise a tenant with one rejected and one funded plan (e.g. Mango
  // Charles) shows double the real balance.
  const LIVE_OBLIGATION_STATUSES = ['funded', 'repaying'];
  const liveReqs = requests.filter(r =>
    LIVE_OBLIGATION_STATUSES.includes(String((r as any).status || '').toLowerCase())
  );
  const totalRent = liveReqs.reduce((s, r) => s + obligationFor(r), 0);
  const totalRepaid = liveReqs.reduce((s, r) => s + Number(r.amount_repaid || 0), 0);
  // Clamp at 0 — a fully-repaid tenant can never owe a negative amount.
  const outstandingTotal = Math.max(0, totalRent - totalRepaid);

  // Inline editing on the Outstanding card targets any single active rent request,
  // regardless of registration_type. When the tenant has multiple requests, edit
  // them individually from the Rent Requests list below.
  const activeReqs = requests.filter(r => {
    const status = String((r as any).status || '').toLowerCase();
    return status !== 'completed' && status !== 'closed' && status !== 'cancelled' && status !== 'rejected';
  });
  // Outstanding correction targets any request that still carries a residual
  // balance — including 'completed'/'closed' rows where the obligation was
  // never fully repaid. Managers must be able to fix these. Fallback to all
  // requests so an over-repaid tenant (outstanding = 0) can still be corrected.
  const outstandingEditableReqs = (() => {
    const withResidual = liveReqs.filter(r => {
      const repaid = Number(r.amount_repaid || 0);
      return obligationFor(r) - repaid > 0;
    });
    if (withResidual.length > 0) return withResidual;
    return liveReqs.length > 0 ? liveReqs : (activeReqs.length > 0 ? activeReqs : requests);
  })();
  const editableOutstandingReq = outstandingEditableReqs[0] || null;

  const applyConfirmedRequestUpdates = (updates: Record<string, Record<string, number>>) => {
    if (Object.keys(updates).length === 0) return;
    setRequestOverrides(prev => {
      const next = { ...prev };
      for (const [id, patch] of Object.entries(updates)) {
        next[id] = { ...(next[id] || {}), ...patch };
      }
      return next;
    });
    queryClient.setQueryData(['tenant-detail', tenantId], (old: any) => {
      if (!old?.requests) return old;
      return {
        ...old,
        requests: old.requests.map((r: any) => (
          updates[r.id] ? { ...r, ...updates[r.id] } : r
        )),
      };
    });
  };

  type CorrectedRentRequest = {
    id: string;
    rent_amount: number | null;
    duration_days: number | null;
    access_fee: number | null;
    request_fee: number | null;
    total_repayment: number | null;
    daily_repayment: number | null;
    amount_repaid: number | null;
  };

  const correctRentRequest = async (
    rentRequestId: string,
    reason: string,
    patch: Partial<Record<'rent_amount' | 'duration_days' | 'access_fee' | 'request_fee' | 'total_repayment' | 'daily_repayment' | 'amount_repaid', number>>,
  ) => {
    const { data: corrected, error } = await (supabase as any).rpc('tenant_ops_correct_rent_request', {
      p_rent_request_id: rentRequestId,
      p_rent_amount: patch.rent_amount ?? null,
      p_duration_days: patch.duration_days ?? null,
      p_access_fee: patch.access_fee ?? null,
      p_request_fee: patch.request_fee ?? null,
      p_total_repayment: patch.total_repayment ?? null,
      p_daily_repayment: patch.daily_repayment ?? null,
      p_amount_repaid: patch.amount_repaid ?? null,
      p_reason: reason,
    });
    if (error) throw error;
    const row = (Array.isArray(corrected) ? corrected[0] : corrected) as CorrectedRentRequest | null;
    if (!row?.id) throw new Error('Rent request correction did not return a saved row');

    // Since 20260928140000 this RPC QUEUES the correction and returns the plan
    // unchanged — nothing moves until the CFO approves it. The patch below is
    // therefore the CURRENT figures, which is what the fields should snap back
    // to, and the operator needs telling why their edit appears not to stick.
    toast.info('Sent to the CFO for approval', {
      description: 'The tenant’s plan does not change until it is approved.',
    });

    const savedPatch: Record<string, number> = {};
    if (patch.rent_amount !== undefined) savedPatch.rent_amount = Number(row.rent_amount ?? patch.rent_amount);
    if (patch.duration_days !== undefined) savedPatch.duration_days = Number(row.duration_days ?? patch.duration_days);
    if (patch.access_fee !== undefined) savedPatch.access_fee = Number(row.access_fee ?? patch.access_fee);
    if (patch.request_fee !== undefined) savedPatch.request_fee = Number(row.request_fee ?? patch.request_fee);
    if (patch.total_repayment !== undefined) savedPatch.total_repayment = Number(row.total_repayment ?? patch.total_repayment);
    if (patch.daily_repayment !== undefined) savedPatch.daily_repayment = Number(row.daily_repayment ?? patch.daily_repayment);
    if (patch.amount_repaid !== undefined) savedPatch.amount_repaid = Number(row.amount_repaid ?? patch.amount_repaid);
    return savedPatch;
  };

  // --- Total Repaid inline editing ---
  // Managers may correct amount_repaid across the tenant's requests. Distribute
  // proportionally to each request's current amount_repaid (fallback: current
  // total_repayment) so nothing exceeds its request's total_repayment.
  const startEditRepaid = () => {
    if (requests.length === 0) return;
    setRepaidEdit({ amount: String(Math.max(0, totalRepaid)), reason: '' });
    setEditingRepaid(true);
  };

  const saveRepaid = async () => {
    if (requests.length === 0) return;
    const desired = Number(repaidEdit.amount);
    const reason = repaidEdit.reason.trim();
    if (!Number.isFinite(desired) || desired < 0) { toast.error('Enter a valid repaid amount'); return; }
    if (reason.length < 10) { toast.error('Reason must be at least 10 characters'); return; }

    // Cap desired at total obligation across all requests.
    const totalObligation = requests.reduce((s, r) => s + obligationFor(r), 0);
    if (desired > totalObligation) {
      toast.error(`Repaid cannot exceed total obligation UGX ${totalObligation.toLocaleString()}`);
      return;
    }

    // Build proportional shares based on current amount_repaid; if all zero, use obligation.
    const infos = requests.map(r => ({
      req: r,
      currentRepaid: Number(r.amount_repaid || 0),
      obligation: obligationFor(r),
    }));
    const sumCurrent = infos.reduce((s, x) => s + x.currentRepaid, 0);
    const sumObligation = infos.reduce((s, x) => s + x.obligation, 0);

    let shares: number[];
    if (sumCurrent > 0) {
      shares = infos.map(x => Math.round((x.currentRepaid / sumCurrent) * desired));
    } else if (sumObligation > 0) {
      shares = infos.map(x => Math.round((x.obligation / sumObligation) * desired));
    } else {
      const each = Math.round(desired / infos.length);
      shares = infos.map(() => each);
    }
    // Fix rounding drift
    const drift = desired - shares.reduce((s, n) => s + n, 0);
    if (shares.length > 0) shares[shares.length - 1] += drift;

    // Clamp each share to [0, obligation]. Redistribute overflow to under-cap requests.
    let overflow = 0;
    for (let i = 0; i < shares.length; i++) {
      if (shares[i] < 0) { overflow += shares[i]; shares[i] = 0; }
      if (shares[i] > infos[i].obligation) { overflow += (shares[i] - infos[i].obligation); shares[i] = infos[i].obligation; }
    }
    if (overflow !== 0) {
      for (let i = 0; i < shares.length && overflow > 0; i++) {
        const room = infos[i].obligation - shares[i];
        const add = Math.min(room, overflow);
        shares[i] += add;
        overflow -= add;
      }
    }

    setSavingRepaid(true);
    try {
      const confirmedUpdates: Record<string, Record<string, number>> = {};
      for (let i = 0; i < infos.length; i++) {
        const { req, currentRepaid } = infos[i];
        const newRepaid = shares[i];
        if (newRepaid === currentRepaid) continue;
        const persistedPatch = await correctRentRequest(req.id, reason, { amount_repaid: newRepaid });
        confirmedUpdates[req.id] = persistedPatch;
        applyConfirmedRequestUpdates({ [req.id]: persistedPatch });
      }

      // Do not immediately refetch tenant-detail here: the write is already
      // confirmed, and an immediate refetch can briefly restore stale rows in
      // the summary strip. Patch the local detail cache so Total Repaid changes
      // on the same render as the correction.
      applyConfirmedRequestUpdates(confirmedUpdates);
      queryClient.invalidateQueries({ queryKey: ['exec-tenant-ops'] });
      queryClient.invalidateQueries({ queryKey: ['coo-tenant-balances'] });
      toast.success(
        infos.length === 1 ? 'Total Repaid updated' : `Total Repaid distributed across ${infos.length} requests`,
      );
      setEditingRepaid(false);
    } catch (e: any) {
      toast.error(e.message || 'Failed to save');
    } finally {
      setSavingRepaid(false);
    }
  };

  const startEditOutstanding = () => {
    if (outstandingEditableReqs.length === 0) return;
    setOutstandingEdit({
      amount: String(Math.max(0, outstandingTotal)),
      reason: '',
    });
    setEditingOutstanding(true);
  };

  const saveOutstanding = async () => {
    if (outstandingEditableReqs.length === 0) return;
    const remaining = Number(outstandingEdit.amount);
    const reason = outstandingEdit.reason.trim();
    if (!Number.isFinite(remaining) || remaining < 0) { toast.error('Enter a valid outstanding amount'); return; }
    if (reason.length < 10) { toast.error('Reason must be at least 10 characters'); return; }

    // Build per-request shares of the new total `remaining`.
    // Distribute proportionally to each editable req's current outstanding.
    // If all current outstandings are 0, split evenly. Each share must fit
    // inside its request's obligation (0 <= share <= obligation).
    const reqInfos = outstandingEditableReqs.map(r => {
      const repaid = Number(r.amount_repaid || 0);
      const obligation = obligationFor(r);
      const currentOutstanding = Math.max(0, obligation - repaid);
      return { req: r, repaid, obligation, currentOutstanding };
    });
    const sumCurrent = reqInfos.reduce((s, x) => s + x.currentOutstanding, 0);
    const sumObligation = reqInfos.reduce((s, x) => s + x.obligation, 0);
    if (remaining > sumObligation) {
      toast.error(`Outstanding cannot exceed total obligation (UGX ${sumObligation.toLocaleString()})`);
      return;
    }

    let shares: number[];
    if (sumCurrent > 0) {
      shares = reqInfos.map(x => Math.round((x.currentOutstanding / sumCurrent) * remaining));
    } else {
      const each = Math.round(remaining / reqInfos.length);
      shares = reqInfos.map(() => each);
    }
    // Fix rounding drift on the last share
    const drift = remaining - shares.reduce((s, n) => s + n, 0);
    if (shares.length > 0) shares[shares.length - 1] += drift;

    // Clamp shares to [0, obligation] and redistribute overflow so the
    // total still matches `remaining` exactly.
    for (let i = 0; i < reqInfos.length; i++) {
      if (shares[i] < 0) shares[i] = 0;
      if (shares[i] > reqInfos[i].obligation) shares[i] = reqInfos[i].obligation;
    }
    const clampedDrift = remaining - shares.reduce((s, n) => s + n, 0);
    if (clampedDrift !== 0 && shares.length > 0) {
      // Push drift onto the first request that still has headroom.
      for (let i = 0; i < reqInfos.length; i++) {
        const room = reqInfos[i].obligation - shares[i];
        if (clampedDrift > 0 && room > 0) {
          const add = Math.min(clampedDrift, room);
          shares[i] += add;
          break;
        }
        if (clampedDrift < 0 && shares[i] > 0) {
          const sub = Math.min(-clampedDrift, shares[i]);
          shares[i] -= sub;
          break;
        }
      }
    }

    setSavingOutstanding(true);
    try {
      const confirmedUpdates: Record<string, Record<string, number>> = {};
      for (let i = 0; i < reqInfos.length; i++) {
        const { req, obligation } = reqInfos[i];
        // Keep obligation fixed; adjust amount_repaid so that
        //   new_outstanding = obligation - new_repaid = shares[i]
        // This way the Total Repaid card visibly reflects the correction.
        const newRepaid = Math.max(0, Math.min(obligation, obligation - shares[i]));

        const after: Record<string, number> = { amount_repaid: newRepaid };

        const persistedAfter = await correctRentRequest(req.id, reason, after);
        confirmedUpdates[req.id] = persistedAfter;
        applyConfirmedRequestUpdates({ [req.id]: persistedAfter });
      }

      // Keep the corrected rows in the visible detail cache immediately so the
      // Total Repaid card recomputes from the new amount_repaid values without
      // being overwritten by a stale refetch.
      applyConfirmedRequestUpdates(confirmedUpdates);
      queryClient.invalidateQueries({ queryKey: ['exec-tenant-ops'] });
      queryClient.invalidateQueries({ queryKey: ['coo-tenant-balances'] });
      toast.success(
        reqInfos.length === 1
          ? `Outstanding updated`
          : `Outstanding distributed across ${reqInfos.length} active rent requests`
      );
      setEditingOutstanding(false);
    } catch (e: any) {
      toast.error(e.message || 'Failed to save');
    } finally {
      setSavingOutstanding(false);
    }
  };

  // --- Profile edit handlers ---
  const startEditProfile = () => {
    setProfileEdit({
      full_name: profile?.full_name || '',
      phone: profile?.phone || '',
      city: profile?.city || '',
    });
    setIsEditingProfile(true);
  };

  const cancelEditProfile = () => {
    setIsEditingProfile(false);
  };

  const saveProfile = async () => {
    if (!profileEdit.full_name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSavingProfile(true);
    try {
      const changes: Record<string, { from: string; to: string }> = {};
      if (profileEdit.full_name !== (profile?.full_name || '')) changes.full_name = { from: profile?.full_name || '', to: profileEdit.full_name };
      if (profileEdit.phone !== (profile?.phone || '')) changes.phone = { from: profile?.phone || '', to: profileEdit.phone };
      if (profileEdit.city !== (profile?.city || '')) changes.city = { from: profile?.city || '', to: profileEdit.city };

      if (Object.keys(changes).length === 0) {
        setIsEditingProfile(false);
        return;
      }

      const { error } = await supabase.from('profiles').update({
        full_name: profileEdit.full_name.trim(),
        phone: profileEdit.phone.trim(),
        city: profileEdit.city.trim() || null,
      }).eq('id', tenantId);

      if (error) throw error;

      await supabase.from('audit_logs').insert({
        action_type: 'tenant_profile_edit',
        user_id: user?.id || null,
        record_id: tenantId,
        table_name: 'profiles',
        metadata: { changes },
      });

      queryClient.invalidateQueries({ queryKey: ['tenant-detail', tenantId] });
      toast.success('Profile updated');
      setIsEditingProfile(false);
    } catch (e: any) {
      toast.error(e.message || 'Failed to save');
    } finally {
      setSavingProfile(false);
    }
  };

  // --- Request edit handlers ---
  const startEditRequest = (req: typeof requests[0]) => {
    const currentOutstanding = Math.max(0, obligationFor(req) - Number(req.amount_repaid || 0));
    setRequestEdit({
      rent_amount: String(req.rent_amount || 0),
      duration_days: String(req.duration_days || 0),
      access_fee: String((req as any).access_fee ?? ''),
      request_fee: String((req as any).request_fee ?? ''),
      outstanding: String(currentOutstanding),
      reason: '',
    });
    setOutstandingTouched(false);
    setEditingRequestId(req.id);
  };

  const cancelEditRequest = () => {
    setEditingRequestId(null);
  };

  const saveRequest = async (reqId: string) => {
    const amount = Number(requestEdit.rent_amount);
    const days = Number(requestEdit.duration_days);
    const reason = requestEdit.reason.trim();
    if (!amount || amount <= 0) { toast.error('Rent amount must be positive'); return; }
    if (!days || days <= 0) { toast.error('Duration days must be positive'); return; }
    if (reason.length < 10) { toast.error('Reason must be at least 10 characters'); return; }

    setSavingRequest(true);
    try {
      const originalReq = requests.find(r => r.id === reqId);
      if (!originalReq) throw new Error('Request not found');

      // Recompute fees from rent_amount + duration_days using the canonical engine,
      // but let a manager override Access Fee / Request Fee inline for corrections.
      const canonical = calculateRentRepayment(amount, days);
      const accessOverrideRaw = requestEdit.access_fee.trim();
      const requestOverrideRaw = requestEdit.request_fee.trim();
      const accessFee = accessOverrideRaw === '' ? canonical.accessFee : Number(accessOverrideRaw);
      const requestFee = requestOverrideRaw === '' ? canonical.requestFee : Number(requestOverrideRaw);
      if (!Number.isFinite(accessFee) || accessFee < 0) { toast.error('Access fee must be zero or positive'); setSavingRequest(false); return; }
      if (!Number.isFinite(requestFee) || requestFee < 0) { toast.error('Request fee must be zero or positive'); setSavingRequest(false); return; }
      const totalRepayment = Math.round(amount + accessFee + requestFee);
      const dailyRepayment = Math.ceil(totalRepayment / days);
      const calc = { accessFee, requestFee, totalRepayment, dailyRepayment };
      const currentRepaid = Math.max(0, Number(originalReq.amount_repaid || 0));
      let newRepaid: number;
      if (outstandingTouched) {
        const desiredOutstanding = Number(requestEdit.outstanding);
        if (!Number.isFinite(desiredOutstanding) || desiredOutstanding < 0) { toast.error('Outstanding must be zero or positive'); setSavingRequest(false); return; }
        if (desiredOutstanding > calc.totalRepayment) {
          toast.error(`Outstanding cannot exceed total repayment (UGX ${calc.totalRepayment.toLocaleString()})`);
          setSavingRequest(false);
          return;
        }
        newRepaid = Math.max(0, calc.totalRepayment - desiredOutstanding);
      } else {
        // Untouched: keep what the tenant has genuinely repaid, capped at the new total.
        newRepaid = Math.min(currentRepaid, calc.totalRepayment);
      }
      newRepaid = Math.min(Math.max(0, newRepaid), calc.totalRepayment);

      const after = {
        rent_amount: amount,
        duration_days: days,
        access_fee: calc.accessFee,
        request_fee: calc.requestFee,
        total_repayment: calc.totalRepayment,
        daily_repayment: calc.dailyRepayment,
        amount_repaid: newRepaid,
      };

      const persistedAfter = await correctRentRequest(reqId, reason, after);
      applyConfirmedRequestUpdates({ [reqId]: persistedAfter });

      // Sync the active subscription charge (cron). Compute new end_date from created_at + new duration.
      const startDate = new Date(originalReq.created_at);
      const newEnd = new Date(startDate);
      newEnd.setDate(newEnd.getDate() + days);
      const { error: subErr } = await supabase
        .from('subscription_charges')
        .update({ charge_amount: calc.dailyRepayment, end_date: newEnd.toISOString().slice(0, 10) })
        .eq('rent_request_id', reqId)
        .in('status', ['active', 'pending']);
      if (subErr) console.warn('Subscription charge sync warning:', subErr);

      applyConfirmedRequestUpdates({ [reqId]: persistedAfter });
      queryClient.invalidateQueries({ queryKey: ['exec-tenant-ops'] });
      queryClient.invalidateQueries({ queryKey: ['coo-tenant-balances'] });
      queryClient.invalidateQueries({ predicate: (q) => Array.isArray(q.queryKey) && typeof q.queryKey[0] === 'string' && (q.queryKey[0] as string).startsWith('cfo-') });
      toast.success(`Rent corrected — daily charge updated to UGX ${calc.dailyRepayment.toLocaleString()}`);
      setEditingRequestId(null);
    } catch (e: any) {
      toast.error(e.message || 'Failed to save');
    } finally {
      setSavingRequest(false);
    }
  };

  // --- Rent collection handler ---
  // Collects the outstanding (capped at the daily charge) from the tenant's
  // wallet, then from the linked agent's wallet for any shortfall.
  const collectMutation = useMutation({
    mutationFn: async ({ rentRequestId, reason, amount }: { rentRequestId: string; reason: string; amount?: number }) => {
      const { data, error } = await supabase.functions.invoke('manual-collect-rent', {
        body: { rent_request_id: rentRequestId, reason, ...(amount != null ? { amount } : {}) },
      });
      if (error) {
        const msg = await extractFromErrorObject(error, 'Collection failed. Please try again.');
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data: any, variables: { rentRequestId: string; reason: string; amount?: number }) => {
      toast.success(
        `Collected UGX ${Number(data.total_collected).toLocaleString()} — tenant UGX ${Number(data.tenant_deducted).toLocaleString()}, agent UGX ${Number(data.agent_deducted).toLocaleString()}`
      );
      // Build a downloadable receipt from the server-confirmed result.
      const req = requests.find(r => r.id === variables.rentRequestId);
      const outstanding = req ? Math.max(0, obligationFor(req) - Number(req.amount_repaid || 0)) : undefined;
      const totalCollected = Number(data.total_collected) || 0;
      const requestedAmount = Number(data.requested_amount) || (variables.amount ?? totalCollected);
      // Compute remaining on the SAME obligation basis the ledger validator uses
      // (obligationFor → rent_amount / total_repayment), so a partial receipt
      // reconciles cleanly. Server value is only a fallback.
      const remainingBalance = outstanding !== undefined
        ? Math.max(0, outstanding - totalCollected)
        : (typeof data.remaining_balance === 'number' ? Math.max(0, Number(data.remaining_balance)) : undefined);
      const isPartial = Boolean(data.is_partial) || (remainingBalance !== undefined && remainingBalance > 0) || totalCollected < requestedAmount;
      setLastReceipt({
        reference: variables.rentRequestId,
        tenantName: data.tenant_name || profile?.full_name || tenantName,
        tenantPhone: profile?.phone || undefined,
        agentName: req?.agent_name && req.agent_name !== 'Not Assigned' ? req.agent_name : undefined,
        totalCollected,
        tenantDeducted: Number(data.tenant_deducted) || 0,
        agentDeducted: Number(data.agent_deducted) || 0,
        commissionPaid: Number(data.commission_paid) || 0,
        remainingBalance,
        requestedAmount,
        isPartial,
        reason: variables.reason,
        collectedBy: user?.email || undefined,
        date: new Date(),
        currency: 'UGX',
      });
      // Reset any prior validation — the new receipt must be reconciled fresh.
      setValidation(null);
      setValidationOverride(false);
      setCollectingReqId(null);
      setCollectReason('');
      setCollectAmount('');
      queryClient.invalidateQueries({ queryKey: ['tenant-detail', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['exec-tenant-ops'] });
      queryClient.invalidateQueries({ queryKey: ['coo-tenant-balances'] });
    },
    onError: (e: any) => toast.error(e.message || 'Collection failed'),
  });

  // Reconcile the receipt against the posted collection ledger. Checks that the
  // tenant/agent UGX deductions, total collected, 10% commission, and remaining
  // balance on the receipt match the double-entry ledger before download.
  const validateReceiptAgainstLedger = async (): Promise<{ ok: boolean; issues: string[] }> => {
    const r = lastReceipt;
    if (!r) return { ok: false, issues: ['No receipt to validate.'] };
    const issues: string[] = [];
    const TOL = 1; // allow ≤1 UGX rounding difference
    const near = (a: number, b: number) => Math.abs(Math.round(a) - Math.round(b)) <= TOL;
    const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;

    // Fresh rent request — never trust the cache for high-stakes reconciliation.
    const { data: rr, error: rrErr } = await supabase
      .from('rent_requests')
      .select('total_repayment, amount_repaid, rent_amount, registration_type, agent_id, assigned_agent_id, tenant_id')
      .eq('id', r.reference)
      .single();
    if (rrErr || !rr) return { ok: false, issues: ['Could not load the rent request to reconcile.'] };

    const agentId = (rr.assigned_agent_id || rr.agent_id) as string | null;
    const since = new Date(r.date.getTime() - 15 * 60 * 1000).toISOString();
    const { data: legs, error: legErr } = await supabase
      .from('general_ledger')
      .select('user_id, category, direction, amount, currency, created_at')
      .eq('source_id', r.reference)
      .eq('ledger_scope', 'wallet')
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    if (legErr) return { ok: false, issues: ['Could not load the collection ledger to reconcile.'] };

    const rows = legs || [];
    if (rows.length === 0) {
      return { ok: false, issues: ['No matching collection ledger entries were found for this receipt.'] };
    }

    // Currency must be UGX on every leg.
    const badCurrency = rows.find((l: any) => (l.currency || 'UGX') !== 'UGX');
    if (badCurrency) issues.push(`Ledger contains a non-UGX entry (${badCurrency.currency}).`);

    const sum = (pred: (l: any) => boolean) =>
      rows.filter(pred).reduce((s: number, l: any) => s + Number(l.amount || 0), 0);

    const tenantLedger = sum((l) => l.category === 'tenant_repayment' && l.direction === 'cash_out' && l.user_id === rr.tenant_id);
    const agentLedger = agentId
      ? sum((l) => l.category === 'tenant_repayment' && l.direction === 'cash_out' && l.user_id === agentId)
      : 0;
    const commissionLedger = sum((l) => l.category === 'agent_commission_earned' && l.direction === 'cash_in');
    const totalLedger = tenantLedger + agentLedger;

    if (!near(tenantLedger, r.tenantDeducted))
      issues.push(`Tenant deduction mismatch — receipt ${ugx(r.tenantDeducted)} vs ledger ${ugx(tenantLedger)}.`);
    if (!near(agentLedger, r.agentDeducted))
      issues.push(`Agent deduction mismatch — receipt ${ugx(r.agentDeducted)} vs ledger ${ugx(agentLedger)}.`);
    if (!near(totalLedger, r.totalCollected))
      issues.push(`Total collected mismatch — receipt ${ugx(r.totalCollected)} vs ledger ${ugx(totalLedger)}.`);
    if (typeof r.commissionPaid === 'number' && !near(commissionLedger, r.commissionPaid))
      issues.push(`Commission mismatch — receipt ${ugx(r.commissionPaid)} vs ledger ${ugx(commissionLedger)}.`);

    // Remaining balance: fresh obligation minus fresh repaid.
    const obligation = rr.registration_type === 'outstanding_balance'
      ? Number(rr.total_repayment || 0)
      : Number(rr.rent_amount || 0);
    const ledgerRemaining = Math.max(0, obligation - Number(rr.amount_repaid || 0));
    if (typeof r.remainingBalance === 'number' && !near(ledgerRemaining, r.remainingBalance))
      issues.push(`Remaining balance mismatch — receipt ${ugx(r.remainingBalance)} vs ledger ${ugx(ledgerRemaining)}.`);

    return { ok: issues.length === 0, issues };
  };

  const handleValidateReceipt = async () => {
    if (!lastReceipt) return;
    setValidating(true);
    try {
      const result = await validateReceiptAgainstLedger();
      setValidation(result);
      if (result.ok) toast.success('Receipt reconciled with the collection ledger');
      else toast.error('Receipt does not match the ledger — review before downloading');
    } catch (e: any) {
      setValidation({ ok: false, issues: [e?.message || 'Validation failed'] });
      toast.error('Could not validate the receipt');
    } finally {
      setValidating(false);
    }
  };

  const handleDownloadReceipt = async (fmt: 'pdf' | 'xlsx') => {
    if (!lastReceipt) return;
    // Gate download on a successful ledger reconciliation (or explicit override).
    if (!(validation?.ok || validationOverride)) {
      toast.error('Verify the receipt against the ledger before downloading');
      return;
    }
    setDownloadingReceipt(fmt);
    try {
      if (fmt === 'pdf') await downloadRentCollectionReceiptPdf(lastReceipt);
      else await downloadRentCollectionReceiptXlsx(lastReceipt);
    } catch (e: any) {
      toast.error(e?.message || 'Could not generate receipt');
    } finally {
      setDownloadingReceipt(null);
    }
  };

  const handleCollect = (rentRequestId: string, maxAmount: number) => {
    const reason = collectReason.trim();
    if (reason.length < 10) { toast.error('Reason must be at least 10 characters'); return; }
    let amount: number | undefined;
    const raw = collectAmount.trim();
    if (raw !== '') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) { toast.error('Enter a valid collection amount'); return; }
      if (parsed > maxAmount) { toast.error(`Amount cannot exceed the outstanding UGX ${maxAmount.toLocaleString()}`); return; }
      amount = Math.round(parsed);
    }
    collectMutation.mutate({ rentRequestId, reason, amount });
  };

  return (
    <div className="space-y-3">
      <Button variant="ghost" onClick={onBack} className="h-10 px-3 gap-2 text-sm font-semibold -ml-1">
        <ArrowLeft className="h-4 w-4" /> Back · {tenantName}
      </Button>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-24 bg-muted animate-pulse rounded-xl" />)}
        </div>
      ) : (
        <>
          {/* Profile card */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="h-6 w-6 text-primary" />
                </div>
                <div className="flex-1">
                  {isEditingProfile ? (
                    <div className="space-y-2">
                      <Input placeholder="Full name" value={profileEdit.full_name} onChange={e => setProfileEdit(v => ({ ...v, full_name: e.target.value }))} className="h-8 text-sm" />
                      <Input placeholder="Phone" value={profileEdit.phone} onChange={e => setProfileEdit(v => ({ ...v, phone: e.target.value }))} className="h-8 text-sm" />
                      <Input placeholder="City" value={profileEdit.city} onChange={e => setProfileEdit(v => ({ ...v, city: e.target.value }))} className="h-8 text-sm" />
                    </div>
                  ) : (
                    <>
                      <p className="font-bold text-foreground">{profile?.full_name || tenantName}</p>
                      <p className="text-sm text-muted-foreground">{profile?.phone || '—'}</p>
                      {profile?.city && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <MapPin className="h-3 w-3" />{profile.city}
                        </p>
                      )}
                    </>
                  )}
                </div>
                <div className="flex gap-1.5">
                  {isEditingProfile ? (
                    <>
                      <Button variant="outline" size="icon" className="h-9 w-9" onClick={cancelEditProfile} disabled={savingProfile}>
                        <X className="h-4 w-4" />
                      </Button>
                      <Button size="icon" className="h-9 w-9" onClick={saveProfile} disabled={savingProfile}>
                        {savingProfile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="ghost" size="icon" className="h-9 w-9" onClick={startEditProfile}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {profile?.phone && (
                        <>
                          <Button variant="outline" size="icon" className="h-9 w-9" asChild>
                            <a href={`tel:${profile.phone}`}><Phone className="h-4 w-4" /></a>
                          </Button>
                          <Button variant="outline" size="icon" className="h-9 w-9" asChild>
                            <a href={`https://wa.me/${profile.phone.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer">
                              <MessageCircle className="h-4 w-4" />
                            </a>
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
              {onViewRegistration && !isEditingProfile && (
                <Button variant="soft" size="sm" className="mt-2 w-full gap-1.5 text-xs" onClick={onViewRegistration}>
                  <FileSearch className="h-3.5 w-3.5" /> View Registration Info
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Call-Centre Smartphone Panel */}
          <CallCentreSmartphonePanel
            tenantId={tenantId}
            smartphoneStatus={(profile as { smartphone_status?: string | null } | null)?.smartphone_status}
            smartphoneSource={(profile as { smartphone_source?: string | null } | null)?.smartphone_source}
            onRefetch={() => queryClient.invalidateQueries({ queryKey: ['tenant-detail', tenantId] })}
          />

          {/* Summary KPIs */}
          <div className="grid grid-cols-3 gap-2">
            <Card><CardContent className="p-3 text-center">
              <p className="text-lg font-extrabold text-foreground">{requests.length}</p>
              <p className="text-[10px] text-muted-foreground">Requests</p>
            </CardContent></Card>
            <Card><CardContent className="p-3 text-center">
              {editingRepaid ? (
                <div className="space-y-1.5 text-left">
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={repaidEdit.amount}
                    onChange={e => setRepaidEdit(v => ({ ...v, amount: e.target.value }))}
                    placeholder="Total Repaid (UGX)"
                    className="h-8 text-sm"
                  />
                  <Textarea
                    value={repaidEdit.reason}
                    onChange={e => setRepaidEdit(v => ({ ...v, reason: e.target.value }))}
                    placeholder="Reason (min 10 chars)"
                    className="text-[11px] min-h-[44px]"
                  />
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditingRepaid(false)} disabled={savingRepaid}>
                      <X className="h-3 w-3" />
                    </Button>
                    <Button size="sm" className="h-7 px-2 text-xs gap-1" onClick={saveRepaid} disabled={savingRepaid}>
                      {savingRepaid ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-center gap-1">
                    <p
                      className={cn(
                        'text-lg font-extrabold text-emerald-600',
                        requests.length > 0 && 'cursor-pointer border-b border-dotted border-emerald-600/50 hover:opacity-80',
                      )}
                      onClick={requests.length > 0 ? startEditRepaid : undefined}
                      title={requests.length > 0 ? 'Tap to correct Total Repaid' : undefined}
                    >
                      UGX {totalRepaid.toLocaleString()}
                    </p>
                    {requests.length > 0 && (
                      <button
                        type="button"
                        onClick={startEditRepaid}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label="Edit total repaid"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground">Total Repaid</p>
                </>
              )}
            </CardContent></Card>
            <Card><CardContent className="p-3 text-center">
              {editingOutstanding && editableOutstandingReq ? (
                <div className="space-y-1.5 text-left">
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={outstandingEdit.amount}
                    onChange={e => setOutstandingEdit(v => ({ ...v, amount: e.target.value }))}
                    placeholder="Remaining (UGX)"
                    className="h-8 text-sm"
                  />
                  <Textarea
                    value={outstandingEdit.reason}
                    onChange={e => setOutstandingEdit(v => ({ ...v, reason: e.target.value }))}
                    placeholder="Reason (min 10 chars)"
                    className="text-[11px] min-h-[44px]"
                  />
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditingOutstanding(false)} disabled={savingOutstanding}>
                      <X className="h-3 w-3" />
                    </Button>
                    <Button size="sm" className="h-7 px-2 text-xs gap-1" onClick={saveOutstanding} disabled={savingOutstanding}>
                      {savingOutstanding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-center gap-1">
                     <p
                       className={cn(
                         "text-lg font-extrabold text-amber-600",
                         outstandingEditableReqs.length > 0 && "cursor-pointer border-b border-dotted border-amber-600/50 hover:opacity-80"
                       )}
                       onClick={outstandingEditableReqs.length > 0 ? startEditOutstanding : undefined}
                       title={
                         outstandingEditableReqs.length === 0
                           ? undefined
                           : outstandingEditableReqs.length === 1
                             ? "Tap to edit outstanding"
                             : `Tap to edit — change is split across ${outstandingEditableReqs.length} rent requests`
                       }
                     >
                      UGX {outstandingTotal.toLocaleString()}
                    </p>
                    {outstandingEditableReqs.length > 0 && (
                      <button
                        type="button"
                        onClick={startEditOutstanding}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label="Edit outstanding"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Outstanding{liveReqs.length > 0 ? ` · ${liveReqs.length} active plan${liveReqs.length > 1 ? 's' : ''}` : ' · no active plan'}
                  </p>
                </>
              )}
            </CardContent></Card>
          </div>

          {/* Rent requests */}
          <Card id="rent-requests-list">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Rent Requests</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {requests.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground text-center">No requests</p>
              ) : (
                <div className="divide-y divide-border">
                  {requests.map((req) => {
                    const isEditing = editingRequestId === req.id;
                    const rawStatus = String(req.status || '').toLowerCase();
                    const outstandingLeft = Number((req as any).total_repayment || 0) - Number(req.amount_repaid || 0);
                    const terminalStatuses = ['cancelled', 'rejected', 'closed', 'defaulted'];
                    const displayStatus =
                      (rawStatus === 'completed' || rawStatus === 'fully_repaid') && outstandingLeft > 0
                        ? 'active'
                        : rawStatus;
                    return (
                      <div key={req.id} className="px-4 py-3 space-y-1">
                        <div className="flex items-center justify-between">
                          <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', statusColor(displayStatus))}>
                            {displayStatus.replace(/_/g, ' ')}
                          </Badge>
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(req.created_at), 'dd MMM yyyy')}
                            </span>
                            {!isEditing && (
                              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => startEditRequest(req)}>
                                <Pencil className="h-3 w-3" />
                              </Button>
                            )}
                            {!isEditing && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 px-2 text-[10px] gap-1"
                                onClick={() => setTransferReq({ id: req.id, agent_id: (req.assigned_agent_id || req.agent_id) ?? null })}
                                title="Transfer to another agent"
                              >
                                <ArrowRightLeft className="h-3 w-3" />
                                Transfer
                              </Button>
                            )}
                            {!isEditing && (
                              <PaymentPeriodControl
                                rentRequestId={req.id}
                                frequency={(req as any).repayment_frequency ?? null}
                                dailyRepayment={Number(req.daily_repayment ?? 0)}
                                canEdit
                                triggerClassName="h-6 px-2 text-[10px] gap-1 w-auto"
                                compact
                                onSaved={() => {
                                  queryClient.invalidateQueries({ queryKey: ['tenant-detail', tenantId] });
                                  queryClient.invalidateQueries({ queryKey: ['agent-monitoring'] });
                                  queryClient.invalidateQueries({ queryKey: ['ops-tenants'] });
                                }}
                              />
                            )}
                            {!isEditing && (
                              <RepaymentPauseControl
                                rentRequestId={req.id}
                                registrationType={(req as any).registration_type}
                                outstandingAmount={outstandingLeft}
                                planStatus={rawStatus}
                              />
                            )}
                          </div>
                        </div>

                        {isEditing ? (
                          (() => {
                            const newAmount = Number(requestEdit.rent_amount) || 0;
                            const newDays = Number(requestEdit.duration_days) || 0;
                            const canPreview = newAmount > 0 && newDays > 0;
                            const canonical = canPreview ? calculateRentRepayment(newAmount, newDays) : null;
                            const accessRaw = requestEdit.access_fee.trim();
                            const requestRaw = requestEdit.request_fee.trim();
                            const accessOverride = accessRaw === '' ? null : Number(accessRaw);
                            const requestOverride = requestRaw === '' ? null : Number(requestRaw);
                            const accessFee = accessOverride != null && Number.isFinite(accessOverride) && accessOverride >= 0
                              ? accessOverride
                              : canonical?.accessFee ?? 0;
                            const requestFee = requestOverride != null && Number.isFinite(requestOverride) && requestOverride >= 0
                              ? requestOverride
                              : canonical?.requestFee ?? 0;
                            const totalRepayment = canPreview ? Math.round(newAmount + accessFee + requestFee) : 0;
                            const dailyRepayment = canPreview ? Math.ceil(totalRepayment / newDays) : 0;
                            const preview = canPreview ? { accessFee, requestFee, totalRepayment, dailyRepayment } : null;
                            const requestedOutstanding = Number(requestEdit.outstanding);
                            const outstandingValue = Number.isFinite(requestedOutstanding) && requestedOutstanding >= 0 ? requestedOutstanding : 0;
                            const newRepaid = preview ? Math.max(0, preview.totalRepayment - outstandingValue) : 0;
                            const reasonOk = requestEdit.reason.trim().length >= 10;
                            const outstandingOk = preview ? Number.isFinite(requestedOutstanding) && requestedOutstanding >= 0 && requestedOutstanding <= preview.totalRepayment : false;
                            const feesValid =
                              (accessOverride == null || (Number.isFinite(accessOverride) && accessOverride >= 0)) &&
                              (requestOverride == null || (Number.isFinite(requestOverride) && requestOverride >= 0));
                            const canSave = canPreview && reasonOk && outstandingOk && feesValid;
                            return (
                              <div className="space-y-2 pt-1">
                                <div className="grid grid-cols-2 gap-2">
                                  <div>
                                    <label className="text-[10px] text-muted-foreground">Rent Amount (UGX)</label>
                                    <Input type="number" value={requestEdit.rent_amount} onChange={e => setRequestEdit(v => ({ ...v, rent_amount: e.target.value }))} className="h-8 text-sm" />
                                  </div>
                                  <div>
                                    <label className="text-[10px] text-muted-foreground">Duration (days)</label>
                                    <Input type="number" value={requestEdit.duration_days} onChange={e => setRequestEdit(v => ({ ...v, duration_days: e.target.value }))} className="h-8 text-sm" />
                                  </div>
                                  <div>
                                    <label className="text-[10px] text-muted-foreground">
                                      Access Fee (UGX) <span className="text-[9px] opacity-70">— blank = auto</span>
                                    </label>
                                    <Input
                                      type="number"
                                      value={requestEdit.access_fee}
                                      onChange={e => setRequestEdit(v => ({ ...v, access_fee: e.target.value }))}
                                      placeholder={canonical ? String(canonical.accessFee) : 'auto'}
                                      className="h-8 text-sm"
                                    />
                                  </div>
                                  <div>
                                    <label className="text-[10px] text-muted-foreground">
                                      Request Fee (UGX) <span className="text-[9px] opacity-70">— blank = auto</span>
                                    </label>
                                    <Input
                                      type="number"
                                      value={requestEdit.request_fee}
                                      onChange={e => setRequestEdit(v => ({ ...v, request_fee: e.target.value }))}
                                      placeholder={canonical ? String(canonical.requestFee) : 'auto'}
                                      className="h-8 text-sm"
                                    />
                                  </div>
                                  <div className="col-span-2">
                                    <label className="text-[10px] text-muted-foreground">Outstanding (UGX)</label>
                                    <Input
                                      type="number"
                                      value={requestEdit.outstanding}
                                      onChange={e => { setOutstandingTouched(true); setRequestEdit(v => ({ ...v, outstanding: e.target.value })); }}
                                      className="h-8 text-sm"
                                    />
                                  </div>
                                </div>
                                {preview && (
                                  <div className="rounded-md bg-muted/50 p-2 text-[11px] space-y-0.5">
                                    <div className="flex justify-between"><span className="text-muted-foreground">Access Fee</span><span>UGX {preview.accessFee.toLocaleString()}</span></div>
                                    <div className="flex justify-between"><span className="text-muted-foreground">Request Fee</span><span>UGX {preview.requestFee.toLocaleString()}</span></div>
                                    <div className="flex justify-between font-semibold"><span>New Total Repayment</span><span>UGX {preview.totalRepayment.toLocaleString()}</span></div>
                                    <div className="flex justify-between"><span className="text-muted-foreground">New Daily</span><span>UGX {preview.dailyRepayment.toLocaleString()}</span></div>
                                    <div className="flex justify-between text-emerald-700 font-semibold"><span>New Total Repaid</span><span>UGX {newRepaid.toLocaleString()}</span></div>
                                    <div className={cn('flex justify-between font-semibold pt-1 border-t border-border/40', !outstandingOk && 'text-destructive')}>
                                      <span>New Outstanding</span>
                                      <span>UGX {outstandingValue.toLocaleString()}</span>
                                    </div>
                                    {!outstandingOk && (
                                      <p className="text-destructive text-[10px]">Outstanding must be between UGX 0 and UGX {preview.totalRepayment.toLocaleString()}.</p>
                                    )}
                                  </div>
                                )}
                                <div>
                                  <label className="text-[10px] text-muted-foreground">Reason for correction (min 10 chars)</label>
                                  <Textarea
                                    value={requestEdit.reason}
                                    onChange={e => setRequestEdit(v => ({ ...v, reason: e.target.value }))}
                                    rows={2}
                                    className="text-sm"
                                    placeholder="Explain why this rent is being corrected…"
                                  />
                                </div>
                                <div className="flex gap-2 justify-end">
                                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={cancelEditRequest} disabled={savingRequest}>
                                    Cancel
                                  </Button>
                                  <Button size="sm" className="h-7 text-xs gap-1" onClick={() => saveRequest(req.id)} disabled={savingRequest || !canSave}>
                                    {savingRequest ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                                    Save
                                  </Button>
                                </div>
                              </div>
                            );
                          })()
                        ) : (
                          <>
                            <div className="flex items-center justify-between text-sm">
                              <span className="font-semibold">UGX {obligationFor(req).toLocaleString()}</span>
                              <span className="text-muted-foreground">
                                Repaid: UGX {Number(req.amount_repaid || 0).toLocaleString()}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                              <span className="font-medium text-foreground/80">
                                Agent: <span className="font-normal text-muted-foreground">{req.agent_name}</span>
                              </span>
                              <span>Landlord: {req.landlord_name}</span>
                              {req.daily_repayment && (
                                String((req as any).repayment_frequency ?? 'daily').toLowerCase() === 'weekly' ? (
                                  <span>Weekly: UGX {(Number(req.daily_repayment) * 7).toLocaleString()}</span>
                                ) : (
                                  <span>Daily: UGX {Number(req.daily_repayment).toLocaleString()}</span>
                                )
                              )}
                              {req.duration_days && <span>{req.duration_days}d</span>}
                            </div>
                            {(() => {
                              const status = String((req as any).status || '').toLowerCase();
                              const isActive = !['completed', 'closed', 'cancelled', 'rejected', 'fully_repaid'].includes(status);
                              const reqOutstanding = Number((req as any).total_repayment || 0) - Number(req.amount_repaid || 0);
                              if (!isActive || reqOutstanding <= 0) return null;
                              const chargeAmt = Math.min(reqOutstanding, Number(req.daily_repayment || 0) || reqOutstanding);
                              const isOpen = collectingReqId === req.id;
                              const partialEntered = collectAmount.trim() !== '' && Number(collectAmount) > 0;
                              const plannedAmt = partialEntered
                                ? Math.min(Math.round(Number(collectAmount)), reqOutstanding)
                                : chargeAmt;
                              return (
                                <div className="pt-1">
                                  {!isOpen ? (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-8 w-full text-xs gap-1.5 border-primary/30 text-primary hover:bg-primary/10"
                                      onClick={() => { setCollectingReqId(req.id); setCollectReason(''); setCollectAmount(''); }}
                                    >
                                      <Banknote className="h-3.5 w-3.5" />
                                      Collect UGX {chargeAmt.toLocaleString()} from wallet
                                    </Button>
                                  ) : (
                                    <div className="space-y-2 rounded-md border border-primary/20 bg-primary/5 p-2">
                                      <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                                        <Wallet className="h-3 w-3" />
                                        Charges the tenant's wallet first, then the linked agent's wallet for any shortfall.
                                      </p>
                                      <div>
                                        <label className="text-[10px] text-muted-foreground">
                                          Amount to collect (UGX) — leave blank for daily UGX {chargeAmt.toLocaleString()}
                                        </label>
                                        <Input
                                          type="number"
                                          inputMode="numeric"
                                          value={collectAmount}
                                          onChange={e => setCollectAmount(e.target.value)}
                                          placeholder={`Partial amount (max ${reqOutstanding.toLocaleString()})`}
                                          className="h-8 text-sm"
                                          min={1}
                                          max={reqOutstanding}
                                        />
                                        {partialEntered && plannedAmt < reqOutstanding && (
                                          <p className="text-[10px] text-amber-600 mt-0.5">
                                            Partial — UGX {(reqOutstanding - plannedAmt).toLocaleString()} will remain outstanding.
                                          </p>
                                        )}
                                      </div>
                                      <Textarea
                                        value={collectReason}
                                        onChange={e => setCollectReason(e.target.value)}
                                        rows={2}
                                        className="text-sm"
                                        placeholder="Reason for collection (min 10 chars)…"
                                        maxLength={500}
                                      />
                                      <div className="flex gap-2 justify-end">
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="h-7 text-xs"
                                          onClick={() => { setCollectingReqId(null); setCollectReason(''); setCollectAmount(''); }}
                                          disabled={collectMutation.isPending}
                                        >
                                          Cancel
                                        </Button>
                                        <Button
                                          size="sm"
                                          className="h-7 text-xs gap-1"
                                          onClick={() => handleCollect(req.id, reqOutstanding)}
                                          disabled={collectMutation.isPending || collectReason.trim().length < 10}
                                        >
                                          {collectMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Banknote className="h-3 w-3" />}
                                          Collect UGX {plannedAmt.toLocaleString()}
                                        </Button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                            {lastReceipt?.reference === req.id && (
                              <div className="mt-1 space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-2">
                                <p className="text-[11px] font-medium text-emerald-800">
                                  {lastReceipt.isPartial ? 'Partial — c' : 'C'}ollected UGX {Math.round(lastReceipt.totalCollected).toLocaleString()}
                                  {lastReceipt.isPartial && typeof lastReceipt.remainingBalance === 'number'
                                    ? ` · UGX ${Math.round(lastReceipt.remainingBalance).toLocaleString()} remaining`
                                    : ''} · download receipt
                                </p>

                                {/* Step 1 — reconcile against the collection ledger */}
                                {!validation?.ok && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 w-full text-xs gap-1.5 border-emerald-300 text-emerald-800 hover:bg-emerald-100"
                                    onClick={handleValidateReceipt}
                                    disabled={validating}
                                  >
                                    {validating ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
                                    {validating ? 'Verifying ledger…' : 'Verify against ledger'}
                                  </Button>
                                )}

                                {validation?.ok && (
                                  <p className="text-[11px] font-medium text-emerald-800 flex items-center gap-1">
                                    <ShieldCheck className="h-3 w-3" /> Reconciled — amounts, commission & balance match the ledger
                                  </p>
                                )}

                                {validation && !validation.ok && (
                                  <div className="space-y-1 rounded border border-destructive/30 bg-destructive/5 p-1.5">
                                    <p className="text-[11px] font-semibold text-destructive flex items-center gap-1">
                                      <ShieldAlert className="h-3 w-3" /> Ledger mismatch
                                    </p>
                                    <ul className="list-disc pl-4 space-y-0.5">
                                      {validation.issues.map((iss, i) => (
                                        <li key={i} className="text-[10.5px] text-destructive">{iss}</li>
                                      ))}
                                    </ul>
                                    {!validationOverride && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 w-full text-[10.5px] text-destructive hover:bg-destructive/10"
                                        onClick={() => setValidationOverride(true)}
                                      >
                                        Download anyway (override)
                                      </Button>
                                    )}
                                  </div>
                                )}

                                {/* Step 2 — download once reconciled (or overridden) */}
                                {(validation?.ok || validationOverride) && (
                                  <div className="flex gap-2">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-7 flex-1 text-xs gap-1.5 border-emerald-300 text-emerald-800 hover:bg-emerald-100"
                                      onClick={() => handleDownloadReceipt('pdf')}
                                      disabled={downloadingReceipt !== null}
                                    >
                                      {downloadingReceipt === 'pdf' ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
                                      PDF
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-7 flex-1 text-xs gap-1.5 border-emerald-300 text-emerald-800 hover:bg-emerald-100"
                                      onClick={() => handleDownloadReceipt('xlsx')}
                                      disabled={downloadingReceipt !== null}
                                    >
                                      {downloadingReceipt === 'xlsx' ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileSpreadsheet className="h-3 w-3" />}
                                      Excel
                                    </Button>
                                  </div>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent collections */}
          {/* Tenant migration history */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Migration History</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {!transferHistory || transferHistory.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground text-center">
                  No agent transfers recorded for this tenant
                </p>
              ) : (
                <div className="divide-y divide-border">
                  {transferHistory.map((t) => (
                    <div key={t.id} className="px-4 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">
                          {t.from_agent_name || 'Unassigned'} → {t.to_agent_name || 'Unassigned'}
                        </p>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {format(new Date(t.occurred_at), 'dd MMM yyyy, HH:mm')}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {t.source.replace(/_/g, ' ')}
                        {t.actor_name ? ` · by ${t.actor_name}` : ''}
                      </p>
                      {t.reason && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">Reason: {t.reason}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {data?.collections && data.collections.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Recent Collections</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border">
                  {data.collections.map((c) => (
                    <div key={c.id} className="px-4 py-2.5 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">UGX {Number(c.amount).toLocaleString()}</p>
                        <p className="text-[11px] text-muted-foreground">{c.payment_method}</p>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(c.created_at), 'dd MMM, HH:mm')}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
      <TenantAssignAgentDialog
        open={!!transferReq}
        onOpenChange={(v) => { if (!v) setTransferReq(null); }}
        rentRequestId={transferReq?.id ?? null}
        tenantId={tenantId}
        tenantName={tenantName}
        currentAgentId={transferReq?.agent_id ?? null}
        onSaved={() => {
          setTransferReq(null);
          queryClient.invalidateQueries({ queryKey: ['tenant-detail', tenantId] });
        }}
      />
    </div>
  );
}
