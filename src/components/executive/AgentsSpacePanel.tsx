import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import {
  Loader2, Plus, Clock, CheckCircle2, XCircle, HelpCircle, Wallet, Paperclip, Upload,
  ArrowLeft, X, RefreshCw, Search, SendHorizontal, AlertCircle, ShieldCheck, ShieldAlert,
  Lock, Key, LogOut, FileText, Trash2, Calendar
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuth } from '@/hooks/useAuth';

export interface Requisition {
  id: string;
  requisition_code: string;
  requester_id: string;
  requester_name: string | null;
  requester_role: string | null;
  department_id: string | null;
  department_key: string | null;
  title: string;
  amount: number;
  approved_amount: number | null;
  currency: string;
  reason: string;
  category: string | null;
  needed_by: string | null;
  stage: 'supervisor' | 'coo' | 'cfo' | 'ceo' | 'approved' | 'rejected' | 'returned' | string;
  current_approver_role: string | null;
  final_stage: string;
  rejection_reason: string | null;
  supervisor_note: string | null;
  coo_note: string | null;
  cfo_note: string | null;
  wallet_credit_status: string | null;
  credited_at: string | null;
  created_at: string;
  attachment_urls: string[] | null;
}

interface ReqEvent {
  id: string;
  requisition_id: string;
  actor_name: string | null;
  action: string;
  stage: string | null;
  comment: string | null;
  created_at: string;
}

interface ProfileSummary {
  id: string;
  full_name: string | null;
  phone: string | null;
  email?: string | null;
  avatar_url: string | null;
  territory?: string | null;
}

interface StaffPermissionRow {
  id: string;
  user_id: string;
  permitted_dashboard: string;
  granted_by: string | null;
  granted_at: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

const STAGE_LABEL: Record<string, string> = {
  supervisor: 'Agent Ops',
  coo: 'COO',
  cfo: 'CFO',
  ceo: 'CEO',
  approved: 'Approved',
  rejected: 'Declined',
  returned: 'Needs update',
};

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function StatusPill({ row, mode = 'agent' }: { row: Requisition; mode?: 'agent' | 'ops' }) {
  if (row.stage === 'approved') {
    return (
      <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-semibold text-xs">
        <CheckCircle2 className="mr-1 h-3 w-3" /> Approved
      </Badge>
    );
  }
  if (row.stage === 'rejected') {
    return (
      <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive font-semibold text-xs">
        <XCircle className="mr-1 h-3 w-3" /> Declined
      </Badge>
    );
  }
  if (row.stage === 'returned') {
    return (
      <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400 font-semibold text-xs">
        <HelpCircle className="mr-1 h-3 w-3" /> Needs your update
      </Badge>
    );
  }
  // For agent view, do not expose internal approval routing hops
  if (mode === 'agent') {
    return (
      <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 font-semibold text-xs">
        <Clock className="mr-1 h-3 w-3" /> Under review
      </Badge>
    );
  }
  if (row.stage === 'coo') {
    return (
      <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400 font-semibold text-xs">
        <Clock className="mr-1 h-3 w-3" /> Forwarded to COO
      </Badge>
    );
  }
  if (row.stage === 'cfo') {
    return (
      <Badge variant="outline" className="border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400 font-semibold text-xs">
        <Clock className="mr-1 h-3 w-3" /> Forwarded to CFO
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 font-semibold text-xs">
      <Clock className="mr-1 h-3 w-3" /> With {STAGE_LABEL[row.stage] || row.stage}
    </Badge>
  );
}

const AGENTS_SPACE_CATEGORIES = [
  'Salaries',
  'Transport',
  'Food',
  'Office Rent',
  'Internet',
  'Airtime',
  'Stationery',
  'Property & Equipment',
  'Eviction & Enforcement',
  'Financial Agent Requisitions',
  'Others',
] as const;

const EMPTY_FORM = {
  category: '',
  customTitle: '',
  amount: '',
  needed_by: '',
  reason: '',
};

const AGENTS_SPACE_TAG = 'Agents Space';
const AGENTS_SPACE_DASHBOARD_KEY = 'agents-space';

type TabSection = 'pending' | 'approved' | 'rejected' | 'access_control' | 'my_submissions';

interface AgentsSpacePanelProps {
  mode?: 'agent' | 'ops';
  onBack?: () => void;
}

export function AgentsSpacePanel({ mode = 'agent', onBack }: AgentsSpacePanelProps) {
  const { user, signOut } = useAuth();
  const [rows, setRows] = useState<Requisition[]>([]);
  const [profilesMap, setProfilesMap] = useState<Record<string, ProfileSummary>>({});
  const [events, setEvents] = useState<Record<string, ReqEvent[]>>({});
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabSection>('pending');
  const [searchQuery, setSearchQuery] = useState('');

  // Access Control / Permission state (for Ops mode)
  const [authorizedAgents, setAuthorizedAgents] = useState<StaffPermissionRow[]>([]);
  const [authAgentProfiles, setAuthAgentProfiles] = useState<Record<string, ProfileSummary>>({});
  const [loadingPerms, setLoadingPerms] = useState(false);
  const [openAddAgent, setOpenAddAgent] = useState(false);
  const [agentSearchTerm, setAgentSearchTerm] = useState('');
  const [agentSearchResults, setAgentSearchResults] = useState<ProfileSummary[]>([]);
  const [searchingAgents, setSearchingAgents] = useState(false);
  const [togglingAgentId, setTogglingAgentId] = useState<string | null>(null);
  const [deletingPermId, setDeletingPermId] = useState<string | null>(null);

  // Submit / Resubmit modal
  const [openSubmit, setOpenSubmit] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [resubmitId, setResubmitId] = useState<string | null>(null);

  // Approval / Decision modal (for Ops mode)
  const [activeReq, setActiveReq] = useState<Requisition | null>(null);
  const [decisionType, setDecisionType] = useState<'approve' | 'reject' | 'return_info'>('approve');
  const [decisionComment, setDecisionComment] = useState('');
  const [amountOverride, setAmountOverride] = useState('');
  const [acting, setActing] = useState(false);

  // Attachments
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [viewingPath, setViewingPath] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    let q = supabase
      .from('staff_requisitions')
      .select('*')
      .ilike('category', `%${AGENTS_SPACE_TAG}%`)
      .order('created_at', { ascending: false });

    // In agent mode, ONLY fetch the current user's submitted requisitions
    if (mode === 'agent') {
      if (!user?.id) { setLoading(false); return; }
      q = q.eq('requester_id', user.id);
    }

    const { data, error } = await q;

    if (error) {
      toast.error('Could not load requisitions', { description: error.message });
      setLoading(false);
      return;
    }

    const fetchedRows = (data || []) as unknown as Requisition[];
    setRows(fetchedRows);

    if (mode === 'ops') {
      const userIds = [...new Set(fetchedRows.map((r) => r.requester_id).filter(Boolean))];
      if (userIds.length > 0) {
        const { data: pData } = await supabase
          .from('profiles')
          .select('id, full_name, phone, avatar_url, territory')
          .in('id', userIds);
        if (pData) {
          const pMap: Record<string, ProfileSummary> = {};
          pData.forEach((p) => { pMap[p.id] = p; });
          setProfilesMap(pMap);
        }
      }
    }

    setLoading(false);
  }, [mode, user?.id]);

  const fetchPermissions = useCallback(async () => {
    if (mode !== 'ops') return;
    setLoadingPerms(true);
    const { data, error } = await supabase
      .from('staff_permissions')
      .select('*')
      .eq('permitted_dashboard', AGENTS_SPACE_DASHBOARD_KEY)
      .order('granted_at', { ascending: false });

    if (!error && data) {
      const perms = data as unknown as StaffPermissionRow[];
      setAuthorizedAgents(perms);

      const uIds = perms.map((c) => c.user_id).filter(Boolean);
      if (uIds.length > 0) {
        const { data: pData } = await supabase
          .from('profiles')
          .select('id, full_name, phone, email, avatar_url, territory')
          .in('id', uIds);
        if (pData) {
          const map: Record<string, ProfileSummary> = {};
          pData.forEach((p) => { map[p.id] = p; });
          setAuthAgentProfiles(map);
        }
      }
    }
    setLoadingPerms(false);
  }, [mode]);

  useEffect(() => {
    void fetchRows();
    if (mode === 'ops') void fetchPermissions();
  }, [fetchRows, fetchPermissions, mode]);

  // Requisitions polled every 60s (+ on focus); permissions load on mount only.
  // The old Realtime listeners were on staff_requisitions and staff_permissions,
  // neither of which is in the publication, so they never fired (doc 147).
  const { lastUpdatedAt, refresh } = usePolling(() => fetchRows(), 60_000);

  const loadEvents = useCallback(async (id: string) => {
    if (events[id]) return;
    const { data } = await supabase
      .from('staff_requisition_events')
      .select('*')
      .eq('requisition_id', id)
      .order('created_at', { ascending: true });
    setEvents((prev) => ({ ...prev, [id]: (data || []) as unknown as ReqEvent[] }));
  }, [events]);

  // Search agents for granting permission (Ops mode only)
  const handleSearchAgents = async (val: string) => {
    setAgentSearchTerm(val);
    if (!val || val.trim().length < 2) {
      setAgentSearchResults([]);
      return;
    }
    setSearchingAgents(true);
    const s = `%${val.trim()}%`;
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, phone, email, avatar_url, territory')
      .or(`full_name.ilike.${s},phone.ilike.${s},email.ilike.${s}`)
      .limit(10);
    setAgentSearchResults((data || []) as ProfileSummary[]);
    setSearchingAgents(false);
  };

  // Toggle or Grant permission for an agent (Ops mode only)
  const handleTogglePermission = async (agentId: string, enable: boolean) => {
    setTogglingAgentId(agentId);
    const existing = authorizedAgents.find((a) => a.user_id === agentId);

    if (existing) {
      const { error } = await supabase
        .from('staff_permissions')
        .update({
          ...(enable
            ? { revoked_at: null, revoked_by: null, revoke_reason: null, granted_at: new Date().toISOString(), granted_by: user?.id }
            : { revoked_at: new Date().toISOString(), revoked_by: user?.id, revoke_reason: 'Revoked in Agents Space Hub' }),
        })
        .eq('id', existing.id);

      if (error) {
        toast.error('Failed to update agent permission', { description: error.message });
      } else {
        toast.success(enable ? 'Permission granted for Agents\' Space' : 'Permission revoked');
        await fetchPermissions();
      }
    } else if (enable) {
      const { error } = await supabase
        .from('staff_permissions')
        .insert({
          user_id: agentId,
          permitted_dashboard: AGENTS_SPACE_DASHBOARD_KEY,
          granted_by: user?.id,
          granted_at: new Date().toISOString(),
        });

      if (error) {
        toast.error('Failed to assign permission', { description: error.message });
      } else {
        toast.success('Agent granted permission to access Agents\' Space');
        setOpenAddAgent(false);
        setAgentSearchTerm('');
        setAgentSearchResults([]);
        await fetchPermissions();
      }
    }
    setTogglingAgentId(null);
  };

  const handleDeletePermission = async (permissionId: string) => {
    setDeletingPermId(permissionId);
    const { error } = await supabase
      .from('staff_permissions')
      .delete()
      .eq('id', permissionId);

    if (error) {
      toast.error('Failed to remove permission record', { description: error.message });
    } else {
      toast.success('Restricted agent record removed');
      await fetchPermissions();
    }
    setDeletingPermId(null);
  };

  // Buckets for Ops mode
  const filteredBuckets = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const matchSearch = (r: Requisition) => {
      if (!q) return true;
      const name = (profilesMap[r.requester_id]?.full_name || r.requester_name || '').toLowerCase();
      const code = (r.requisition_code || '').toLowerCase();
      const title = (r.title || '').toLowerCase();
      const reason = (r.reason || '').toLowerCase();
      return name.includes(q) || code.includes(q) || title.includes(q) || reason.includes(q);
    };

    const pending = rows.filter((r) =>
      r.stage === 'supervisor' && matchSearch(r)
    );
    const approved = rows.filter((r) =>
      (['coo', 'cfo', 'ceo', 'approved'].includes(r.stage)) && matchSearch(r)
    );
    const rejected = rows.filter((r) =>
      (['rejected'].includes(r.stage)) && matchSearch(r)
    );
    const mySubmissions = rows.filter((r) =>
      r.requester_id === user?.id && matchSearch(r)
    );

    return {
      pending,
      approved,
      rejected,
      my_submissions: mySubmissions,
    };
  }, [rows, searchQuery, profilesMap, user?.id]);

  const activeAuthorizedAgentsCount = authorizedAgents.filter((a) => !a.revoked_at).length;
  const currentOpsList = activeTab === 'access_control' ? [] : filteredBuckets[activeTab as keyof typeof filteredBuckets] || [];

  // Open Decision Dialog (Ops mode)
  const openDecisionDialog = (req: Requisition, type: 'approve' | 'reject' | 'return_info') => {
    setActiveReq(req);
    setDecisionType(type);
    setDecisionComment('');
    setAmountOverride(String(req.approved_amount ?? req.amount));
    void loadEvents(req.id);
  };

  const handleDecisionSubmit = async () => {
    if (!activeReq) return;
    if (decisionType !== 'approve' && decisionComment.trim().length < 10) {
      toast.error('Please provide a comment of at least 10 characters for the audit log.');
      return;
    }
    const amount = Number(amountOverride);
    if (decisionType === 'approve' && (!Number.isFinite(amount) || amount <= 0)) {
      toast.error('Enter a valid approved amount.');
      return;
    }

    setActing(true);
    const { error } = await invokeEdgeFunction('staff-requisition-decide', {
      body: {
        requisition_id: activeReq.id,
        action: decisionType,
        comment: decisionComment.trim(),
        ...(decisionType === 'approve' ? { amount } : {}),
      },
      errorTitle: 'Requisition decision failed',
    });
    setActing(false);

    if (!error) {
      toast.success(
        decisionType === 'approve'
          ? 'Requisition approved & forwarded to COO'
          : decisionType === 'reject'
            ? 'Requisition declined'
            : 'Sent back to agent for update'
      );
      setActiveReq(null);
      setDecisionComment('');
      await fetchRows();
    }
  };

  // Submit / Resubmit methods
  const startNew = () => {
    setResubmitId(null);
    setForm(EMPTY_FORM);
    setSelectedFiles([]);
    setOpenSubmit(true);
  };

  const startResubmit = (row: Requisition) => {
    setResubmitId(row.id);
    setSelectedFiles([]);
    const cleanedCategory = (row.category ?? '').replace(/\[Agents Space\]\s*/i, '').trim();
    const isPredefinedCat = AGENTS_SPACE_CATEGORIES.some((c) => c !== 'Others' && c.toLowerCase() === cleanedCategory.toLowerCase());
    const isPredefinedTitle = AGENTS_SPACE_CATEGORIES.some((c) => c !== 'Others' && c.toLowerCase() === (row.title ?? '').toLowerCase());

    if (isPredefinedCat) {
      const match = AGENTS_SPACE_CATEGORIES.find((c) => c.toLowerCase() === cleanedCategory.toLowerCase())!;
      setForm({
        category: match,
        customTitle: '',
        amount: String(row.amount),
        needed_by: row.needed_by ?? '',
        reason: row.reason,
      });
    } else if (isPredefinedTitle) {
      const match = AGENTS_SPACE_CATEGORIES.find((c) => c.toLowerCase() === (row.title ?? '').toLowerCase())!;
      setForm({
        category: match,
        customTitle: '',
        amount: String(row.amount),
        needed_by: row.needed_by ?? '',
        reason: row.reason,
      });
    } else {
      setForm({
        category: 'Others',
        customTitle: row.title || cleanedCategory || '',
        amount: String(row.amount),
        needed_by: row.needed_by ?? '',
        reason: row.reason,
      });
    }
    setOpenSubmit(true);
  };

  const handleFilesChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const valid: File[] = [];
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) {
        toast.error(`File "${f.name}" is larger than 10MB`);
        continue;
      }
      valid.push(f);
    }
    setSelectedFiles((prev) => [...prev, ...valid].slice(0, 10));
    e.target.value = '';
  };

  const removeSelectedFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const submitRequisition = async () => {
    const amount = Number(form.amount);
    if (!form.category) return toast.error('Please select what this requisition is for');

    const finalTitle = form.category === 'Others' ? form.customTitle.trim() : form.category;
    if (!finalTitle) return toast.error('Please specify what this requisition is for');
    if (!Number.isFinite(amount) || amount <= 0) return toast.error('Enter a valid amount');

    const taggedCategory = `[${AGENTS_SPACE_TAG}] ${form.category === 'Others' ? (finalTitle || 'Others') : form.category}`;
    const finalReason = form.reason?.trim() || `Requisition for ${finalTitle} under Agents' Space`;

    setSubmitting(true);
    const { data, error } = await invokeEdgeFunction<{ ok: boolean; requisition?: { id: string } }>('staff-requisition-submit', {
      body: {
        ...(resubmitId ? { requisition_id: resubmitId } : {}),
        title: finalTitle,
        amount,
        category: taggedCategory,
        needed_by: form.needed_by || null,
        reason: finalReason,
      },
      errorTitle: 'Could not submit your requisition',
    });

    if (!error) {
      const targetId = resubmitId || data?.requisition?.id;
      if (targetId && selectedFiles.length > 0) {
        for (const file of selectedFiles) {
          const formPayload = new FormData();
          formPayload.append('requisition_id', targetId);
          formPayload.append('file', file);
          await invokeEdgeFunction('staff-requisition-add-attachment', {
            body: formPayload,
            errorTitle: `Could not attach ${file.name}`,
            silent: true,
          });
        }
      }

      toast.success(resubmitId ? 'Requisition resubmitted' : 'Requisition submitted for review');
      setOpenSubmit(false);
      setForm(EMPTY_FORM);
      setSelectedFiles([]);
      setResubmitId(null);
      await fetchRows();
    }
    setSubmitting(false);
  };

  const uploadReceipt = async (row: Requisition, file: File) => {
    setUploadingId(row.id);
    const form = new FormData();
    form.append('requisition_id', row.id);
    form.append('file', file);
    const { error } = await invokeEdgeFunction('staff-requisition-add-attachment', {
      body: form,
      errorTitle: 'Could not attach receipt',
    });
    setUploadingId(null);
    if (!error) {
      toast.success('Receipt attached');
      await fetchRows();
    }
  };

  const viewAttachment = async (row: Requisition, path: string) => {
    setViewingPath(path);
    const { data, error } = await invokeEdgeFunction<{ url: string }>('staff-requisition-attachment-url', {
      body: { requisition_id: row.id, path },
      errorTitle: 'Could not open receipt',
    });
    setViewingPath(null);
    if (!error && data?.url) window.open(data.url, '_blank');
  };

  const userName = (user?.user_metadata?.full_name as string | undefined) || 'Agent User';
  const initials = userName
    .split(' ')
    .filter(Boolean)
    .map((n: string) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  // =========================================================================
  // VIEW 1: AGENT-FACING MODE (Only "Make a requisition" & "Your Submitted Requisitions")
  // =========================================================================
  if (mode === 'agent') {
    return (
      <div className="space-y-4 sm:space-y-6 pb-32 sm:pb-20">
        {/* Top Breadcrumb Bar */}
        <div className="flex items-center justify-between py-2 border-b border-border/40">
          <div className="flex items-center gap-3">
            {onBack && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onBack}
                className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <Avatar className="h-9 w-9 bg-primary/10 text-primary border border-primary/20">
              <AvatarFallback className="bg-primary/15 text-primary text-xs font-bold">
                {initials || 'AG'}
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="text-sm font-bold text-foreground leading-none">{userName}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Agents' Space · Make a requisition</p>
            </div>
          </div>

          {onBack ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void signOut()}
              className="rounded-xl h-8 px-3 text-xs gap-1.5 border-border text-muted-foreground hover:text-foreground"
            >
              <LogOut className="h-3.5 w-3.5" /> Sign Out
            </Button>
          )}
        </div>

        {/* Main Title */}
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
            Make a requisition
          </h1>
        </div>

        {/* Submit Action Banner */}
        <Card className="rounded-2xl border-border bg-card p-4 sm:p-6 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-xs sm:text-sm font-semibold text-foreground">
                Request funding for field activities
              </p>
              <p className="text-xs text-muted-foreground">
                On final approval the amount is credited straight to your wallet.
              </p>
            </div>

            <Dialog open={openSubmit} onOpenChange={(o) => { setOpenSubmit(o); if (!o) setResubmitId(null); }}>
              <DialogTrigger asChild>
                <Button
                  onClick={startNew}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-xl h-11 px-5 shrink-0 shadow-sm gap-2"
                >
                  <Plus className="h-4 w-4" /> New requisition
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg bg-card border-border rounded-2xl">
                <DialogHeader>
                  <DialogTitle>{resubmitId ? 'Update and resubmit' : 'New requisition'}</DialogTitle>
                  <DialogDescription>
                    Submit your request for review. Once approved, the funds will be credited to your wallet.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 pt-2">
                  <div className="space-y-2">
                    <Label htmlFor="req-category">What is it for</Label>
                    <Select
                      value={form.category}
                      onValueChange={(val) => setForm((f) => ({ ...f, category: val }))}
                    >
                      <SelectTrigger id="req-category" className="rounded-xl h-11 bg-background border-border">
                        <SelectValue placeholder="Select a subcategory..." />
                      </SelectTrigger>
                      <SelectContent className="z-[300] bg-popover border-border">
                        {AGENTS_SPACE_CATEGORIES.map((cat) => (
                          <SelectItem key={cat} value={cat} className="cursor-pointer">
                            {cat}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {form.category === 'Others' && (
                      <div className="pt-1.5 space-y-1.5 animate-in fade-in-50 duration-200">
                        <Label htmlFor="req-custom-title" className="text-xs text-muted-foreground font-medium">
                          Specify what it is for
                        </Label>
                        <Input
                          id="req-custom-title"
                          value={form.customTitle}
                          onChange={(e) => setForm((f) => ({ ...f, customTitle: e.target.value }))}
                          placeholder="e.g. Field data bundles, fuel or operational logistics"
                          className="rounded-xl h-11"
                          autoFocus
                        />
                      </div>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="req-amount">Amount (UGX)</Label>
                    <Input
                      id="req-amount"
                      inputMode="numeric"
                      value={form.amount}
                      onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value.replace(/[^0-9.]/g, '') }))}
                      placeholder="250000"
                      className="rounded-xl h-11"
                    />
                  </div>


                  {/* Optional File Attachments */}
                  <div className="space-y-2">
                    <Label className="flex items-center justify-between text-xs sm:text-sm">
                      <span>Attachments / Receipts <span className="text-xs text-muted-foreground font-normal">(optional)</span></span>
                      <span className="text-[11px] text-muted-foreground">PDF, PNG, JPG (max 10MB)</span>
                    </Label>

                    {/* File Dropzone / Picker */}
                    <div className="border border-dashed border-border rounded-xl p-3 sm:p-4 bg-muted/20 hover:bg-muted/30 transition-colors text-center">
                      <label className="cursor-pointer flex flex-col items-center justify-center gap-1.5">
                        <Upload className="h-5 w-5 text-muted-foreground" />
                        <span className="text-xs font-semibold text-primary">
                          Click to select supporting documents or receipts
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          Quotes, invoices, receipts or payment proofs
                        </span>
                        <input
                          type="file"
                          multiple
                          accept="application/pdf,image/jpeg,image/png,image/webp"
                          className="hidden"
                          onChange={handleFilesChosen}
                        />
                      </label>
                    </div>

                    {/* Selected Files List */}
                    {selectedFiles.length > 0 && (
                      <div className="space-y-1.5 pt-1">
                        {selectedFiles.map((file, idx) => (
                          <div
                            key={idx}
                            className="flex items-center justify-between p-2 rounded-lg bg-background border border-border text-xs"
                          >
                            <div className="flex items-center gap-2 min-w-0 pr-2">
                              <FileText className="h-4 w-4 text-primary shrink-0" />
                              <span className="truncate font-medium text-foreground">{file.name}</span>
                              <span className="text-[10px] text-muted-foreground shrink-0">
                                ({(file.size / (1024 * 1024) >= 1) ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(file.size / 1024)} KB`})
                              </span>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeSelectedFile(idx)}
                              className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <DialogFooter className="gap-2 pt-2">
                  <Button variant="outline" onClick={() => setOpenSubmit(false)} className="rounded-xl">
                    Cancel
                  </Button>
                  <Button
                    onClick={submitRequisition}
                    disabled={submitting}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold rounded-xl"
                  >
                    {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {resubmitId ? 'Resubmit request' : 'Submit for review'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </Card>

        {/* User's Submitted Requisitions Section */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-foreground">Your Submitted Requisitions</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchRows}
              className="text-xs text-muted-foreground hover:text-foreground gap-1.5 h-8"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>

          {loading ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <Card key={i} className="p-5 rounded-2xl border-border bg-card animate-pulse space-y-3">
                  <div className="h-5 w-1/3 bg-muted rounded" />
                  <div className="h-4 w-1/2 bg-muted rounded" />
                </Card>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <Card className="p-10 text-center rounded-2xl border-dashed border-2 border-border bg-card space-y-3">
              <div className="mx-auto w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary">
                <Wallet className="h-6 w-6" />
              </div>
              <div className="space-y-1 max-w-sm mx-auto">
                <h3 className="text-sm font-bold text-foreground">No requisitions submitted yet</h3>
                <p className="text-xs text-muted-foreground">
                  Click <strong>+ New requisition</strong> to request funds for your field operations.
                </p>
              </div>
            </Card>
          ) : (
            <div className="space-y-3">
              {rows.map((row) => {
                const rowEvents = events[row.id];
                return (
                  <Card
                    key={row.id}
                    className="rounded-2xl border border-border bg-card p-5 shadow-sm space-y-4"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-bold text-primary">
                            {row.requisition_code}
                          </span>
                          <h3 className="font-bold text-base text-foreground">{row.title}</h3>
                          <StatusPill row={row} mode="agent" />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Requested on {fmtDate(row.created_at)}
                          {row.needed_by && ` · Needed by ${fmtDate(row.needed_by)}`}
                        </p>
                      </div>

                      <div className="text-left sm:text-right">
                        <p className="text-lg font-bold text-foreground">
                          {formatUGX(row.approved_amount ?? row.amount)}
                        </p>
                        {row.approved_amount && row.approved_amount !== row.amount && (
                          <p className="text-[11px] text-muted-foreground line-through">
                            {formatUGX(row.amount)}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Reason */}
                    <div className="bg-muted/40 rounded-xl p-3 text-xs text-foreground space-y-1">
                      <p className="font-medium">{row.reason}</p>
                      {row.category && (
                        <span className="inline-block px-2 py-0.5 rounded-md text-[10px] bg-background border border-border text-muted-foreground mt-1">
                          {row.category.replace(/\[Agents Space\]\s*/i, '')}
                        </span>
                      )}
                    </div>

                    {/* Returned Note */}
                    {row.rejection_reason && (
                      <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive space-y-1">
                        <p className="font-semibold flex items-center gap-1.5">
                          <XCircle className="h-3.5 w-3.5" /> Note from approver:
                        </p>
                        <p>{row.rejection_reason}</p>
                      </div>
                    )}

                    {/* Wallet Credit Confirmation */}
                    {row.wallet_credit_status === 'credited' && (
                      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 shrink-0" />
                        <span>Funds credited to your wallet on {fmtDate(row.credited_at)}.</span>
                      </div>
                    )}

                    {/* Attachments and Actions */}
                    <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border/60">
                      <div className="flex flex-wrap items-center gap-2">
                        {(row.attachment_urls || []).map((url, idx) => (
                          <Button
                            key={idx}
                            variant="outline"
                            size="sm"
                            disabled={viewingPath === url}
                            onClick={() => viewAttachment(row, url)}
                            className="h-7 px-2 text-[11px] rounded-lg gap-1 border-border"
                          >
                            <Paperclip className="h-3 w-3" />
                            Receipt #{idx + 1}
                          </Button>
                        ))}

                        <label className="cursor-pointer">
                          <input
                            type="file"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) void uploadReceipt(row, file);
                            }}
                          />
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border border-border bg-background hover:bg-muted text-foreground transition-colors cursor-pointer">
                            {uploadingId === row.id ? (
                              <Loader2 className="h-3 w-3 animate-spin text-primary" />
                            ) : (
                              <Upload className="h-3 w-3 text-muted-foreground" />
                            )}
                            Attach receipt
                          </span>
                        </label>
                      </div>

                      <div className="flex items-center gap-2">
                        {row.stage === 'returned' && (
                          <Button
                            size="sm"
                            onClick={() => startResubmit(row)}
                            className="bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold rounded-xl h-8 px-3"
                          >
                            Update &amp; Resubmit
                          </Button>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // =========================================================================
  // VIEW 2: OPS / ADMIN MODE (Queue, Route to COO then CFO, Approved, Declined, Permissions)
  // =========================================================================
  return (
    <div className="space-y-4 sm:space-y-6 pb-32 sm:pb-20">
      {/* Top Breadcrumb Bar */}
      <div className="flex items-center justify-between py-2 border-b border-border/40">
        <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground shrink-0"
              aria-label="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <Avatar className="h-8 w-8 sm:h-9 sm:w-9 bg-primary/10 text-primary border border-primary/20 shrink-0">
            <AvatarFallback className="bg-primary/15 text-primary text-xs font-bold">
              {initials || 'AG'}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-xs sm:text-sm font-bold text-foreground leading-none truncate">{userName}</p>
            <p className="text-[10px] sm:text-[11px] text-muted-foreground mt-0.5 truncate">
              Agent Operations · Requisitions Hub &amp; Whitelist
            </p>
          </div>
        </div>

        {onBack && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground shrink-0"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Main Header & Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold tracking-tight text-foreground">
            Agents' Space Operations
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Review agent funding requisitions. Approvals route <span className="font-semibold text-primary">Agent Ops → COO → CFO</span> for final wallet crediting.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { void fetchRows(); void fetchPermissions(); }}
            className="rounded-xl h-9 sm:h-10 px-3 text-xs gap-1.5 border-border flex-1 sm:flex-none justify-center"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>

          <Dialog open={openAddAgent} onOpenChange={(o) => { setOpenAddAgent(o); if (!o) { setAgentSearchTerm(''); setAgentSearchResults([]); } }}>
            <DialogTrigger asChild>
              <Button
                variant="outline"
                className="rounded-xl h-9 sm:h-10 px-3 text-xs gap-1.5 border-primary/30 text-primary hover:bg-primary/10 font-semibold flex-1 sm:flex-none justify-center"
              >
                <Key className="h-4 w-4" /> Assign Agent Permission
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md bg-card border-border rounded-2xl">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-primary" /> Grant Agents' Space Access
                </DialogTitle>
                <DialogDescription>
                  Search an agent by name, phone or email to whitelist them for Agents' Space. Access is restricted until you explicitly allow them.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 pt-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={agentSearchTerm}
                    onChange={(e) => void handleSearchAgents(e.target.value)}
                    placeholder="Type agent name, phone or email..."
                    className="pl-9 rounded-xl"
                  />
                </div>

                {searchingAgents ? (
                  <div className="flex items-center justify-center p-6 text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin text-primary mr-2" /> Searching registered agents...
                  </div>
                ) : agentSearchResults.length > 0 ? (
                  <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                    {agentSearchResults.map((agent) => {
                      const isAlreadyActive = authorizedAgents.some(
                        (a) => a.user_id === agent.id && !a.revoked_at
                      );
                      return (
                        <div
                          key={agent.id}
                          className="flex items-center justify-between p-3 rounded-xl border border-border bg-card hover:bg-muted/40 transition-colors gap-3"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <Avatar className="h-8 w-8 bg-primary/10 text-primary text-xs font-bold shrink-0">
                              {agent.avatar_url && <AvatarImage src={agent.avatar_url} />}
                              <AvatarFallback className="text-[10px]">
                                {(agent.full_name || 'AG').slice(0, 2).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <p className="text-xs font-bold text-foreground truncate">
                                {agent.full_name || 'Unnamed Agent'}
                              </p>
                              <p className="text-[11px] text-muted-foreground truncate">
                                {agent.phone || agent.email || agent.territory || 'Agent'}
                              </p>
                            </div>
                          </div>

                          <Button
                            size="sm"
                            disabled={togglingAgentId === agent.id || isAlreadyActive}
                            onClick={() => void handleTogglePermission(agent.id, true)}
                            className={`rounded-xl h-8 px-3 text-xs font-semibold shrink-0 ${
                              isAlreadyActive
                                ? 'bg-muted text-muted-foreground hover:bg-muted'
                                : 'bg-primary hover:bg-primary/90 text-primary-foreground'
                            }`}
                          >
                            {togglingAgentId === agent.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : isAlreadyActive ? (
                              'Authorized'
                            ) : (
                              'Grant Access'
                            )}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ) : agentSearchTerm.length >= 2 ? (
                  <p className="text-center p-4 text-xs text-muted-foreground">
                    No matching agents found. Check the spelling or phone number.
                  </p>
                ) : (
                  <p className="text-center p-4 text-xs text-muted-foreground">
                    Type at least 2 characters to search across all agents.
                  </p>
                )}
              </div>
            </DialogContent>
          </Dialog>

        </div>
      </div>

      {/* Overview Metric Bar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <Card
          onClick={() => setActiveTab('pending')}
          className={`p-3 sm:p-4 rounded-xl sm:rounded-2xl border cursor-pointer transition-all ${
            activeTab === 'pending'
              ? 'border-amber-500 bg-amber-500/10 shadow-sm'
              : 'border-border bg-card hover:border-amber-500/40'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] sm:text-xs font-semibold text-muted-foreground truncate">Pending Review</span>
            <Clock className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-amber-600 dark:text-amber-400 shrink-0" />
          </div>
          <p className="text-xl sm:text-2xl font-bold text-foreground mt-1 sm:mt-2">
            {filteredBuckets.pending.length}
          </p>
          <p className="text-[10px] sm:text-[11px] text-amber-700 dark:text-amber-400 mt-0.5 truncate">Awaiting Agent Ops</p>
        </Card>

        <Card
          onClick={() => setActiveTab('approved')}
          className={`p-3 sm:p-4 rounded-xl sm:rounded-2xl border cursor-pointer transition-all ${
            activeTab === 'approved'
              ? 'border-emerald-500 bg-emerald-500/10 shadow-sm'
              : 'border-border bg-card hover:border-emerald-500/40'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] sm:text-xs font-semibold text-muted-foreground truncate">Approved / Forwarded</span>
            <CheckCircle2 className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          </div>
          <p className="text-xl sm:text-2xl font-bold text-foreground mt-1 sm:mt-2">
            {filteredBuckets.approved.length}
          </p>
          <p className="text-[10px] sm:text-[11px] text-emerald-700 dark:text-emerald-400 mt-0.5 truncate">Approved &amp; Credited</p>
        </Card>

        <Card
          onClick={() => setActiveTab('rejected')}
          className={`p-3 sm:p-4 rounded-xl sm:rounded-2xl border cursor-pointer transition-all ${
            activeTab === 'rejected'
              ? 'border-destructive bg-destructive/10 shadow-sm'
              : 'border-border bg-card hover:border-destructive/40'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] sm:text-xs font-semibold text-muted-foreground truncate">Declined</span>
            <XCircle className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-destructive shrink-0" />
          </div>
          <p className="text-xl sm:text-2xl font-bold text-foreground mt-1 sm:mt-2">
            {filteredBuckets.rejected.length}
          </p>
          <p className="text-[10px] sm:text-[11px] text-destructive mt-0.5 truncate">Rejected requisitions</p>
        </Card>

        <Card
          onClick={() => setActiveTab('access_control')}
          className={`p-3 sm:p-4 rounded-xl sm:rounded-2xl border cursor-pointer transition-all ${
            activeTab === 'access_control'
              ? 'border-primary bg-primary/10 shadow-sm'
              : 'border-border bg-card hover:border-primary/40'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] sm:text-xs font-semibold text-muted-foreground truncate">Authorized Agents</span>
            <ShieldCheck className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-primary shrink-0" />
          </div>
          <p className="text-xl sm:text-2xl font-bold text-foreground mt-1 sm:mt-2">
            {activeAuthorizedAgentsCount}
          </p>
          <p className="text-[10px] sm:text-[11px] text-primary mt-0.5 truncate">Permission Assigned</p>
        </Card>
      </div>

      {/* Navigation Tabs Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabSection)} className="w-full sm:w-auto">
          <TabsList className="flex flex-nowrap overflow-x-auto no-scrollbar w-full p-1 bg-muted/60 border border-border/50 rounded-xl gap-1 justify-start">
            <TabsTrigger value="pending" className="shrink-0 whitespace-nowrap text-xs py-2 px-3 rounded-lg font-semibold gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              Pending ({filteredBuckets.pending.length})
            </TabsTrigger>
            <TabsTrigger value="approved" className="shrink-0 whitespace-nowrap text-xs py-2 px-3 rounded-lg font-semibold gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Approved ({filteredBuckets.approved.length})
            </TabsTrigger>
            <TabsTrigger value="rejected" className="shrink-0 whitespace-nowrap text-xs py-2 px-3 rounded-lg font-semibold gap-1.5">
              <XCircle className="h-3.5 w-3.5" />
              Declined ({filteredBuckets.rejected.length})
            </TabsTrigger>
            <TabsTrigger value="access_control" className="shrink-0 whitespace-nowrap text-xs py-2 px-3 rounded-lg font-semibold gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              Permission Access ({activeAuthorizedAgentsCount})
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {activeTab !== 'access_control' && (
          <div className="relative w-full sm:w-auto sm:min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search agent, code or title..."
              className="pl-8 h-9 text-xs rounded-xl bg-card border-border w-full"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* ACCESS CONTROL / AGENT PERMISSIONS VIEW */}
      {activeTab === 'access_control' ? (
        <div className="space-y-4">
          <Card className="rounded-2xl border-border bg-card p-5 shadow-sm space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-foreground flex items-center gap-2">
                  <Lock className="h-4 w-4 text-primary" /> Agents' Space Whitelist &amp; Access Controls
                </h3>
                <p className="text-xs text-muted-foreground">
                  By default, access to Agents' Space is completely restricted. Only agents explicitly enabled below will see and access Agents' Space.
                </p>
              </div>

              <Button
                size="sm"
                onClick={() => setOpenAddAgent(true)}
                className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-xl text-xs gap-1.5 shrink-0"
              >
                <Plus className="h-3.5 w-3.5" /> Assign New Agent
              </Button>
            </div>
          </Card>

          {loadingPerms ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <Card key={i} className="p-4 rounded-2xl border-border bg-card animate-pulse space-y-2">
                  <div className="h-5 w-1/3 bg-muted rounded" />
                  <div className="h-4 w-1/2 bg-muted rounded" />
                </Card>
              ))}
            </div>
          ) : authorizedAgents.length === 0 ? (
            <Card className="p-10 text-center rounded-2xl border-dashed border-2 border-border bg-card space-y-3">
              <div className="mx-auto w-12 h-12 rounded-2xl bg-muted flex items-center justify-center text-muted-foreground">
                <ShieldAlert className="h-6 w-6 text-amber-600" />
              </div>
              <div className="space-y-1 max-w-sm mx-auto">
                <h3 className="text-sm font-bold text-foreground">No agents authorized yet</h3>
                <p className="text-xs text-muted-foreground">
                  Click <strong>+ Assign New Agent</strong> to grant an agent rights to access Agents' Space.
                </p>
              </div>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {authorizedAgents.map((cap) => {
                const p = authAgentProfiles[cap.user_id];
                const isActive = !cap.revoked_at;
                const isToggling = togglingAgentId === cap.user_id;

                return (
                  <Card
                    key={cap.id}
                    className={`rounded-2xl border p-4 transition-all shadow-sm ${
                      isActive ? 'border-border bg-card' : 'border-destructive/20 bg-muted/20 opacity-80'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <Avatar className="h-10 w-10 bg-primary/10 border border-primary/20 shrink-0 mt-0.5">
                          {p?.avatar_url && <AvatarImage src={p.avatar_url} />}
                          <AvatarFallback className="bg-primary/10 text-primary font-bold text-xs">
                            {(p?.full_name || 'AG').slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>

                        <div className="min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-sm text-foreground truncate">
                              {p?.full_name || 'Agent User'}
                            </span>
                            {isActive ? (
                              <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-semibold text-[10px]">
                                <CheckCircle2 className="mr-1 h-3 w-3" /> Authorized
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive font-semibold text-[10px]">
                                <XCircle className="mr-1 h-3 w-3" /> Restricted
                              </Badge>
                            )}
                          </div>

                          <p className="text-xs text-muted-foreground truncate">
                            {p?.phone || p?.email || 'No contact provided'}
                            {p?.territory ? ` · ${p.territory}` : ''}
                          </p>

                          <p className="text-[10px] text-muted-foreground pt-1">
                            Granted: {fmtDate(cap.granted_at)}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {!isActive && (
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={deletingPermId === cap.id}
                            onClick={() => void handleDeletePermission(cap.id)}
                            className="h-8 w-8 text-destructive/70 hover:text-destructive hover:bg-destructive/10 rounded-xl transition-colors"
                            title="Delete restricted record"
                          >
                            {deletingPermId === cap.id ? (
                              <Loader2 className="h-4 w-4 animate-spin text-destructive" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                        {isToggling ? (
                          <Loader2 className="h-4 w-4 animate-spin text-primary" />
                        ) : (
                          <Switch
                            checked={isActive}
                            onCheckedChange={(checked) => void handleTogglePermission(cap.user_id, checked)}
                            aria-label="Toggle Agents' Space Permission"
                          />
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* REQUISITIONS LIST VIEW FOR OPS */
        <div>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Card key={i} className="p-5 rounded-2xl border-border bg-card animate-pulse space-y-3">
                  <div className="h-5 w-1/3 bg-muted rounded" />
                  <div className="h-4 w-1/2 bg-muted rounded" />
                </Card>
              ))}
            </div>
          ) : currentOpsList.length === 0 ? (
            <Card className="p-12 text-center rounded-2xl border-dashed border-2 border-border bg-card space-y-3">
              <div className="mx-auto w-12 h-12 rounded-2xl bg-muted flex items-center justify-center text-muted-foreground">
                {activeTab === 'pending' && <Clock className="h-6 w-6" />}
                {activeTab === 'approved' && <CheckCircle2 className="h-6 w-6 text-emerald-600" />}
                {activeTab === 'rejected' && <XCircle className="h-6 w-6 text-destructive" />}
                {activeTab === 'my_submissions' && <Wallet className="h-6 w-6 text-primary" />}
              </div>
              <div className="space-y-1 max-w-sm mx-auto">
                <h3 className="text-sm font-bold text-foreground">
                  {activeTab === 'pending' && 'No pending requisitions in review queue'}
                  {activeTab === 'approved' && 'No approved requisitions yet'}
                  {activeTab === 'rejected' && 'No declined requisitions'}
                  {activeTab === 'my_submissions' && 'You have not submitted any requisitions yet'}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {activeTab === 'pending' && 'Requisitions submitted by agents from Agents\' Space will appear here for review.'}
                  {activeTab === 'approved' && 'Requisitions approved by Agent Ops and forwarded to COO / CFO or credited will appear here.'}
                  {activeTab === 'rejected' && 'Declined requisitions will be listed with feedback and reasons.'}
                  {activeTab === 'my_submissions' && 'Click + New requisition to request operational funds for your territory.'}
                </p>
              </div>
            </Card>
          ) : (
            <div className="space-y-3">
              {currentOpsList.map((row) => {
                const reqProfile = profilesMap[row.requester_id];
                const applicantName = reqProfile?.full_name || row.requester_name || 'Agent Applicant';
                const applicantInitials = applicantName
                  .split(' ')
                  .filter(Boolean)
                  .map((n: string) => n[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase();

                const isRequester = row.requester_id === user?.id;
                const rowEvents = events[row.id];

                return (
                  <Card
                    key={row.id}
                    className="rounded-2xl border border-border bg-card p-5 shadow-sm space-y-4"
                  >
                    {/* Header Row: Applicant profile, Code, Status & Amount */}
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <Avatar className="h-10 w-10 bg-primary/10 border border-primary/20 shrink-0 mt-0.5">
                          {reqProfile?.avatar_url && <AvatarImage src={reqProfile.avatar_url} />}
                          <AvatarFallback className="bg-primary/10 text-primary font-bold text-xs">
                            {applicantInitials || 'AG'}
                          </AvatarFallback>
                        </Avatar>

                        <div className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-foreground text-sm sm:text-base">
                              {applicantName}
                            </span>
                            {reqProfile?.phone && (
                              <span className="text-[11px] text-muted-foreground font-mono">
                                ({reqProfile.phone})
                              </span>
                            )}
                            <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded-md bg-muted text-muted-foreground border border-border">
                              {row.requisition_code}
                            </span>
                            <StatusPill row={row} mode="ops" />
                          </div>

                          <h3 className="font-semibold text-sm text-foreground">{row.title}</h3>

                          <p className="text-xs text-muted-foreground">
                            Applied on {fmtDate(row.created_at)}
                            {row.needed_by && ` · Needed by ${fmtDate(row.needed_by)}`}
                          </p>
                        </div>
                      </div>

                      <div className="text-left sm:text-right pl-12 sm:pl-0">
                        <p className="text-lg sm:text-xl font-bold text-foreground">
                          {formatUGX(row.approved_amount ?? row.amount)}
                        </p>
                        {row.approved_amount && row.approved_amount !== row.amount && (
                          <p className="text-[11px] text-muted-foreground line-through">
                            Requested: {formatUGX(row.amount)}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Justification & Category */}
                    <div className="bg-muted/40 rounded-xl p-3.5 text-xs text-foreground space-y-1.5">
                      <p className="font-normal leading-relaxed text-foreground/90">{row.reason}</p>
                      {row.category && (
                        <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-medium bg-background border border-border text-muted-foreground">
                          {row.category.replace(/\[Agents Space\]\s*/i, '')}
                        </span>
                      )}
                    </div>

                    {/* Approver Notes / Decline Note */}
                    {row.rejection_reason && (
                      <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive space-y-1">
                        <p className="font-semibold flex items-center gap-1.5">
                          <XCircle className="h-3.5 w-3.5 shrink-0" /> Decline Reason:
                        </p>
                        <p className="leading-relaxed">{row.rejection_reason}</p>
                      </div>
                    )}

                    {row.supervisor_note && !row.rejection_reason && (
                      <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs text-primary space-y-1">
                        <p className="font-semibold flex items-center gap-1.5">
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> Agent Ops Note:
                        </p>
                        <p className="leading-relaxed">{row.supervisor_note}</p>
                      </div>
                    )}

                    {/* Wallet Credit Confirmation */}
                    {row.wallet_credit_status === 'credited' && (
                      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 shrink-0" />
                        <span>Funds credited to agent's wallet on {fmtDate(row.credited_at)}.</span>
                      </div>
                    )}

                    {/* Attachments and Action Buttons */}
                    <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border/60">
                      {/* Left: Receipts & Upload */}
                      <div className="flex flex-wrap items-center gap-2">
                        {(row.attachment_urls || []).map((url, idx) => (
                          <Button
                            key={idx}
                            variant="outline"
                            size="sm"
                            disabled={viewingPath === url}
                            onClick={() => viewAttachment(row, url)}
                            className="h-7 px-2 text-[11px] rounded-lg gap-1 border-border"
                          >
                            <Paperclip className="h-3 w-3" />
                            Receipt #{idx + 1}
                          </Button>
                        ))}

                        <label className="cursor-pointer">
                          <input
                            type="file"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) void uploadReceipt(row, file);
                            }}
                          />
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border border-border bg-background hover:bg-muted text-foreground transition-colors cursor-pointer">
                            {uploadingId === row.id ? (
                              <Loader2 className="h-3 w-3 animate-spin text-primary" />
                            ) : (
                              <Upload className="h-3 w-3 text-muted-foreground" />
                            )}
                            Attach receipt
                          </span>
                        </label>
                      </div>

                      {/* Right: Decision Action Buttons */}
                      <div className="flex items-center gap-2 flex-wrap">
                        {row.stage === 'supervisor' && (
                          <>
                            <Button
                              size="sm"
                              onClick={() => openDecisionDialog(row, 'approve')}
                              className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-xl h-8 px-3 text-xs gap-1.5 shadow-sm"
                            >
                              <SendHorizontal className="h-3.5 w-3.5" /> Approve to COO
                            </Button>

                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openDecisionDialog(row, 'return_info')}
                              className="rounded-xl h-8 px-3 text-xs font-medium border-border"
                            >
                              Request Info
                            </Button>

                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => openDecisionDialog(row, 'reject')}
                              className="rounded-xl h-8 px-3 text-xs font-semibold"
                            >
                              Decline
                            </Button>
                          </>
                        )}

                        {row.stage === 'returned' && isRequester && (
                          <Button
                            size="sm"
                            onClick={() => startResubmit(row)}
                            className="bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold rounded-xl h-8 px-3"
                          >
                            Update &amp; Resubmit
                          </Button>
                        )}

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => loadEvents(row.id)}
                          className="text-xs text-muted-foreground hover:text-foreground h-8"
                        >
                          {rowEvents ? 'Hide history' : 'View history'}
                        </Button>
                      </div>
                    </div>

                    {/* Audit History */}
                    {rowEvents && (
                      <div className="pt-2 border-t border-border/40 space-y-2">
                        <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                          Audit History
                        </p>
                        <div className="space-y-1.5 pl-2 border-l-2 border-primary/20">
                          {rowEvents.map((ev) => (
                            <div key={ev.id} className="text-xs text-muted-foreground">
                              <span className="font-semibold text-foreground">{ev.actor_name || 'System'}</span>
                              {' · '}
                              <span className="capitalize">{ev.action}</span>
                              {ev.comment && <span className="italic"> — "{ev.comment}"</span>}
                              <span className="text-[10px] text-muted-foreground/70 ml-1">
                                ({fmtDate(ev.created_at)})
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Decision / Approval Modal */}
      <Dialog open={!!activeReq} onOpenChange={(o) => { if (!o) setActiveReq(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md bg-card border-border rounded-2xl">
          <DialogHeader>
            <DialogTitle>
              {decisionType === 'approve' && 'Approve & Route to COO'}
              {decisionType === 'reject' && 'Decline Requisition'}
              {decisionType === 'return_info' && 'Request More Information'}
            </DialogTitle>
            <DialogDescription>
              {activeReq?.requisition_code} · {activeReq?.title}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            {decisionType === 'approve' && (
              <div className="space-y-3">
                <div className="p-3 rounded-xl bg-primary/10 border border-primary/20 text-xs text-primary space-y-1">
                  <p className="font-bold flex items-center gap-1.5">
                    <SendHorizontal className="h-3.5 w-3.5" /> Next Approver: Chief Operating Officer (COO) → CFO
                  </p>
                  <p className="text-muted-foreground">
                    Upon your approval, this requisition is forwarded to the COO, and subsequently to the CFO for final financial clearance and automatic wallet crediting.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="appr-amount-ops">Approved Amount (UGX)</Label>
                  <Input
                    id="appr-amount-ops"
                    inputMode="numeric"
                    value={amountOverride}
                    onChange={(e) => setAmountOverride(e.target.value.replace(/[^0-9.]/g, ''))}
                    className="rounded-xl font-bold"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Requested amount: <strong>{formatUGX(Number(activeReq?.amount || 0))}</strong>
                  </p>
                </div>
              </div>
            )}

            {decisionType === 'reject' && (
              <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-xs text-destructive flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  Declining will notify the applicant with your provided reason and close the requisition.
                </span>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="appr-comment-ops">
                {decisionType === 'approve' ? 'Approver Note (optional)' : 'Reason / Comment (required, min 10 characters)'}
              </Label>
              <Textarea
                id="appr-comment-ops"
                rows={3}
                value={decisionComment}
                onChange={(e) => setDecisionComment(e.target.value)}
                placeholder={
                  decisionType === 'approve'
                    ? 'Verified operational need for field activities...'
                    : 'Explain why this request is declined or what info is missing...'
                }
                className="rounded-xl"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 pt-2">
            <Button variant="outline" onClick={() => setActiveReq(null)} disabled={acting} className="rounded-xl">
              Cancel
            </Button>
            <Button
              onClick={handleDecisionSubmit}
              disabled={acting}
              variant={decisionType === 'reject' ? 'destructive' : 'default'}
              className="rounded-xl font-bold"
            >
              {acting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {decisionType === 'approve' && 'Confirm & Send to COO'}
              {decisionType === 'reject' && 'Confirm Decline'}
              {decisionType === 'return_info' && 'Send Back to Agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
