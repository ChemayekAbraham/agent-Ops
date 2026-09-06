import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchOpsWallet } from '@/hooks/ops/useOpsDataLayer';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Banknote, UserPlus, Loader2, XCircle, Building2, Smartphone, Phone, Mail, MapPin,
  CreditCard, Calendar, Shield, Wallet, Users, TrendingUp, ArrowLeft, Search, CheckCircle2, Clock,
  Network, Activity, Zap, Pencil, Trash2, FileCheck, FileWarning, Download, Monitor, Globe,
  ChevronRight, ChevronDown, Hash, Inbox,
} from 'lucide-react';
import { UserSearchPicker } from './UserSearchPicker';
import { CashoutPendingWithdrawalsDialog } from './CashoutPendingWithdrawalsDialog';
import { formatUGX } from '@/lib/rentCalculations';
import { getTelecomSendingCharge, getCashoutCommission } from '@/lib/cashoutCharges';
import { downloadMerchantAgreementPdf } from '@/components/merchant/agreement/merchantAgreementPdf';
import { ClaimCommentTimeline } from './ClaimCommentTimeline';
import { useLatestClaimComments, type CashoutClaimComment } from '@/hooks/useCashoutClaimComments';
import { MessageSquare } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar as CalendarPicker } from '@/components/ui/calendar';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  PAYOUT_CATEGORY_GROUPS, ALL_PAYOUT_CATEGORIES, APPROVAL_RULES, AGENT_STATUSES,
  SUPPORTED_BANKS, defaultCashoutAgentConfig, normalizeCashoutAgentConfig,
  type CashoutAgentConfig, type ApprovalRule,
} from '@/lib/cashoutAgentConfig';
import { AgentEvaluationSection } from '@/components/executive/AgentEvaluationSection';

// Calendar-driven date filter. Value/onChange use the 'yyyy-MM-dd' string the
// rest of the component already filters on, so it's a drop-in replacement for
// the old native <input type="date">.
function DateFilterPicker({
  value,
  onChange,
  label = 'Pick a date',
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  const selected = value ? new Date(`${value}T00:00:00`) : undefined;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'h-9 w-full justify-start text-left font-normal text-xs pl-8 relative',
            !value && 'text-muted-foreground',
          )}
        >
          <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          {selected ? format(selected, 'PPP') : label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <CalendarPicker
          mode="single"
          selected={selected}
          onSelect={(d) => onChange(d ? format(d, 'yyyy-MM-dd') : '')}
          initialFocus
          className={cn('p-3 pointer-events-auto')}
        />
      </PopoverContent>
    </Popover>
  );
}

// A payout only counts as "processed" once the Merchant Agent has executed disbursement.
// `approved` / `cfo_approved` / `manager_approved` are pipeline sign-off stages — NOT execution.
// Only `fin_ops_approved` and `completed` represent money actually delivered to the user.
const COMPLETED_STATUSES = ['fin_ops_approved', 'completed'];
type MethodFilter = 'all' | 'momo' | 'bank' | 'cash';
type StatusFilter = 'all' | 'active' | 'idle';

const isMomo = (m: string | null) => ['mobile_money', 'mtn_mobile_money', 'airtel_money'].includes(m || '');
const isBank = (m: string | null) => m === 'bank_transfer';
const isCash = (m: string | null) => ['cash', 'cash_pickup'].includes(m || '') || !m;

function ClaimCommentDialog({ claim, onClose }: { claim: any | null; onClose: () => void }) {
  const charge = getTelecomSendingCharge(Number(claim?.amount || 0));
  return (
    <Dialog open={!!claim} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-primary" /> Claim comments
          </DialogTitle>
        </DialogHeader>
        {claim && (
          <div className="space-y-4">
            <Card>
              <CardContent className="p-3 divide-y">
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-xs text-muted-foreground">Requested amount</span>
                  <span className="text-sm font-medium">{formatUGX(Number(claim.amount || 0))}</span>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-xs text-muted-foreground">Withdrawal charge</span>
                  <span className="text-sm font-medium text-amber-600">{formatUGX(charge)}</span>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-xs text-muted-foreground">Net paid to customer</span>
                  <span className="text-sm font-bold">{formatUGX(Number(claim.amount || 0))}</span>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-xs text-muted-foreground">Charge bearer</span>
                  <Badge variant="outline" className="text-[10px]">Company</Badge>
                </div>
              </CardContent>
            </Card>
            <ClaimCommentTimeline withdrawalId={claim.id} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MerchantAgentFloatCard({ agentId }: { agentId: string | null | undefined }) {
  const { data, isLoading } = useQuery({
    queryKey: ['cashout-agent-float', agentId],
    enabled: !!agentId,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    queryFn: async () => {
      const w = await fetchOpsWallet(agentId!);
      return {
        float: Number(w?.float ?? 0),
        withdrawable: Number(w?.withdrawable ?? 0),
        advance: Number(w?.advance ?? 0),
        total: Number((w?.withdrawable ?? 0) + (w?.float ?? 0) + (w?.advance ?? 0)),
      };
    },
  });
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Float left right now</p>
          <Wallet className="h-4 w-4 text-primary" />
        </div>
        {isLoading ? (
          <div className="h-6 flex items-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <p className="text-2xl font-bold tabular-nums">{formatUGX(data?.float ?? 0)}</p>
            <div className="grid grid-cols-3 gap-2 mt-3">
              <div className="rounded-md bg-muted/50 p-2 text-center">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Withdrawable</p>
                <p className="text-xs font-semibold tabular-nums mt-0.5">{formatUGX(data?.withdrawable ?? 0)}</p>
              </div>
              <div className="rounded-md bg-muted/50 p-2 text-center">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Advance</p>
                <p className="text-xs font-semibold tabular-nums mt-0.5">{formatUGX(data?.advance ?? 0)}</p>
              </div>
              <div className="rounded-md bg-muted/50 p-2 text-center">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</p>
                <p className="text-xs font-semibold tabular-nums mt-0.5">{formatUGX(data?.total ?? 0)}</p>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function CashoutAgentManager() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAssign, setShowAssign] = useState(false);
  const [pickedAgent, setPickedAgent] = useState<any>(null);
  const [handlesCash, setHandlesCash] = useState(true);
  const [handlesBank, setHandlesBank] = useState(true);
  const [handlesMomo, setHandlesMomo] = useState(true);
  const [label, setLabel] = useState('');
  const [cashoutAgent, setCashoutAgent] = useState<any>(null);
  const [selectedAgent, setSelectedAgent] = useState<any>(null);
  const [commentClaim, setCommentClaim] = useState<any>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [txnDateFilter, setTxnDateFilter] = useState('');
  const [search, setSearch] = useState('');
  const [methodFilter, setMethodFilter] = useState<MethodFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [methodDetail, setMethodDetail] = useState<null | 'momo' | 'bank' | 'cash'>(null);

  // Global date-range filter — scopes ALL merchant-agent payout stats & KPIs.
  const [datePreset, setDatePreset] = useState<'all' | 'today' | '7d' | '30d' | 'custom'>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  // Edit dialog state
  const [editAgent, setEditAgent] = useState<any>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editConfig, setEditConfig] = useState<CashoutAgentConfig>(() => defaultCashoutAgentConfig());

  // Delete confirmation state
  const [deleteAgent, setDeleteAgent] = useState<any>(null);

  const openEdit = (a: any) => {
    setEditAgent(a);
    setEditLabel(a.label || '');
    setEditConfig(normalizeCashoutAgentConfig(a.config, a));
  };

  const { data: agents = [], isLoading } = useQuery({
    queryKey: ['merchant-agents'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cashout_agents')
        .select('*, profiles:agent_id(id, full_name, phone, email, city, country, territory, mobile_money_number, mobile_money_provider, national_id, agent_type, verified, is_frozen, frozen_reason, created_at, last_active_at)')
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  // Resolve the active date-range filter into ISO bounds (local day boundaries).
  const dateBounds = useMemo(() => {
    const now = new Date();
    const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
    const endOfDay = (d: Date) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
    const DAY = 24 * 3600 * 1000;
    if (datePreset === 'today') return { from: startOfDay(now).toISOString(), to: null as string | null };
    if (datePreset === '7d') return { from: startOfDay(new Date(now.getTime() - 6 * DAY)).toISOString(), to: null as string | null };
    if (datePreset === '30d') return { from: startOfDay(new Date(now.getTime() - 29 * DAY)).toISOString(), to: null as string | null };
    if (datePreset === 'custom') {
      return {
        from: customFrom ? startOfDay(new Date(customFrom)).toISOString() : null,
        to: customTo ? endOfDay(new Date(customTo)).toISOString() : null,
      };
    }
    return { from: null as string | null, to: null as string | null };
  }, [datePreset, customFrom, customTo]);

  const dateFilterLabel = useMemo(() => {
    if (datePreset === 'all') return 'All time';
    if (datePreset === 'today') return 'Today';
    if (datePreset === '7d') return 'Last 7 days';
    if (datePreset === '30d') return 'Last 30 days';
    const f = customFrom ? new Date(customFrom).toLocaleDateString('en-UG', { day: 'numeric', month: 'short' }) : '…';
    const t = customTo ? new Date(customTo).toLocaleDateString('en-UG', { day: 'numeric', month: 'short' }) : '…';
    return `${f} → ${t}`;
  }, [datePreset, customFrom, customTo]);

  const { data: payouts = [] } = useQuery({
    queryKey: ['merchant-agent-payouts', dateBounds.from, dateBounds.to],
    queryFn: async () => {
      // PostgREST caps any single response at 1,000 rows no matter what
      // .limit() asks for, so the KPIs froze at "1000 payouts" once the network
      // crossed that many. Page through until a short page comes back so every
      // completed payout is counted. Ordering carries an `id` tiebreaker —
      // processed_at alone is not unique and would let rows repeat or vanish
      // across page boundaries.
      const PAGE = 1000;
      const out: any[] = [];
      for (let from = 0; ; from += PAGE) {
        let q = supabase
          .from('withdrawal_requests')
          .select('id, amount, payout_method, status, created_at, processed_at, fin_ops_reference, assigned_cashout_agent_id, user_id, mobile_money_name, mobile_money_number')
          .in('status', COMPLETED_STATUSES)
          .not('assigned_cashout_agent_id', 'is', null)
          .order('processed_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, from + PAGE - 1);
        if (dateBounds.from) q = q.gte('processed_at', dateBounds.from);
        if (dateBounds.to) q = q.lte('processed_at', dateBounds.to);
        const { data, error } = await q;
        if (error) throw error;
        const rows = data || [];
        out.push(...rows);
        if (rows.length < PAGE) break;
        // Safety valve against runaway loops.
        if (out.length >= 50_000) break;
      }
      return out;
    },
  });

  const { data: pendingClaims = 0 } = useQuery({
    queryKey: ['merchant-agent-active-claims'],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('withdrawal_requests')
        .select('id', { count: 'exact', head: true })
        .not('assigned_cashout_agent_id', 'is', null)
        .in('status', ['pending', 'requested', 'approved', 'manager_approved', 'cfo_approved']);
      if (error) throw error;
      return count || 0;
    },
  });

  // Merchant Agent Agreement acceptances — who has formally signed on to be a
  // Merchant (Cash-Out) Agent, with the audited detail (version, device, IP, date).
  const { data: agreements = [] } = useQuery({
    queryKey: ['merchant-agreement-acceptances'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('merchant_agreement_acceptance' as any)
        .select('*')
        .eq('status', 'accepted')
        .order('accepted_at', { ascending: false });
      if (error) throw error;
      return (data || []) as any[];
    },
    staleTime: 60_000,
  });

  // Newest acceptance per agent_id (matches cashout_agents.agent_id).
  const agreementByAgentId = useMemo(() => {
    const m = new Map<string, any>();
    for (const a of agreements as any[]) {
      if (!m.has(a.agent_id)) m.set(a.agent_id, a);
    }
    return m;
  }, [agreements]);

  // Per-merchant active claim list — drives the "pending" badge on each card AND
  // powers the "Release stuck claims" recovery action in the delete dialog.
  const { data: pendingClaimRows = [] } = useQuery({
    queryKey: ['merchant-agent-active-claims-rows'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('withdrawal_requests')
        .select('id, status, amount, assigned_cashout_agent_id, created_at')
        .not('assigned_cashout_agent_id', 'is', null)
        .in('status', ['pending', 'requested', 'approved', 'manager_approved', 'cfo_approved']);
      if (error) throw error;
      return data || [];
    },
  });

  const pendingByAgent = useMemo(() => {
    const m = new Map<string, { count: number; ids: string[]; oldestAt: string | null }>();
    for (const r of pendingClaimRows as any[]) {
      const id = r.assigned_cashout_agent_id;
      if (!id) continue;
      const cur = m.get(id) || { count: 0, ids: [] as string[], oldestAt: null as string | null };
      cur.count += 1;
      cur.ids.push(r.id);
      if (!cur.oldestAt || (r.created_at && r.created_at < cur.oldestAt)) cur.oldestAt = r.created_at;
      m.set(id, cur);
    }
    return m;
  }, [pendingClaimRows]);

  const assignMutation = useMutation({
    mutationFn: async () => {
      if (!pickedAgent) throw new Error('Please select an agent');
      const { error } = await supabase.from('cashout_agents').upsert({
        agent_id: pickedAgent.id,
        assigned_by: user!.id,
        handles_cash: handlesCash,
        handles_bank: handlesBank,
        handles_mtn: handlesMomo,
        handles_airtel: handlesMomo,
        label: label || 'Merchant Agent',
        is_active: true,
      }, { onConflict: 'agent_id' });
      if (error) throw error;
      await supabase.from('audit_logs').insert({
        user_id: user!.id,
        action_type: 'cfo_merchant_agent_assigned',
        table_name: 'cashout_agents',
        record_id: pickedAgent.id,
        metadata: { agent_name: pickedAgent.full_name || pickedAgent.id, handles_cash: handlesCash, handles_bank: handlesBank, handles_momo: handlesMomo, label: label || 'Merchant Agent' },
      });
      // Notify the newly assigned merchant agent via SMS (+ in-app). Fire-and-forget:
      // never let a notification hiccup fail the assignment itself.
      supabase.functions.invoke('notify-merchant-agent-assigned', {
        body: { agent_id: pickedAgent.id },
      }).catch(() => {});
    },
    onSuccess: () => {
      toast({ title: '✅ Merchant Agent assigned' });
      qc.invalidateQueries({ queryKey: ['merchant-agents'] });
      setShowAssign(false);
      setPickedAgent(null);
      setLabel('');
    },
    onError: (e: any) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('cashout_agents').update({ is_active: false }).eq('id', id);
      if (error) throw error;
      await supabase.from('audit_logs').insert({
        user_id: user!.id,
        action_type: 'cfo_merchant_agent_deactivated',
        table_name: 'cashout_agents',
        record_id: id,
        metadata: {},
      });
    },
    onSuccess: () => {
      toast({ title: 'Merchant Agent removed' });
      qc.invalidateQueries({ queryKey: ['merchant-agents'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (agent: any) => {
      // Block delete if there are active claims still routed to this merchant
      const { count, error: countError } = await supabase
        .from('withdrawal_requests')
        .select('id', { count: 'exact', head: true })
        .eq('assigned_cashout_agent_id', agent.id)
        .in('status', ['pending', 'requested', 'approved', 'manager_approved', 'cfo_approved']);
      if (countError) throw countError;
      if ((count || 0) > 0) {
        throw new Error(`Cannot remove: ${count} active payout claim${count === 1 ? '' : 's'} still routed to this merchant. Reassign or complete them first.`);
      }
      // Soft-remove: keep the record and all history intact, only strip the
      // Merchant Agent role by deactivating the cashout_agents row. Merchant
      // status is derived solely from is_active (see useIsMerchantAgent).
      const { error } = await supabase
        .from('cashout_agents')
        .update({ is_active: false })
        .eq('id', agent.id);
      if (error) throw error;
      await supabase.from('audit_logs').insert({
        user_id: user!.id,
        action_type: 'cfo_merchant_agent_role_removed',
        table_name: 'cashout_agents',
        record_id: agent.id,
        metadata: {
          soft_removed: true,
          agent_name: agent.profiles?.full_name || agent.agent_id,
          label: agent.label,
          handles_cash: agent.handles_cash,
          handles_bank: agent.handles_bank,
          handles_mtn: agent.handles_mtn,
          handles_airtel: agent.handles_airtel,
        },
      });
    },
    onSuccess: () => {
      toast({ title: '✅ Merchant role removed', description: 'The user keeps all their records — they are just no longer a Merchant Agent.' });
      qc.invalidateQueries({ queryKey: ['merchant-agents'] });
      qc.invalidateQueries({ queryKey: ['merchant-agent-active-claims'] });
      qc.invalidateQueries({ queryKey: ['merchant-agent-active-claims-rows'] });
      qc.invalidateQueries({ queryKey: ['is-merchant-agent'] });
      if (selectedAgent && deleteAgent && selectedAgent.id === deleteAgent.id) {
        setSelectedAgent(null);
      }
      setDeleteAgent(null);
    },
    onError: (e: any) => toast({ title: 'Could not remove merchant role', description: e.message, variant: 'destructive' }),
  });

  // Release all stuck claims still routed to a merchant — unassigns them so the
  // open-pool routing can pick them up again. Used to unblock deletion when a
  // merchant has stale or orphan claims they can't / won't process.
  const releaseClaimsMutation = useMutation({
    mutationFn: async (agent: any) => {
      const info = pendingByAgent.get(agent.id);
      // Guard: only release when there are actually claims (> 0) routed to this merchant.
      if (!info || info.count <= 0 || !info.ids?.length) {
        throw new Error('No active claims to release — queue is already empty');
      }
      const { error } = await supabase
        .from('withdrawal_requests')
        .update({ assigned_cashout_agent_id: null })
        .in('id', info.ids);
      if (error) throw error;
      await supabase.from('audit_logs').insert({
        user_id: user!.id,
        action_type: 'cfo_merchant_agent_claims_released',
        table_name: 'withdrawal_requests',
        record_id: agent.id,
        metadata: {
          agent_name: agent.profiles?.full_name || agent.agent_id,
          released_count: info.count,
          released_ids: info.ids,
        },
      });
    },
    onSuccess: (_d, agent) => {
      toast({
        title: '🔓 Claims released',
        description: 'Stuck claims returned to the open pool. You can now delete this merchant.',
      });
      qc.invalidateQueries({ queryKey: ['merchant-agent-active-claims'] });
      qc.invalidateQueries({ queryKey: ['merchant-agent-active-claims-rows'] });
      qc.invalidateQueries({ queryKey: ['cfo-pending-withdrawals'] });
    },
    onError: (e: any) => toast({ title: 'Release failed', description: e.message, variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editAgent) throw new Error('No merchant selected');
      const cfg = editConfig;
      if (!cfg.channels.cash && !cfg.channels.bank && !cfg.channels.momo) {
        throw new Error('Enable at least one payment channel');
      }
      const anyCategory = Object.values(cfg.categories).some(Boolean);
      if (!anyCategory) {
        throw new Error('Authorize at least one payout category');
      }
      const patch: Record<string, any> = {
        label: editLabel.trim() || 'Merchant Agent',
        // Keep legacy boolean columns in sync so existing routing & filters work.
        handles_cash: cfg.channels.cash,
        handles_bank: cfg.channels.bank,
        handles_mtn: cfg.channels.momo && cfg.networks.mtn,
        handles_airtel: cfg.channels.momo && cfg.networks.airtel,
        is_active: cfg.status === 'active',
        config: cfg as any,
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase.from('cashout_agents').update(patch as any).eq('id', editAgent.id);
      if (error) throw error;
      // Enforce the new matrix immediately: release any still-open payout this
      // merchant holds that the updated channels / categories no longer allow.
      let revoked = 0;
      const { data: revokeData, error: revokeErr } = await supabase.rpc(
        'revoke_nonconforming_merchant_claims' as any,
        { p_agent_id: editAgent.id, p_reason: 'CFO updated merchant permission matrix' } as any,
      );
      if (!revokeErr) revoked = Number((revokeData as any)?.count || 0);
      await supabase.from('audit_logs').insert({
        user_id: user!.id,
        action_type: 'cfo_merchant_agent_updated',
        table_name: 'cashout_agents',
        record_id: editAgent.id,
        metadata: {
          agent_name: editAgent.profiles?.full_name || editAgent.agent_id,
          before: {
            label: editAgent.label,
            handles_cash: editAgent.handles_cash,
            handles_bank: editAgent.handles_bank,
            handles_mtn: editAgent.handles_mtn,
            handles_airtel: editAgent.handles_airtel,
            config: editAgent.config ?? null,
          },
          after: patch,
          reason: 'CFO updated merchant agent permission matrix',
        } as any,
      } as any);
      return { revoked };
    },
    onSuccess: (res: any) => {
      const revoked = Number(res?.revoked || 0);
      toast({
        title: '✅ Merchant Agent updated',
        description: revoked > 0
          ? `Enforced immediately — ${revoked} open payout${revoked === 1 ? '' : 's'} outside the new permissions returned to the open pool.`
          : 'New payment channels & authorized categories are enforced immediately.',
      });
      qc.invalidateQueries({ queryKey: ['merchant-agents'] });
      qc.invalidateQueries({ queryKey: ['merchant-agent-active-claims'] });
      qc.invalidateQueries({ queryKey: ['merchant-agent-active-claims-rows'] });
      qc.invalidateQueries({ queryKey: ['cfo-pending-withdrawals'] });
      // Refresh the drill-down view if it's open on the same agent
      if (selectedAgent && editAgent && selectedAgent.id === editAgent.id) {
        setSelectedAgent({
          ...selectedAgent,
          label: editLabel.trim() || 'Merchant Agent',
          handles_cash: editConfig.channels.cash,
          handles_bank: editConfig.channels.bank,
          handles_mtn: editConfig.channels.momo && editConfig.networks.mtn,
          handles_airtel: editConfig.channels.momo && editConfig.networks.airtel,
          is_active: editConfig.status === 'active',
          config: editConfig,
        });
      }
      setEditAgent(null);
    },
    onError: (e: any) => toast({ title: 'Update failed', description: e.message, variant: 'destructive' }),
  });

  const formatDate = (d: string | null) => d ? new Date(d).toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const formatDateTime = (d: string | null) => d ? new Date(d).toLocaleString('en-UG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

  // Per-agent stats with method breakdown + last activity
  const agentStats = useMemo(() => {
    const map = new Map<string, { count: number; volume: number; bank: number; momo: number; cash: number; bankCount: number; momoCount: number; cashCount: number; lastAt: string | null; todayCount: number }>();
    const todayStr = new Date().toDateString();
    for (const p of payouts) {
      const id = p.assigned_cashout_agent_id;
      if (!id) continue;
      const cur = map.get(id) || { count: 0, volume: 0, bank: 0, momo: 0, cash: 0, bankCount: 0, momoCount: 0, cashCount: 0, lastAt: null, todayCount: 0 };
      const amt = Number(p.amount || 0);
      cur.count += 1;
      cur.volume += amt;
      if (isBank(p.payout_method)) { cur.bank += amt; cur.bankCount += 1; }
      else if (isMomo(p.payout_method)) { cur.momo += amt; cur.momoCount += 1; }
      else { cur.cash += amt; cur.cashCount += 1; }
      const stamp = p.processed_at || p.created_at;
      if (!cur.lastAt || (stamp && stamp > cur.lastAt)) cur.lastAt = stamp;
      if (stamp && new Date(stamp).toDateString() === todayStr) cur.todayCount += 1;
      map.set(id, cur);
    }
    return map;
  }, [payouts]);

  // KPIs
  const kpis = useMemo(() => {
    const totalPaid = payouts.reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
    const bank = payouts.filter((p: any) => isBank(p.payout_method));
    const momo = payouts.filter((p: any) => isMomo(p.payout_method));
    const cash = payouts.filter((p: any) => isCash(p.payout_method));
    const todayStr = new Date().toDateString();
    const todayPayouts = payouts.filter((p: any) => {
      const s = p.processed_at || p.created_at;
      return s && new Date(s).toDateString() === todayStr;
    });
    const activeToday = new Set(todayPayouts.map((p: any) => p.assigned_cashout_agent_id).filter(Boolean)).size;
    const chargesTotal = payouts.reduce((s: number, p: any) => s + getTelecomSendingCharge(Number(p.amount || 0)), 0);
    return {
      agentsCount: agents.length,
      activeToday,
      totalPaid,
      payoutsCount: payouts.length,
      todayCount: todayPayouts.length,
      pendingClaims,
      chargesTotal,
      bankAmount: bank.reduce((s: number, p: any) => s + Number(p.amount || 0), 0),
      momoAmount: momo.reduce((s: number, p: any) => s + Number(p.amount || 0), 0),
      cashAmount: cash.reduce((s: number, p: any) => s + Number(p.amount || 0), 0),
      bankCount: bank.length,
      momoCount: momo.length,
      cashCount: cash.length,
    };
  }, [agents, payouts, pendingClaims]);

  const filteredAgents = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    return agents.filter((a: any) => {
      // Search
      if (q) {
        const name = (a.profiles?.full_name || '').toLowerCase();
        const phone = (a.profiles?.phone || '').toLowerCase();
        const lbl = (a.label || '').toLowerCase();
        if (!name.includes(q) && !phone.includes(q) && !lbl.includes(q)) return false;
      }
      // Method capability
      if (methodFilter === 'momo' && !(a.handles_mtn || a.handles_airtel)) return false;
      if (methodFilter === 'bank' && !a.handles_bank) return false;
      if (methodFilter === 'cash' && !a.handles_cash) return false;
      // Activity
      if (statusFilter !== 'all') {
        const stats = agentStats.get(a.id);
        const recent = stats?.lastAt && new Date(stats.lastAt).getTime() > sevenDaysAgo;
        if (statusFilter === 'active' && !recent) return false;
        if (statusFilter === 'idle' && recent) return false;
      }
      return true;
    });
  }, [agents, search, methodFilter, statusFilter, agentStats]);

  // Fleet-wide duplicate detector — flags, per agent, any beneficiary+amount
  // paid more than once. Drives the "duplicates" badge on each agent card so
  // mistakes surface at a glance without opening the drill-down.
  const duplicateByAgent = useMemo(() => {
    const perAgent = new Map<string, Map<string, number>>();
    for (const py of payouts as any[]) {
      const agentId = py.assigned_cashout_agent_id;
      if (!agentId) continue;
      const who = String(
        py.mobile_money_number || py.beneficiary_phone ||
        py.mobile_money_name || py.beneficiary_name || py.user_id || 'unknown',
      ).trim().toLowerCase();
      const key = `${who}|${Number(py.amount || 0)}`;
      const m = perAgent.get(agentId) || new Map<string, number>();
      m.set(key, (m.get(key) || 0) + 1);
      perAgent.set(agentId, m);
    }
    const result = new Map<string, number>();
    for (const [agentId, m] of perAgent) {
      let groups = 0;
      for (const n of m.values()) if (n > 1) groups += 1;
      if (groups > 0) result.set(agentId, groups);
    }
    return result;
  }, [payouts]);

  const selectedAgentPayouts = useMemo(() => {
    if (!selectedAgent) return [];
    return payouts.filter((p: any) => p.assigned_cashout_agent_id === selectedAgent.id);
  }, [selectedAgent, payouts]);

  // ---- Duplicate / repeat-payout detector (per merchant agent) ----
  // Flags payouts this agent sent to the SAME beneficiary for the SAME amount.
  // This is the exact fingerprint of the double-payout mistakes we want to catch
  // (e.g. a customer owed 150K getting paid twice). Grouped by beneficiary
  // identity (phone → name fallback) + amount; any group of 2+ is suspicious.
  const duplicatePayouts = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const py of selectedAgentPayouts as any[]) {
      const who = String(
        py.mobile_money_number || py.beneficiary_phone ||
        py.mobile_money_name || py.beneficiary_name || py.user_id || 'unknown',
      ).trim().toLowerCase();
      const key = `${who}|${Number(py.amount || 0)}`;
      const arr = groups.get(key) || [];
      arr.push(py);
      groups.set(key, arr);
    }
    const flaggedIds = new Set<string>();
    let excess = 0;
    let groupCount = 0;
    for (const arr of groups.values()) {
      if (arr.length > 1) {
        groupCount += 1;
        // Every payout beyond the first in the group is a suspected duplicate.
        excess += Number(arr[0].amount || 0) * (arr.length - 1);
        for (const py of arr) flaggedIds.add(String(py.id));
      }
    }
    return { flaggedIds, excess, groupCount };
  }, [selectedAgentPayouts]);

  // ---- Daily float breakdown (per merchant agent) ----
  // The CFO needs to see how much float this agent gave out on EACH day,
  // not just the running total. Group settled payouts by calendar day
  // (processed_at → created_at fallback), summing amount + count.
  const dailyPayoutBreakdown = useMemo(() => {
    const byDay = new Map<string, { amount: number; count: number }>();
    for (const py of selectedAgentPayouts as any[]) {
      const stamp = py.processed_at || py.created_at;
      if (!stamp) continue;
      const d = new Date(stamp);
      if (isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const cur = byDay.get(key) || { amount: 0, count: 0 };
      cur.amount += Number(py.amount || 0);
      cur.count += 1;
      byDay.set(key, cur);
    }
    return Array.from(byDay.entries())
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
  }, [selectedAgentPayouts]);

  // Individual payouts grouped by calendar day, most-recent day first, and each
  // day's payouts sorted latest-first. Powers the expandable rows inside the
  // "Float Given Out Per Day" drill-down modal.
  const payoutsByDay = useMemo(() => {
    const byDay = new Map<string, any[]>();
    for (const py of selectedAgentPayouts as any[]) {
      const stamp = py.processed_at || py.created_at;
      if (!stamp) continue;
      const d = new Date(stamp);
      if (isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const arr = byDay.get(key) || [];
      arr.push(py);
      byDay.set(key, arr);
    }
    for (const arr of byDay.values()) {
      arr.sort((a, b) => {
        const ta = new Date(a.processed_at || a.created_at).getTime();
        const tb = new Date(b.processed_at || b.created_at).getTime();
        return tb - ta;
      });
    }
    return byDay;
  }, [selectedAgentPayouts]);

  const toggleDay = (day: string) =>
    setExpandedDays((prev) => {
      const next = new Set(prev);
      next.has(day) ? next.delete(day) : next.add(day);
      return next;
    });

  // Payouts shown in the "Payouts Processed" list, optionally narrowed to a
  // single calendar day the CFO picks with the date filter above the list.
  const visiblePayouts = useMemo(() => {
    if (!txnDateFilter) return selectedAgentPayouts as any[];
    return (selectedAgentPayouts as any[]).filter((py) => {
      const stamp = py.processed_at || py.created_at;
      if (!stamp) return false;
      const d = new Date(stamp);
      if (isNaN(d.getTime())) return false;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return key === txnDateFilter;
    });
  }, [selectedAgentPayouts, txnDateFilter]);

  // Latest comment per payout — inline note on each processed-payout card.
  const { data: latestClaimComments } = useLatestClaimComments(
    selectedAgentPayouts.map((p: any) => p.id),
  );

  // Commission the merchant actually earned on each settled payout — read from
  // their own wallet ledger legs (`<withdrawal_id>-cashout-commission`) so the
  // drill-down reconciles 1:1 with what landed in their withdrawable wallet.
  const { data: commissionByWithdrawal = {} } = useQuery({
    queryKey: ['cashout-agent-commission-legs', selectedAgent?.agent_id, selectedAgentPayouts.map((p: any) => p.id).join(',')],
    queryFn: async () => {
      const map: Record<string, number> = {};
      if (!selectedAgent?.agent_id) return map;
      const ids = selectedAgentPayouts.map((p: any) => String(p.id));
      if (ids.length === 0) return map;
      const { data, error } = await supabase
        .from('general_ledger')
        .select('amount, reference_id')
        .eq('user_id', selectedAgent.agent_id)
        .eq('ledger_scope', 'wallet')
        .eq('direction', 'cash_in')
        .eq('category', 'agent_commission_earned')
        .in('reference_id', ids.map((id) => `${id}-cashout-commission`));
      if (error) throw error;
      for (const l of (data || []) as any[]) {
        map[String(l.reference_id || '').replace('-cashout-commission', '')] = Number(l.amount || 0);
      }
      return map;
    },
    enabled: !!selectedAgent?.agent_id && selectedAgentPayouts.length > 0,
    staleTime: 30_000,
  });

  const selectedAgentStats = selectedAgent ? agentStats.get(selectedAgent.id) || { count: 0, volume: 0, bank: 0, momo: 0, cash: 0, bankCount: 0, momoCount: 0, cashCount: 0, lastAt: null, todayCount: 0 } : null;

  // Total float ever disbursed TO this merchant agent (all-time). Read straight
  // from the ledger so the CFO sees the true issued figure regardless of what
  // has since been consumed. Used to contextualise "Volume Total" as
  // "used out of disbursed" rather than a bare number.
  const { data: disbursedFloatTotal = 0 } = useQuery({
    queryKey: ['cashout-agent-disbursed-float', selectedAgent?.agent_id],
    enabled: !!selectedAgent?.agent_id,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('general_ledger')
        .select('amount')
        .eq('user_id', selectedAgent!.agent_id)
        .eq('ledger_scope', 'wallet')
        .eq('direction', 'cash_in')
        .in('category', ['agent_float_deposit', 'agent_float_assignment', 'agent_float_funding', 'operational_float_credit', 'float_topup']);
      if (error) throw error;
      return (data || []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
    },
  });

  // Live float balance for the selected agent. Used so "Volume Total" reads as
  // (disbursed − float left right now), which INCLUDES telecom charges and any
  // other float-consuming legs — the payout-amount `volume` alone leaves a gap
  // and the tile stops tallying with the Float Left card.
  const { data: currentFloatBalance = 0 } = useQuery({
    queryKey: ['cashout-agent-current-float', selectedAgent?.agent_id],
    enabled: !!selectedAgent?.agent_id,
    staleTime: 30_000,
    queryFn: async () => {
      const w = await fetchOpsWallet(selectedAgent!.agent_id);
      return Number(w?.float ?? 0);
    },
  });
  const floatConsumedTotal = Math.max(0, disbursedFloatTotal - currentFloatBalance);

  // Volume + count scoped to the picked date. When a date filter is active the
  // "Volume Total" and "Completed Payouts" tiles must reflect ONLY that day so
  // volume, commission and telecom charges all describe the same set of payouts.
  const visibleVolume = useMemo(
    () => (visiblePayouts as any[]).reduce((s, py) => s + Number(py.amount || 0), 0),
    [visiblePayouts],
  );

  // Method breakdown (MoMo / Bank / Cash) scoped to the visible payouts so the
  // tiles honour the selected-date filter. Without this they showed all-time
  // totals while the KPIs above described only the picked day.
  const visibleMethodBreakdown = useMemo(() => {
    let bank = 0, momo = 0, cash = 0, bankCount = 0, momoCount = 0, cashCount = 0;
    for (const py of visiblePayouts as any[]) {
      const amt = Number(py.amount || 0);
      if (isBank(py.payout_method)) { bank += amt; bankCount += 1; }
      else if (isMomo(py.payout_method)) { momo += amt; momoCount += 1; }
      else { cash += amt; cashCount += 1; }
    }
    return { bank, momo, cash, bankCount, momoCount, cashCount };
  }, [visiblePayouts]);

  // When a date is picked, the method tiles reflect only that day; otherwise
  // they fall back to the agent's all-time stats.
  const methodTiles = txnDateFilter ? visibleMethodBreakdown : {
    bank: selectedAgentStats?.bank || 0,
    momo: selectedAgentStats?.momo || 0,
    cash: selectedAgentStats?.cash || 0,
    bankCount: selectedAgentStats?.bankCount || 0,
    momoCount: selectedAgentStats?.momoCount || 0,
    cashCount: selectedAgentStats?.cashCount || 0,
  };

  // Commission accuracy reconciliation. Rather than silently masking gaps with
  // the 0.5% estimate, compare what actually landed in the merchant's wallet
  // (ledger legs) against what SHOULD have been credited (0.5% of each payout).
  // This surfaces payouts that never received a commission leg (under-credit)
  // so the CFO sees the real, honest figure instead of an idealised one.
  const commissionSummary = useMemo(() => {
    const legs = commissionByWithdrawal as Record<string, number>;
    let credited = 0;      // what actually hit the wallet (ledger only)
    let expected = 0;      // what 0.5% says it should be
    let missingCount = 0;  // payouts with no commission leg
    for (const py of visiblePayouts as any[]) {
      const amt = Number(py.amount || 0);
      expected += getCashoutCommission(amt);
      const leg = legs[String(py.id)];
      if (leg === undefined) missingCount += 1;
      else credited += Number(leg || 0);
    }
    return { credited, expected, missingCount, gap: expected - credited };
  }, [visiblePayouts, commissionByWithdrawal]);

  const methodBadges = (a: any) => {
    const handlesMomoAny = a.handles_mtn || a.handles_airtel;
    return (
      <>
        {handlesMomoAny && <Badge variant="outline" className="text-[9px] h-4 px-1 gap-0.5"><Smartphone className="h-2.5 w-2.5" />MoMo</Badge>}
        {a.handles_bank && <Badge variant="outline" className="text-[9px] h-4 px-1 gap-0.5"><Building2 className="h-2.5 w-2.5" />Bank</Badge>}
        {a.handles_cash && <Badge variant="outline" className="text-[9px] h-4 px-1 gap-0.5"><Banknote className="h-2.5 w-2.5" />Cash</Badge>}
        {handlesMomoAny && a.handles_bank && a.handles_cash && (
          <Badge variant="primary" className="text-[9px] h-4 px-1 gap-0.5"><Zap className="h-2.5 w-2.5" />Multi-Method</Badge>
        )}
      </>
    );
  };

  // Export the Commission & Telecom report (plus the underlying transactions)
  // for the currently selected date filter as a PDF.
  const exportReportPdf = async () => {
    if (!selectedAgent) return;
    const { generateCommissionTelecomReportPdf } = await import('@/lib/commissionTelecomReportPdf');
    const legs = commissionByWithdrawal as Record<string, number>;
    const rows = visiblePayouts as any[];

    const prof = selectedAgent.profiles || {};
    const scopeLabel = txnDateFilter
      ? new Date(`${txnDateFilter}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
      : 'All dates';

    const telecomTotal = rows.reduce((s, py) => s + getTelecomSendingCharge(Number(py.amount || 0)), 0);
    const volumeTotal = rows.reduce((s, py) => s + Number(py.amount || 0), 0);

    const blob = await generateCommissionTelecomReportPdf({
      agentName: prof.full_name || 'Unknown',
      agentPhone: prof.phone || '—',
      scopeLabel,
      rows: rows.map((py) => {
        const leg = legs[String(py.id)];
        return {
          dateTime: formatDateTime(py.processed_at || py.created_at),
          recipient: py.beneficiary_name || py.mobile_money_name || 'Beneficiary',
          phone: py.beneficiary_phone || py.mobile_money_number || '—',
          method: (py.payout_method || 'cash').replace(/_/g, ' '),
          amount: Number(py.amount || 0),
          commission: leg === undefined ? null : Number(leg || 0),
          telecom: getTelecomSendingCharge(Number(py.amount || 0)),
          status: py.status || '—',
          reference: py.fin_ops_reference || '—',
        };
      }),
      summary: {
        payouts: rows.length,
        volumeTotal,
        commissionCredited: commissionSummary.credited,
        commissionExpected: commissionSummary.expected,
        missingCount: commissionSummary.missingCount,
        gap: commissionSummary.gap,
        telecomTotal,
      },
    });

    const safeName = (prof.full_name || 'agent').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `commission-telecom-${safeName}-${txnDateFilter || 'all-dates'}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast({ title: 'Report exported', description: `${rows.length} transaction(s) for ${scopeLabel}` });
  };

  const exportReportXlsx = async () => {
    if (!selectedAgent) return;
    const { downloadXlsx } = await import('@/lib/xlsxExport');
    const legs = commissionByWithdrawal as Record<string, number>;
    const rows = visiblePayouts as any[];
    const prof = selectedAgent.profiles || {};
    const scopeLabel = txnDateFilter || 'all-dates';
    const safeName = (prof.full_name || 'agent').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

    const headers = ['Date/Time', 'Recipient', 'Phone', 'Method', 'Amount (UGX)', 'Commission (UGX)', 'Telecom (UGX)', 'Status', 'Reference'];
    const dataRows = rows.map((py) => {
      const leg = legs[String(py.id)];
      return [
        formatDateTime(py.processed_at || py.created_at),
        py.beneficiary_name || py.mobile_money_name || 'Beneficiary',
        py.beneficiary_phone || py.mobile_money_number || '—',
        (py.payout_method || 'cash').replace(/_/g, ' '),
        Number(py.amount || 0),
        leg === undefined ? '' : Number(leg || 0),
        getTelecomSendingCharge(Number(py.amount || 0)),
        py.status || '—',
        py.fin_ops_reference || '—',
      ];
    });

    const volumeTotal = rows.reduce((s, py) => s + Number(py.amount || 0), 0);
    const telecomTotal = rows.reduce((s, py) => s + getTelecomSendingCharge(Number(py.amount || 0)), 0);
    dataRows.push([]);
    dataRows.push(['TOTALS', '', '', `${rows.length} payouts`, volumeTotal, commissionSummary.credited, telecomTotal, '', '']);

    await downloadXlsx(`commission-telecom-${safeName}-${scopeLabel}.xlsx`, headers, dataRows, 'Payouts');
    toast({ title: 'Excel exported', description: `${rows.length} transaction(s) for ${scopeLabel}` });
  };

  // ============ DRILL-DOWN VIEW ============
  if (selectedAgent) {
    const p = selectedAgent.profiles || {};
    const handlesMomoAny = selectedAgent.handles_mtn || selectedAgent.handles_airtel;
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setSelectedAgent(null)} className="gap-1.5 -ml-2">
          <ArrowLeft className="h-4 w-4" /> Back to Merchant Agents
        </Button>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-lg shrink-0">
              {(p.full_name || 'A').charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-bold text-base truncate">{p.full_name || 'Unknown'}</p>
              <p className="text-xs text-muted-foreground truncate">{p.phone} · {selectedAgent.label}</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {methodBadges(selectedAgent)}
                {(() => {
                  const pending = pendingByAgent.get(selectedAgent.id);
                  return pending && pending.count > 0 ? (
                    <Badge variant="destructive" className="text-[9px] h-4 px-1 gap-0.5">
                      <Clock className="h-2.5 w-2.5" />
                      {pending.count} in queue
                    </Badge>
                  ) : null;
                })()}
              </div>
          </div>
        </CardContent>
      </Card>

        <div className="grid grid-cols-2 gap-2">
          <KpiTile
            icon={<CheckCircle2 className="h-4 w-4" />}
            label="Completed Payouts"
            value={String(txnDateFilter ? visiblePayouts.length : (selectedAgentStats?.count || 0))}
            tone="primary"
            sub={txnDateFilter ? 'on selected date' : `${selectedAgentStats?.todayCount || 0} today`}
          />
          <KpiTile
            icon={<TrendingUp className="h-4 w-4" />}
            label="Volume Total"
            value={`${formatUGX(floatConsumedTotal)} / ${formatUGX(disbursedFloatTotal)}`}
            tone="primary"
            sub={
              txnDateFilter
                ? `${formatUGX(visibleVolume)} used on selected date`
                : disbursedFloatTotal > 0
                  ? `${Math.min(100, Math.round((floatConsumedTotal / disbursedFloatTotal) * 100))}% of disbursed float consumed (incl. telecom)`
                  : 'No float disbursed yet'
            }
            hint={txnDateFilter ? 'volume on selected date' : 'Tap to view daily volume'}
            onClick={txnDateFilter ? undefined : () => setBreakdownOpen(true)}
          />
        </div>
        {/* Date filter — scopes Commission Earned & Telecom Charges to a single day */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[160px]">
            <DateFilterPicker
              value={txnDateFilter}
              onChange={setTxnDateFilter}
              label="Filter by date"
            />
          </div>
          {txnDateFilter && (
            <Button variant="ghost" size="sm" className="h-9 text-xs" onClick={() => setTxnDateFilter('')}>
              <XCircle className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          )}
          <Badge variant="outline" className="text-[10px] shrink-0">
            {txnDateFilter ? `${visiblePayouts.length} payout${visiblePayouts.length === 1 ? '' : 's'} on date` : 'All dates'}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            className="h-9 text-xs"
            onClick={exportReportPdf}
            disabled={visiblePayouts.length === 0}
          >
            <Download className="h-3.5 w-3.5 mr-1" /> Export PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 text-xs"
            onClick={exportReportXlsx}
            disabled={visiblePayouts.length === 0}
          >
            <Download className="h-3.5 w-3.5 mr-1" /> Export Excel
          </Button>
        </div>

        <MerchantAgentFloatCard agentId={selectedAgent.agent_id} />

        <div className="grid grid-cols-2 gap-2">
          <KpiTile
            icon={<Wallet className="h-4 w-4" />}
            label="Commission Earned"
            value={formatUGX(commissionSummary.credited)}
            tone="primary"
            sub={commissionSummary.missingCount > 0
              ? `${formatUGX(commissionSummary.expected)} expected · ${commissionSummary.missingCount} unpaid`
              : txnDateFilter ? `0.5% per payout · on selected date` : `0.5% per payout · fully credited`}
          />
          <KpiTile
            icon={<Banknote className="h-4 w-4" />}
            label="Telecom Charges"
            value={formatUGX(visiblePayouts.reduce((s: number, py: any) => s + getTelecomSendingCharge(Number(py.amount || 0)), 0))}
            tone="muted"
            sub={txnDateFilter ? 'sending fees · on date' : 'sending fees'}
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <KpiTile icon={<Smartphone className="h-4 w-4" />} label="MoMo" value={formatUGX(methodTiles.momo)} tone="muted" sub={`${methodTiles.momoCount}`} compact />
          <KpiTile icon={<Building2 className="h-4 w-4" />} label="Bank" value={formatUGX(methodTiles.bank)} tone="muted" sub={`${methodTiles.bankCount}`} compact />
          <KpiTile icon={<Banknote className="h-4 w-4" />} label="Cash" value={formatUGX(methodTiles.cash)} tone="muted" sub={`${methodTiles.cashCount}`} compact />
        </div>

        <Tabs defaultValue="transactions">
          <TabsList className="w-full grid grid-cols-2 h-auto p-1">
            <TabsTrigger value="transactions" className="text-xs py-2">Payouts Processed</TabsTrigger>
            <TabsTrigger value="profile" className="text-xs py-2">Profile & Capabilities</TabsTrigger>
          </TabsList>

          <TabsContent value="transactions" className="space-y-2 mt-3">
            {/* Date filter — narrow the payouts list to a single day */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative flex-1 min-w-[160px]">
                <DateFilterPicker
                  value={txnDateFilter}
                  onChange={setTxnDateFilter}
                  label="Filter by date"
                />
              </div>
              {txnDateFilter && (
                <Button variant="ghost" size="sm" className="h-9 text-xs" onClick={() => setTxnDateFilter('')}>
                  <XCircle className="h-3.5 w-3.5 mr-1" /> Clear
                </Button>
              )}
              <Badge variant="outline" className="text-[10px] shrink-0">
                {visiblePayouts.length} payout{visiblePayouts.length === 1 ? '' : 's'}
              </Badge>
            </div>
            {visiblePayouts.length === 0 ? (
              <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
                {txnDateFilter ? 'No payouts on the selected date' : 'No completed payouts yet'}
              </CardContent></Card>
            ) : (
              visiblePayouts.map((py: any) => {
                const isDup = duplicatePayouts.flaggedIds.has(String(py.id));
                return (
              <Card key={py.id} className={`cursor-pointer hover:bg-muted/40 transition-colors${isDup ? ' border-destructive/50 bg-destructive/5' : ''}`} onClick={() => setCommentClaim(py)}>
                  <CardContent className="p-3 space-y-1.5">
                    {isDup && (
                      <Badge variant="destructive" className="text-[10px] gap-1">
                        <FileWarning className="h-2.5 w-2.5" /> Possible duplicate
                      </Badge>
                    )}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm truncate">{py.beneficiary_name || py.mobile_money_name || 'Beneficiary'}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{py.beneficiary_phone || py.mobile_money_number || '—'}</p>
                      </div>
                      <p className="font-bold text-sm shrink-0">{formatUGX(py.amount)}</p>
                    </div>
                   <div className="flex items-center justify-between gap-2 flex-wrap">
                     {(commissionByWithdrawal as Record<string, number>)[String(py.id)] === undefined ? (
                       <Badge variant="outline" className="text-[10px] gap-1 border-destructive/40 text-destructive">
                         Commission not credited (expected +{formatUGX(getCashoutCommission(Number(py.amount || 0)))})
                       </Badge>
                     ) : (
                       <Badge variant="outline" className="text-[10px] gap-1 border-emerald-500/40 text-emerald-600">
                         Commission: +{formatUGX((commissionByWithdrawal as Record<string, number>)[String(py.id)])}
                       </Badge>
                     )}
                    <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/40 text-amber-600">
                      Telecom charge: {formatUGX(getTelecomSendingCharge(Number(py.amount || 0)))}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <Badge variant="outline" className="text-[10px] gap-1">
                      Net paid: {formatUGX(Number(py.amount || 0))}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] gap-1">
                      Charge bearer: Company
                    </Badge>
                  </div>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge variant="secondary" className="text-[10px] gap-1">
                          {isBank(py.payout_method) ? <Building2 className="h-2.5 w-2.5" /> :
                           isMomo(py.payout_method) ? <Smartphone className="h-2.5 w-2.5" /> :
                           <Banknote className="h-2.5 w-2.5" />}
                          {py.payout_method?.replace(/_/g, ' ') || 'cash'}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] gap-1">
                          <CheckCircle2 className="h-2.5 w-2.5" /> {py.status}
                        </Badge>
                      </div>
                      <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
                        <Clock className="h-2.5 w-2.5" /> {formatDateTime(py.processed_at || py.created_at)}
                      </span>
                    </div>
                    {py.fin_ops_reference && (
                      <p className="text-[10px] text-muted-foreground font-mono truncate">Ref: {py.fin_ops_reference}</p>
                    )}
                    {(() => {
                      const c: CashoutClaimComment | undefined = (latestClaimComments as Record<string, CashoutClaimComment> | undefined)?.[py.id];
                      return (
                        <p className="text-[10px] flex items-start gap-1 text-foreground/70 border-t border-border/60 pt-1.5">
                          <MessageSquare className="h-3 w-3 text-primary shrink-0 mt-0.5" />
                          {c ? (
                            <span className="min-w-0 truncate">
                              {c.comment} <span className="text-muted-foreground">— {c.author_name || 'Officer'}{c.status ? ` · ${c.status}` : ''}</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Tap to add a comment</span>
                          )}
                        </p>
                      );
                    })()}
                  </CardContent>
                </Card>
                );
              })
            )}
          </TabsContent>

          <TabsContent value="profile" className="space-y-3 mt-3">
            <Card>
              <CardContent className="p-3 space-y-3">
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Status & Capabilities</p>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge variant={p.verified ? 'default' : 'secondary'} className="text-[10px]">{p.verified ? '✅ Verified' : '⏳ Unverified'}</Badge>
                    {p.is_frozen && <Badge variant="destructive" className="text-[10px]">🔒 Frozen</Badge>}
                    <Badge variant="outline" className="text-[10px]">Merchant Agent</Badge>
                    {handlesMomoAny && <Badge variant="outline" className="text-[10px] gap-1"><Smartphone className="h-3 w-3" />MoMo Enabled</Badge>}
                    {selectedAgent.handles_bank && <Badge variant="outline" className="text-[10px] gap-1"><Building2 className="h-3 w-3" />Bank Enabled</Badge>}
                    {selectedAgent.handles_cash && <Badge variant="outline" className="text-[10px] gap-1"><Banknote className="h-3 w-3" />Cash Enabled</Badge>}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Contact</p>
                  <DetailRow icon={<Phone className="h-3.5 w-3.5" />} label="Phone" value={p.phone} />
                  <DetailRow icon={<Mail className="h-3.5 w-3.5" />} label="Email" value={p.email} />
                  <DetailRow icon={<MapPin className="h-3.5 w-3.5" />} label="Location" value={[p.city, p.country].filter(Boolean).join(', ')} />
                  {p.territory && <DetailRow icon={<MapPin className="h-3.5 w-3.5" />} label="Territory" value={p.territory} />}
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Financial</p>
                  <DetailRow icon={<CreditCard className="h-3.5 w-3.5" />} label="MoMo" value={p.mobile_money_number ? `${p.mobile_money_provider || ''} ${p.mobile_money_number}`.trim() : null} />
                  <DetailRow icon={<Shield className="h-3.5 w-3.5" />} label="National ID" value={p.national_id} />
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Activity</p>
                  <DetailRow icon={<Calendar className="h-3.5 w-3.5" />} label="Joined" value={formatDate(p.created_at)} />
                  <DetailRow icon={<Activity className="h-3.5 w-3.5" />} label="Last Payout" value={formatDateTime(selectedAgentStats?.lastAt || null)} />
                  <DetailRow icon={<Calendar className="h-3.5 w-3.5" />} label="Onboarded" value={formatDate(selectedAgent.created_at)} />
                </div>
                {p.is_frozen && p.frozen_reason && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
                    <p className="text-xs font-semibold text-destructive">Frozen Reason</p>
                    <p className="text-sm text-destructive/80">{p.frozen_reason}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Merchant Agent Agreement — acceptance record + downloadable PDF */}
            {(() => {
              const agreement = agreementByAgentId.get(selectedAgent.agent_id);
              return (
                <Card>
                  <CardContent className="p-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <FileCheck className="h-3.5 w-3.5" /> Merchant Agent Agreement
                      </p>
                      {agreement ? (
                        <Badge variant="outline" className="text-[10px] gap-1 border-emerald-500/40 text-emerald-600">
                          <CheckCircle2 className="h-3 w-3" /> Signed {agreement.agreement_version}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/40 text-amber-600">
                          <FileWarning className="h-3 w-3" /> Not signed
                        </Badge>
                      )}
                    </div>
                    {agreement ? (
                      <div className="space-y-1.5">
                        <DetailRow icon={<Calendar className="h-3.5 w-3.5" />} label="Accepted" value={formatDateTime(agreement.accepted_at)} />
                        <DetailRow icon={<Users className="h-3.5 w-3.5" />} label="Signed as" value={agreement.merchant_name || p.full_name} />
                        <DetailRow icon={<Phone className="h-3.5 w-3.5" />} label="Phone" value={agreement.merchant_phone || p.phone} />
                        <DetailRow icon={<Globe className="h-3.5 w-3.5" />} label="IP address" value={agreement.ip_address} />
                        <DetailRow icon={<Monitor className="h-3.5 w-3.5" />} label="Device" value={agreement.device_info} />
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        This merchant has not yet accepted the current Merchant Agent Agreement. They will be prompted to accept it before processing payouts.
                      </p>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full gap-1.5"
                      onClick={() => downloadMerchantAgreementPdf({ name: agreement?.merchant_name || p.full_name, phone: agreement?.merchant_phone || p.phone })}
                    >
                      <Download className="h-4 w-4" /> Download Agreement PDF
                    </Button>
                  </CardContent>
                </Card>
              );
            })()}

            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={() => setCashoutAgent(selectedAgent)}>
                <Wallet className="h-4 w-4" /> Active Queue
              </Button>
              <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={() => openEdit(selectedAgent)}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
              <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={() => { deactivateMutation.mutate(selectedAgent.id); setSelectedAgent(null); }}>
                <XCircle className="h-4 w-4" /> Deactivate
              </Button>
              <Button variant="destructive" size="sm" className="flex-1 gap-1.5" onClick={() => setDeleteAgent(selectedAgent)}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        <CashoutPendingWithdrawalsDialog open={!!cashoutAgent} onOpenChange={v => { if (!v) setCashoutAgent(null); }} agent={cashoutAgent} />

        {/* Edit dialog (also reachable from drill-down) */}
        <EditMerchantDialog
          editAgent={editAgent}
          setEditAgent={setEditAgent}
          editLabel={editLabel}
          setEditLabel={setEditLabel}
          editConfig={editConfig}
          setEditConfig={setEditConfig}
          isPending={updateMutation.isPending}
          onSave={() => updateMutation.mutate()}
        />

        <DeleteMerchantConfirm
          deleteAgent={deleteAgent}
          setDeleteAgent={setDeleteAgent}
          isPending={deleteMutation.isPending}
          onConfirm={() => deleteAgent && deleteMutation.mutate(deleteAgent)}
          pendingInfo={deleteAgent ? pendingByAgent.get(deleteAgent.id) || null : null}
          isReleasing={releaseClaimsMutation.isPending}
          onRelease={() => deleteAgent && releaseClaimsMutation.mutate(deleteAgent)}
        />

        <ClaimCommentDialog claim={commentClaim} onClose={() => setCommentClaim(null)} />

        {/* Float Given Out Per Day — drill-down from the Volume Total card */}
        <Dialog open={breakdownOpen} onOpenChange={setBreakdownOpen}>
          <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto p-0 gap-0">
            <DialogHeader className="p-4 pb-3 border-b sticky top-0 bg-background z-10">
              <DialogTitle className="flex items-center gap-2 text-base">
                <Calendar className="h-4 w-4 text-primary" /> Float Given Out Per Day
              </DialogTitle>
              <div className="flex items-center justify-between gap-2 pt-1">
                <p className="text-xs text-muted-foreground">
                  {selectedAgent?.label || 'Merchant Agent'}
                  {selectedAgent?.territory ? ` · ${selectedAgent.territory}` : ''}
                </p>
                <p className="text-sm font-bold text-primary tabular-nums">
                  {formatUGX(selectedAgentStats?.volume || 0)}
                </p>
              </div>
            </DialogHeader>

            <div className="p-3 space-y-2">
              {dailyPayoutBreakdown.length === 0 ? (
                <div className="py-12 text-center">
                  <Inbox className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
                  <p className="text-sm font-medium">No float issued</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    No float has been issued during the selected period.
                  </p>
                </div>
              ) : (
                dailyPayoutBreakdown.map((row) => {
                  const isOpen = expandedDays.has(row.day);
                  const dayPayouts = payoutsByDay.get(row.day) || [];
                  return (
                    <div key={row.day} className="rounded-lg border border-border/60 overflow-hidden">
                      <button
                        onClick={() => toggleDay(row.day)}
                        className="w-full flex items-center justify-between gap-2 p-3 text-left transition-colors hover:bg-muted/50"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {isOpen
                            ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                            : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                          <div className="min-w-0">
                            <p className="text-sm font-semibold truncate">{formatDate(row.day)}</p>
                            <p className="text-[10px] text-muted-foreground">{row.count} payout{row.count > 1 ? 's' : ''}</p>
                          </div>
                        </div>
                        <p className="text-sm font-bold shrink-0 tabular-nums">{formatUGX(row.amount)}</p>
                      </button>

                      {isOpen && (
                        <div className="divide-y divide-border/60 border-t border-border/60 bg-muted/20">
                          {dayPayouts.map((py: any) => (
                            <div key={py.id} className="p-3 space-y-1.5">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="text-sm font-medium truncate">
                                    {py.beneficiary_name || py.mobile_money_name || 'Beneficiary'}
                                  </p>
                                  <p className="text-[11px] text-muted-foreground truncate">
                                    {py.beneficiary_phone || py.mobile_money_number || '—'}
                                  </p>
                                </div>
                                <p className="text-sm font-bold shrink-0 tabular-nums">{formatUGX(py.amount)}</p>
                              </div>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <Badge variant="secondary" className="text-[10px] gap-1">
                                  {isBank(py.payout_method) ? <Building2 className="h-2.5 w-2.5" /> :
                                   isMomo(py.payout_method) ? <Smartphone className="h-2.5 w-2.5" /> :
                                   <Banknote className="h-2.5 w-2.5" />}
                                  {py.payout_method?.replace(/_/g, ' ') || 'cash'}
                                </Badge>
                                <Badge variant="outline" className="text-[10px] gap-1">
                                  <CheckCircle2 className="h-2.5 w-2.5" /> {py.status}
                                </Badge>
                                <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
                                  <Clock className="h-2.5 w-2.5" /> {formatDateTime(py.processed_at || py.created_at)}
                                </span>
                              </div>
                              {py.fin_ops_reference && (
                                <p className="text-[10px] text-muted-foreground font-mono truncate inline-flex items-center gap-1">
                                  <Hash className="h-2.5 w-2.5 shrink-0" /> {py.fin_ops_reference}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ============ MAIN VIEW ============
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Network className="h-5 w-5 text-primary" />
            Merchant Agents
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5 max-w-md">
            Execution network for <span className="font-semibold text-foreground">Financial Ops</span>. Merchant Agents process user withdrawal payouts across <span className="font-semibold text-foreground">Mobile Money, Bank, and Cash</span>.
          </p>
        </div>
        <Dialog open={showAssign} onOpenChange={v => { setShowAssign(v); if (!v) setPickedAgent(null); }}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5 shrink-0"><UserPlus className="h-4 w-4" /> Add Merchant</Button>
          </DialogTrigger>
          <DialogContent className="max-w-sm overflow-visible" onInteractOutside={e => e.preventDefault()} onPointerDownOutside={e => e.preventDefault()}>
            <DialogHeader><DialogTitle>Onboard Merchant Agent</DialogTitle></DialogHeader>
            <p className="text-xs text-muted-foreground">
              This agent joins the <span className="font-semibold">payout execution network</span>, authorised to fulfil user withdrawals across the methods you enable below.
            </p>
            <div className="space-y-3">
              <UserSearchPicker label="Search Agent" placeholder="Search agent by name or phone..." selectedUser={pickedAgent} onSelect={setPickedAgent} roleFilter="agent" />
              <div>
                <Label>Label / Cluster</Label>
                <Input placeholder="e.g. Kampala CBD · Branch 02" value={label} onChange={e => setLabel(e.target.value)} />
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-2.5 space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Payout Capabilities</p>
                <div className="flex items-center justify-between">
                  <Label className="text-sm flex items-center gap-1.5"><Smartphone className="h-3.5 w-3.5" />Mobile Money</Label>
                  <Switch checked={handlesMomo} onCheckedChange={setHandlesMomo} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5" />Bank Transfer</Label>
                  <Switch checked={handlesBank} onCheckedChange={setHandlesBank} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm flex items-center gap-1.5"><Banknote className="h-3.5 w-3.5" />Cash Payout</Label>
                  <Switch checked={handlesCash} onCheckedChange={setHandlesCash} />
                </div>
              </div>
              <Button className="w-full" onClick={() => assignMutation.mutate()} disabled={assignMutation.isPending || !pickedAgent || (!handlesCash && !handlesBank && !handlesMomo)}>
                {assignMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Activate Merchant Agent
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Top KPIs */}
      {/* Global date filter — scopes every stat/KPI below for ALL merchant agents */}
      <div className="rounded-2xl border border-border bg-card p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5" /> Payout Period
          </p>
          <span className="text-[10px] font-medium text-primary">{dateFilterLabel}</span>
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 pb-0.5">
          <FilterChip active={datePreset === 'all'} onClick={() => setDatePreset('all')}>All time</FilterChip>
          <FilterChip active={datePreset === 'today'} onClick={() => setDatePreset('today')}>Today</FilterChip>
          <FilterChip active={datePreset === '7d'} onClick={() => setDatePreset('7d')}>7 days</FilterChip>
          <FilterChip active={datePreset === '30d'} onClick={() => setDatePreset('30d')}>30 days</FilterChip>
          <FilterChip active={datePreset === 'custom'} onClick={() => setDatePreset('custom')}>Custom</FilterChip>
        </div>
        {datePreset === 'custom' && (
          <div className="flex items-center gap-2 pt-0.5">
            <div className="flex-1">
              <Label className="text-[10px] text-muted-foreground">From</Label>
              <Input type="date" value={customFrom} max={customTo || undefined} onChange={e => setCustomFrom(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="flex-1">
              <Label className="text-[10px] text-muted-foreground">To</Label>
              <Input type="date" value={customTo} min={customFrom || undefined} onChange={e => setCustomTo(e.target.value)} className="h-8 text-xs" />
            </div>
          </div>
        )}
      </div>

      {/* Top KPIs */}
      <div className="grid grid-cols-2 gap-2">
        <KpiTile icon={<Users className="h-4 w-4" />} label="Total Merchants" value={String(kpis.agentsCount)} tone="primary" sub={`${kpis.activeToday} active today`} />
        <KpiTile icon={<TrendingUp className="h-4 w-4" />} label="Total Processed" value={formatUGX(kpis.totalPaid)} tone="primary" sub={`${kpis.payoutsCount} payouts`} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <KpiTile icon={<CheckCircle2 className="h-4 w-4" />} label="Completed Today" value={String(kpis.todayCount)} tone="muted" />
        <KpiTile icon={<Clock className="h-4 w-4" />} label="Active Claims" value={String(kpis.pendingClaims)} tone="muted" sub="in queue" />
      </div>
      <div className="grid grid-cols-1 gap-2">
        <KpiTile icon={<Banknote className="h-4 w-4" />} label="Total Withdrawal Charges" value={formatUGX(kpis.chargesTotal)} tone="muted" sub="Bearer: Company · auto-computed" />
      </div>

      {/* Method breakdown */}
      <div className="rounded-2xl border border-border bg-card p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Execution by Method</p>
        <div className="grid grid-cols-3 gap-2">
          <MethodTile icon={<Smartphone className="h-4 w-4" />} label="Mobile Money" amount={kpis.momoAmount} count={kpis.momoCount} total={kpis.totalPaid} onClick={() => setMethodDetail('momo')} />
          <MethodTile icon={<Building2 className="h-4 w-4" />} label="Bank" amount={kpis.bankAmount} count={kpis.bankCount} total={kpis.totalPaid} onClick={() => setMethodDetail('bank')} />
          <MethodTile icon={<Banknote className="h-4 w-4" />} label="Cash" amount={kpis.cashAmount} count={kpis.cashCount} total={kpis.totalPaid} onClick={() => setMethodDetail('cash')} />
        </div>
      </div>

      {/* Search + filters */}
      {agents.length > 0 && (
        <div className="space-y-2">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search merchant by name, phone or cluster..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-9 text-sm" />
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 pb-1">
            <FilterChip active={methodFilter === 'all'} onClick={() => setMethodFilter('all')}>All Methods</FilterChip>
            <FilterChip active={methodFilter === 'momo'} onClick={() => setMethodFilter('momo')}><Smartphone className="h-3 w-3" />MoMo</FilterChip>
            <FilterChip active={methodFilter === 'bank'} onClick={() => setMethodFilter('bank')}><Building2 className="h-3 w-3" />Bank</FilterChip>
            <FilterChip active={methodFilter === 'cash'} onClick={() => setMethodFilter('cash')}><Banknote className="h-3 w-3" />Cash</FilterChip>
            <span className="h-4 w-px bg-border mx-1 shrink-0" />
            <FilterChip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>All</FilterChip>
            <FilterChip active={statusFilter === 'active'} onClick={() => setStatusFilter('active')}><Activity className="h-3 w-3" />Active</FilterChip>
            <FilterChip active={statusFilter === 'idle'} onClick={() => setStatusFilter('idle')}>Idle 7d+</FilterChip>
          </div>
        </div>
      )}

      {/* Agent List */}
      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : filteredAgents.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">
          <Network className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
          {agents.length === 0 ? 'No Merchant Agents onboarded. Add agents to execute payouts across MoMo, Bank, and Cash.' : 'No merchants match your filters.'}
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {filteredAgents.map((a: any) => {
            const stats = agentStats.get(a.id) || { count: 0, volume: 0, lastAt: null, todayCount: 0 } as any;
            const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
            const isRecent = stats.lastAt && new Date(stats.lastAt).getTime() > sevenDaysAgo;
            const pending = pendingByAgent.get(a.id);
            return (
              <Card key={a.id} className="hover:bg-muted/40 active:bg-muted transition-colors cursor-pointer" onClick={() => setSelectedAgent(a)}>
                <CardContent className="p-3 flex items-center gap-3">
                  <div className="relative shrink-0">
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
                      {(a.profiles?.full_name || 'A').charAt(0).toUpperCase()}
                    </div>
                    {isRecent && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-success border-2 border-card" title="Active in last 7 days" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-sm truncate">{a.profiles?.full_name || 'Merchant Agent'}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{a.profiles?.phone} · {a.label || 'Merchant Agent'}</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {methodBadges(a)}
                      {agreementByAgentId.get(a.agent_id) ? (
                        <Badge variant="outline" className="text-[9px] h-4 px-1 gap-0.5 border-emerald-500/40 text-emerald-600" title="Merchant Agreement signed">
                          <FileCheck className="h-2.5 w-2.5" /> Signed
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[9px] h-4 px-1 gap-0.5 border-amber-500/40 text-amber-600" title="Merchant Agreement not signed yet">
                          <FileWarning className="h-2.5 w-2.5" /> No agreement
                        </Badge>
                      )}
                      {pending && pending.count > 0 && (
                        <Badge variant="destructive" className="text-[9px] h-4 px-1 gap-0.5" title={`${pending.count} active claim${pending.count === 1 ? '' : 's'} in queue — blocks deletion`}>
                          <Clock className="h-2.5 w-2.5" />
                          {pending.count} in queue
                        </Badge>
                      )}
                      {(() => {
                        const dups = duplicateByAgent.get(a.id);
                        return dups ? (
                          <Badge variant="destructive" className="text-[9px] h-4 px-1 gap-0.5" title={`${dups} beneficiary paid the same amount more than once — possible duplicate payouts`}>
                            <FileWarning className="h-2.5 w-2.5" />
                            {dups} duplicate{dups === 1 ? '' : 's'}
                          </Badge>
                        ) : null;
                      })()}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-sm">{formatUGX(stats.volume)}</p>
                    <p className="text-[10px] text-muted-foreground">{stats.count} payout{stats.count !== 1 ? 's' : ''}</p>
                    {stats.todayCount > 0 && <p className="text-[10px] text-success font-medium">+{stats.todayCount} today</p>}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={(e) => { e.stopPropagation(); openEdit(a); }}
                    title="Edit Merchant Agent"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); setDeleteAgent(a); }}
                    title="Delete Merchant Agent"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <CashoutPendingWithdrawalsDialog open={!!cashoutAgent} onOpenChange={v => { if (!v) setCashoutAgent(null); }} agent={cashoutAgent} />

      <EditMerchantDialog
        editAgent={editAgent}
        setEditAgent={setEditAgent}
        editLabel={editLabel}
        setEditLabel={setEditLabel}
        editConfig={editConfig}
        setEditConfig={setEditConfig}
        isPending={updateMutation.isPending}
        onSave={() => updateMutation.mutate()}
      />

      <DeleteMerchantConfirm
        deleteAgent={deleteAgent}
        setDeleteAgent={setDeleteAgent}
        isPending={deleteMutation.isPending}
        onConfirm={() => deleteAgent && deleteMutation.mutate(deleteAgent)}
        pendingInfo={deleteAgent ? pendingByAgent.get(deleteAgent.id) || null : null}
        isReleasing={releaseClaimsMutation.isPending}
        onRelease={() => deleteAgent && releaseClaimsMutation.mutate(deleteAgent)}
      />

      <MethodDetailSheet
        method={methodDetail}
        onOpenChange={(open) => { if (!open) setMethodDetail(null); }}
        payouts={payouts as any[]}
        agents={agents as any[]}
      />
    </div>
  );
}

function KpiTile({ icon, label, value, sub, tone = 'muted', compact = false, onClick, hint }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: 'primary' | 'muted'; compact?: boolean; onClick?: () => void; hint?: string }) {
  const interactive = typeof onClick === 'function';
  return (
    <Card
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!(); } } : undefined}
      className={`${tone === 'primary' ? 'bg-primary/5' : ''}${interactive ? ' cursor-pointer transition-all duration-200 hover:bg-primary/10 hover:shadow-md hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50' : ''}`}
    >
      <CardContent className={compact ? 'p-2.5' : 'p-3'}>
        <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
          <span className={tone === 'primary' ? 'text-primary' : ''}>{icon}</span>
          <span className="text-[10px] font-medium uppercase tracking-wider truncate">{label}</span>
        </div>
        <p className={`font-bold tabular-nums truncate ${compact ? 'text-xs' : 'text-sm'}`}>{value}</p>
        {sub && <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{sub}</p>}
        {hint && (
          <p className="text-[10px] font-medium text-primary mt-1 inline-flex items-center gap-0.5">
            {hint} <ChevronRight className="h-3 w-3" />
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function MethodTile({ icon, label, amount, count, total, onClick }: { icon: React.ReactNode; label: string; amount: number; count: number; total: number; onClick?: () => void }) {
  const pct = total > 0 ? Math.round((amount / total) * 100) : 0;
  const interactive = typeof onClick === 'function';
  return (
    <div
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!(); } } : undefined}
      className={`rounded-xl border border-border/60 bg-background p-2.5 ${interactive ? 'cursor-pointer transition-all duration-200 hover:bg-primary/5 hover:border-primary/40 hover:-translate-y-0.5 active:translate-y-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50' : ''}`}
    >
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
        <span className="text-primary">{icon}</span>
        <span className="text-[10px] font-medium uppercase tracking-wider truncate">{label}</span>
      </div>
      <p className="font-bold text-xs tabular-nums truncate">{formatUGX(amount)}</p>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] text-muted-foreground">{count} payout{count !== 1 ? 's' : ''}</span>
        <span className="text-[10px] font-semibold text-primary">{pct}%</span>
      </div>
      <div className="mt-1 h-1 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      {interactive && (
        <p className="text-[10px] font-medium text-primary mt-1.5 inline-flex items-center gap-0.5">
          Tap for details <ChevronRight className="h-3 w-3" />
        </p>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-medium px-2.5 h-7 rounded-full border transition-colors ${
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-background text-muted-foreground border-border hover:bg-muted'
      }`}
    >
      {children}
    </button>
  );
}

function DetailRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-muted-foreground min-w-[80px] text-xs">{label}:</span>
      <span className="font-medium truncate text-xs">{value || '—'}</span>
    </div>
  );
}

function EditMerchantDialog({
  editAgent, setEditAgent,
  editLabel, setEditLabel,
  editConfig, setEditConfig,
  isPending, onSave,
}: {
  editAgent: any; setEditAgent: (v: any) => void;
  editLabel: string; setEditLabel: (v: string) => void;
  editConfig: CashoutAgentConfig; setEditConfig: (v: CashoutAgentConfig) => void;
  isPending: boolean; onSave: () => void;
}) {
  const c = editConfig;
  const set = (patch: Partial<CashoutAgentConfig>) => setEditConfig({ ...c, ...patch });
  const noChannel = !c.channels.cash && !c.channels.bank && !c.channels.momo;
  const enabledCount = Object.values(c.categories).filter(Boolean).length;
  const noCategory = enabledCount === 0;

  const numOrNull = (v: string): number | null => {
    const n = Number(v.replace(/[^\d]/g, ''));
    return v.trim() === '' || Number.isNaN(n) ? null : n;
  };

  return (
    <Dialog open={!!editAgent} onOpenChange={v => { if (!v) setEditAgent(null); }}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] overflow-y-auto"
        onInteractOutside={e => e.preventDefault()}
        onPointerDownOutside={e => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Edit Cash-Out Agent</DialogTitle>
        </DialogHeader>
        {editAgent && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Updating <span className="font-semibold text-foreground">{editAgent.profiles?.full_name || 'this merchant'}</span>.
              Changes apply immediately to their payout routing permissions.
            </p>

            <Accordion type="multiple" defaultValue={['general', 'channels', 'categories']} className="w-full">
              {/* GENERAL */}
              <AccordionItem value="general">
                <AccordionTrigger className="text-sm font-semibold">General</AccordionTrigger>
                <AccordionContent className="space-y-3">
                  <div>
                    <Label className="text-xs">Label / Cluster</Label>
                    <Input
                      placeholder="e.g. Kampala CBD · Branch 02"
                      value={editLabel}
                      onChange={e => setEditLabel(e.target.value)}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Region</Label>
                      <Input value={c.ops.region} onChange={e => set({ ops: { ...c.ops, region: e.target.value } })} />
                    </div>
                    <div>
                      <Label className="text-xs">District</Label>
                      <Input value={c.ops.district} onChange={e => set({ ops: { ...c.ops, district: e.target.value } })} />
                    </div>
                    <div>
                      <Label className="text-xs">Branch</Label>
                      <Input value={c.ops.branch} onChange={e => set({ ops: { ...c.ops, branch: e.target.value } })} />
                    </div>
                    <div>
                      <Label className="text-xs">Cluster</Label>
                      <Input value={c.ops.cluster} onChange={e => set({ ops: { ...c.ops, cluster: e.target.value } })} />
                    </div>
                    <div>
                      <Label className="text-xs">Supervisor</Label>
                      <Input value={c.ops.supervisor} onChange={e => set({ ops: { ...c.ops, supervisor: e.target.value } })} />
                    </div>
                    <div>
                      <Label className="text-xs">Operations Team</Label>
                      <Input value={c.ops.team} onChange={e => set({ ops: { ...c.ops, team: e.target.value } })} />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs mb-1.5 block">Agent Status</Label>
                    <RadioGroup
                      className="grid grid-cols-3 gap-2"
                      value={c.status}
                      onValueChange={(v) => set({ status: v as CashoutAgentConfig['status'] })}
                    >
                      {AGENT_STATUSES.map(s => (
                        <label key={s.value} className="flex items-center gap-1.5 text-xs cursor-pointer rounded-md border border-border p-2 hover:bg-muted/40">
                          <RadioGroupItem value={s.value} /> {s.label}
                        </label>
                      ))}
                    </RadioGroup>
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* PAYMENT CHANNELS */}
              <AccordionItem value="channels">
                <AccordionTrigger className="text-sm font-semibold">Payment Channels</AccordionTrigger>
                <AccordionContent className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm flex items-center gap-1.5"><Smartphone className="h-3.5 w-3.5" />Mobile Money</Label>
                    <Switch checked={c.channels.momo} onCheckedChange={v => set({ channels: { ...c.channels, momo: v } })} />
                  </div>
                  {c.channels.momo && (
                    <div className="ml-5 flex gap-4 pb-1">
                      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                        <Checkbox checked={c.networks.mtn} onCheckedChange={v => set({ networks: { ...c.networks, mtn: !!v } })} /> MTN
                      </label>
                      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                        <Checkbox checked={c.networks.airtel} onCheckedChange={v => set({ networks: { ...c.networks, airtel: !!v } })} /> Airtel
                      </label>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <Label className="text-sm flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5" />Bank Transfer</Label>
                    <Switch checked={c.channels.bank} onCheckedChange={v => set({ channels: { ...c.channels, bank: v } })} />
                  </div>
                  {c.channels.bank && (
                    <div className="ml-5 pb-1 space-y-1.5">
                      <div className="flex gap-2">
                        <Button
                          type="button" size="sm" variant="outline" className="h-6 text-[11px]"
                          onClick={() => set({ banks: Object.fromEntries(SUPPORTED_BANKS.map(b => [b.id, true])) })}
                        >All banks</Button>
                        <Button
                          type="button" size="sm" variant="outline" className="h-6 text-[11px]"
                          onClick={() => set({ banks: Object.fromEntries(SUPPORTED_BANKS.map(b => [b.id, false])) })}
                        >None</Button>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                      {SUPPORTED_BANKS.map(b => (
                        <label key={b.id} className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <Checkbox checked={!!c.banks[b.id]} onCheckedChange={v => set({ banks: { ...c.banks, [b.id]: !!v } })} /> {b.label}
                        </label>
                      ))}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <Label className="text-sm flex items-center gap-1.5"><Banknote className="h-3.5 w-3.5" />Cash Payout</Label>
                    <Switch checked={c.channels.cash} onCheckedChange={v => set({ channels: { ...c.channels, cash: v } })} />
                  </div>
                  {noChannel && <p className="text-[11px] text-destructive">Enable at least one channel.</p>}
                </AccordionContent>
              </AccordionItem>

              {/* AUTHORIZED PAYOUT CATEGORIES */}
              <AccordionItem value="categories">
                <AccordionTrigger className="text-sm font-semibold">
                  Authorized Payout Categories
                  <Badge variant="secondary" className="ml-2 text-[10px]">{enabledCount}</Badge>
                </AccordionTrigger>
                <AccordionContent className="space-y-3">
                  <div className="flex gap-2">
                    <Button
                      type="button" size="sm" variant="outline" className="h-7 text-xs"
                      onClick={() => {
                        const all: Record<string, boolean> = {};
                        ALL_PAYOUT_CATEGORIES.forEach(cat => { all[cat.id] = true; });
                        set({ categories: all });
                      }}
                    >Select all</Button>
                    <Button
                      type="button" size="sm" variant="outline" className="h-7 text-xs"
                      onClick={() => {
                        const none: Record<string, boolean> = {};
                        ALL_PAYOUT_CATEGORIES.forEach(cat => { none[cat.id] = false; });
                        set({ categories: none });
                      }}
                    >Clear all</Button>
                  </div>
                  {PAYOUT_CATEGORY_GROUPS.map(group => (
                    <div key={group.group} className="rounded-lg border border-border p-2.5 space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.group}</p>
                      {group.items.map(item => {
                        const on = !!c.categories[item.id];
                        return (
                          <div key={item.id} className="space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <label className="flex items-start gap-2 text-sm cursor-pointer flex-1">
                                <Checkbox
                                  className="mt-0.5"
                                  checked={on}
                                  onCheckedChange={v => set({ categories: { ...c.categories, [item.id]: !!v } })}
                                />
                                <span>
                                  <span className="font-medium">{item.label}</span>
                                  {item.hint && <span className="block text-[11px] text-muted-foreground leading-snug">{item.hint}</span>}
                                </span>
                              </label>
                              {on && (
                                <Select
                                  value={c.approvals[item.id]}
                                  onValueChange={(v) => set({ approvals: { ...c.approvals, [item.id]: v as ApprovalRule } })}
                                >
                                  <SelectTrigger className="h-7 w-[150px] text-[11px] shrink-0"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {APPROVAL_RULES.map(r => (
                                      <SelectItem key={r.value} value={r.value} className="text-xs">{r.label}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {noCategory && <p className="text-[11px] text-destructive">Authorize at least one payout category.</p>}
                </AccordionContent>
              </AccordionItem>

              {/* FLOAT PERMISSIONS */}
              <AccordionItem value="float">
                <AccordionTrigger className="text-sm font-semibold">Float Permissions</AccordionTrigger>
                <AccordionContent className="space-y-2">
                  {([
                    ['request', 'Request Float'],
                    ['receive', 'Receive Float'],
                    ['distribute', 'Distribute Float'],
                    ['emergency', 'Emergency Float'],
                  ] as const).map(([k, lbl]) => (
                    <div key={k} className="flex items-center justify-between">
                      <Label className="text-sm">{lbl}</Label>
                      <Switch checked={c.float[k]} onCheckedChange={v => set({ float: { ...c.float, [k]: v } })} />
                    </div>
                  ))}
                  <div>
                    <Label className="text-xs">Maximum Float (UGX)</Label>
                    <Input
                      inputMode="numeric"
                      value={c.float.max ?? ''}
                      onChange={e => set({ float: { ...c.float, max: numOrNull(e.target.value) } })}
                      placeholder="No limit"
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* TRANSACTION LIMITS */}
              <AccordionItem value="limits">
                <AccordionTrigger className="text-sm font-semibold">Transaction Limits</AccordionTrigger>
                <AccordionContent className="grid grid-cols-2 gap-2">
                  {([
                    ['daily', 'Daily Limit'],
                    ['single', 'Single Transaction'],
                    ['monthly', 'Monthly Limit'],
                    ['maxCashout', 'Maximum Cash-Out'],
                    ['minCashout', 'Minimum Cash-Out'],
                  ] as const).map(([k, lbl]) => (
                    <div key={k}>
                      <Label className="text-xs">{lbl} (UGX)</Label>
                      <Input
                        inputMode="numeric"
                        value={c.limits[k] ?? ''}
                        onChange={e => set({ limits: { ...c.limits, [k]: numOrNull(e.target.value) } })}
                        placeholder="—"
                      />
                    </div>
                  ))}
                </AccordionContent>
              </AccordionItem>

              {/* SECURITY */}
              <AccordionItem value="security">
                <AccordionTrigger className="text-sm font-semibold">Security</AccordionTrigger>
                <AccordionContent className="space-y-2">
                  {([
                    ['otp', 'Require OTP'],
                    ['twoFactor', 'Require 2FA'],
                    ['deviceRestriction', 'Device Restriction'],
                    ['highValueVerification', 'High-Value Verification'],
                  ] as const).map(([k, lbl]) => (
                    <div key={k} className="flex items-center justify-between">
                      <Label className="text-sm">{lbl}</Label>
                      <Switch checked={c.security[k]} onCheckedChange={v => set({ security: { ...c.security, [k]: v } })} />
                    </div>
                  ))}
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <Separator />
            <div className="flex gap-2 sticky bottom-0 bg-background pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setEditAgent(null)}>Cancel</Button>
              <Button className="flex-1" onClick={onSave} disabled={isPending || noChannel || noCategory}>
                {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save Changes
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeleteMerchantConfirm({
  deleteAgent, setDeleteAgent, isPending, onConfirm,
  pendingInfo, isReleasing, onRelease,
}: {
  deleteAgent: any;
  setDeleteAgent: (v: any) => void;
  isPending: boolean;
  onConfirm: () => void;
  pendingInfo: { count: number; ids: string[]; oldestAt: string | null } | null;
  isReleasing: boolean;
  onRelease: () => void;
}) {
  const blocked = !!pendingInfo && pendingInfo.count > 0;
  const oldestDays = pendingInfo?.oldestAt
    ? Math.floor((Date.now() - new Date(pendingInfo.oldestAt).getTime()) / 86400000)
    : 0;
  return (
    <AlertDialog open={!!deleteAgent} onOpenChange={v => { if (!v && !isPending && !isReleasing) setDeleteAgent(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove Merchant Agent role?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the Merchant Agent role from{' '}
            <span className="font-semibold text-foreground">{deleteAgent?.profiles?.full_name || 'this merchant'}</span>.{' '}
            Their account and <span className="font-semibold text-foreground">all their records stay in the system</span> —
            they simply stop being a Merchant Agent and no longer appear in payout routing or assignment.
            You can re-add them as a Merchant Agent later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {blocked && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
            <p className="text-sm font-semibold text-destructive flex items-center gap-1.5">
              <Clock className="h-4 w-4" />
              {pendingInfo!.count} active claim{pendingInfo!.count === 1 ? '' : 's'} blocking removal
            </p>
            <p className="text-xs text-muted-foreground">
              {oldestDays > 0
                ? `Oldest is ${oldestDays} day${oldestDays === 1 ? '' : 's'} old. `
                : ''}
              Release them to return the payout{pendingInfo!.count === 1 ? '' : 's'} to the open pool so any other
              Merchant Agent can pick {pendingInfo!.count === 1 ? 'it' : 'them'} up — then retry removal.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5"
              onClick={onRelease}
              disabled={isReleasing || isPending}
            >
              {isReleasing ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
              Release {pendingInfo!.count} stuck claim{pendingInfo!.count === 1 ? '' : 's'} to open pool
            </Button>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending || isReleasing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); onConfirm(); }}
            disabled={isPending || isReleasing || blocked}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
            Remove role
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MethodDetailSheet({
  method,
  onOpenChange,
  payouts,
  agents,
}: {
  method: null | 'momo' | 'bank' | 'cash';
  onOpenChange: (open: boolean) => void;
  payouts: any[];
  agents: any[];
}) {
  const open = method !== null;
  const matcher = method === 'momo' ? isMomo : method === 'bank' ? isBank : isCash;
  const rows = useMemo(
    () => (method ? payouts.filter((p) => matcher(p.payout_method)) : []),
    [payouts, method, matcher],
  );
  const total = rows.reduce((s, p) => s + Number(p.amount || 0), 0);
  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) {
      m.set(a.id, a.profiles?.full_name || a.label || 'Merchant');
    }
    return m;
  }, [agents]);

  const byAgent = useMemo(() => {
    const m = new Map<string, { name: string; amount: number; count: number }>();
    for (const p of rows) {
      const id = p.assigned_cashout_agent_id;
      if (!id) continue;
      const cur = m.get(id) || { name: agentMap.get(id) || 'Merchant', amount: 0, count: 0 };
      cur.amount += Number(p.amount || 0);
      cur.count += 1;
      m.set(id, cur);
    }
    return Array.from(m.values()).sort((a, b) => b.amount - a.amount);
  }, [rows, agentMap]);

  const recent = useMemo(
    () => [...rows]
      .sort((a, b) => new Date(b.processed_at || b.created_at).getTime() - new Date(a.processed_at || a.created_at).getTime())
      .slice(0, 100),
    [rows],
  );

  const title =
    method === 'momo' ? 'Mobile Money Payouts' :
    method === 'bank' ? 'Bank Payouts' :
    method === 'cash' ? 'Cash Payouts' : '';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85dvh] rounded-t-2xl p-0 flex flex-col">
        <SheetHeader className="p-4 pb-2 shrink-0">
          <SheetTitle className="text-base">{title}</SheetTitle>
        </SheetHeader>

        <div className="mx-4 mb-3 rounded-2xl bg-primary/5 p-3 shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Total volume</p>
              <p className="text-2xl font-black tabular-nums">{formatUGX(total)}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Payouts</p>
              <p className="text-2xl font-black tabular-nums">{rows.length}</p>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="px-4 pb-6 space-y-4">
            {byAgent.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">By Merchant</p>
                <div className="rounded-xl border border-border divide-y divide-border">
                  {byAgent.map((a, i) => (
                    <div key={i} className="flex items-center justify-between px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{a.name}</p>
                        <p className="text-[11px] text-muted-foreground">{a.count} payout{a.count !== 1 ? 's' : ''}</p>
                      </div>
                      <p className="text-sm font-bold tabular-nums">{formatUGX(a.amount)}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Recent transactions {rows.length > recent.length && `(showing ${recent.length} of ${rows.length})`}
              </p>
              {recent.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                  No payouts for this method yet.
                </div>
              ) : (
                <div className="rounded-xl border border-border divide-y divide-border">
                  {recent.map((p) => {
                    const when = p.processed_at || p.created_at;
                    const name = agentMap.get(p.assigned_cashout_agent_id) || 'Merchant';
                    return (
                      <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{name}</p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {p.mobile_money_name || p.mobile_money_number || p.payout_method || '—'}
                            {p.fin_ops_reference ? ` · ${p.fin_ops_reference}` : ''}
                          </p>
                          <p className="text-[10px] text-muted-foreground/70">
                            {when ? new Date(when).toLocaleString('en-UG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                          </p>
                        </div>
                        <p className="text-sm font-bold tabular-nums shrink-0">{formatUGX(Number(p.amount || 0))}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
