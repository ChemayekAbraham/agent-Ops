import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { UsersRound, CheckCircle, XCircle, Loader2, Phone, Calendar, Clock, Search, ArrowLeftRight, UserPlus, Unlink } from 'lucide-react';
import { format } from 'date-fns';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

interface SubAgentRecord {
  id: string;
  parent_agent_id: string;
  sub_agent_id: string;
  source: string;
  status: string;
  created_at: string;
  verified_at: string | null;
  rejection_reason: string | null;
  parent_name: string;
  parent_phone: string;
  sub_name: string;
  sub_phone: string;
}

export function SubAgentVerificationQueue() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('pending');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [selectedRecord, setSelectedRecord] = useState<SubAgentRecord | null>(null);
  const [transferRecord, setTransferRecord] = useState<SubAgentRecord | null>(null);
  const [transferSearch, setTransferSearch] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [newParent, setNewParent] = useState<{ id: string; full_name: string; phone: string | null } | null>(null);
  const [transferring, setTransferring] = useState(false);
  // Ops-only unlink: detaches the sub-agent from their parent so they become
  // a fully independent agent.
  const [unlinkRecord, setUnlinkRecord] = useState<SubAgentRecord | null>(null);
  const [unlinkReason, setUnlinkReason] = useState('');
  const [unlinking, setUnlinking] = useState(false);
  const [parentResults, setParentResults] = useState<{ id: string; full_name: string; phone: string | null }[]>([]);
  const [searchingParents, setSearchingParents] = useState(false);

  // Admin: assign any agent as a sub-agent to a parent agent (with reason + log)
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignReason, setAssignReason] = useState('');
  const [assignSubSearch, setAssignSubSearch] = useState('');
  const [assignParentSearch, setAssignParentSearch] = useState('');
  const [assignSubResults, setAssignSubResults] = useState<{ id: string; full_name: string; phone: string | null }[]>([]);
  const [assignParentResults, setAssignParentResults] = useState<{ id: string; full_name: string; phone: string | null }[]>([]);
  const [assignSub, setAssignSub] = useState<{ id: string; full_name: string; phone: string | null } | null>(null);
  const [assignParent, setAssignParent] = useState<{ id: string; full_name: string; phone: string | null } | null>(null);
  const [assignSearchingSub, setAssignSearchingSub] = useState(false);
  const [assignSearchingParent, setAssignSearchingParent] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const searchAgents = async (
    term: string,
    setResults: (r: { id: string; full_name: string; phone: string | null }[]) => void,
    setLoading: (b: boolean) => void,
    excludeId?: string | null,
  ) => {
    const t = term.trim();
    if (t.length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .or(`full_name.ilike.%${t}%,phone.ilike.%${t}%`)
        .limit(15);
      if (error) throw error;
      setResults((data || []).filter(p => !excludeId || p.id !== excludeId));
    } catch (err: any) {
      toast.error(err.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const resetAssignDialog = () => {
    setAssignOpen(false);
    setAssignReason('');
    setAssignSubSearch('');
    setAssignParentSearch('');
    setAssignSubResults([]);
    setAssignParentResults([]);
    setAssignSub(null);
    setAssignParent(null);
  };

  const handleAssign = async () => {
    if (!assignSub || !assignParent) {
      toast.error('Select both the agent and their parent agent.');
      return;
    }
    if (assignSub.id === assignParent.id) {
      toast.error('An agent cannot be assigned to themselves.');
      return;
    }
    if (assignReason.trim().length < 10) {
      toast.error('Please provide a reason (at least 10 characters).');
      return;
    }
    setAssigning(true);
    try {
      const { data, error } = await supabase.rpc('admin_assign_subagent_parent' as any, {
        _sub_agent_id: assignSub.id,
        _new_parent_id: assignParent.id,
        _reason: assignReason.trim(),
      });
      if (error) throw error;
      const mode = (data as any)?.mode === 'reassigned' ? 'reassigned' : 'assigned';
      toast.success(`${assignSub.full_name} ${mode} as sub-agent of ${assignParent.full_name}. Action logged.`);
      resetAssignDialog();
      queryClient.invalidateQueries({ queryKey: ['subagent-verification-queue'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to assign sub-agent');
    } finally {
      setAssigning(false);
    }
  };

  const { data: records, isLoading } = useQuery({
    queryKey: ['subagent-verification-queue', debouncedSearch.trim().toLowerCase()],
    queryFn: async () => {
      const term = debouncedSearch.trim();
      let rows: any[] = [];

      if (term.length >= 2) {
        // Server-side search: match profiles by name/phone across the ENTIRE
        // set, then pull the sub-agent rows linked to those people. Avoids the
        // 1000-row client window that made search miss most records.
        const { data: matched, error: pErr } = await supabase
          .from('profiles')
          .select('id')
          .or(`full_name.ilike.%${term}%,phone.ilike.%${term}%`)
          .limit(300);
        if (pErr) throw pErr;
        const ids = (matched || []).map((p) => p.id);
        if (ids.length === 0) return [];
        const { data, error } = await supabase
          .from('agent_subagents' as any)
          .select('*')
          .or(`parent_agent_id.in.(${ids.join(',')}),sub_agent_id.in.(${ids.join(',')})`)
          .order('created_at', { ascending: false })
          .limit(500);
        if (error) throw error;
        rows = (data || []) as any[];
      } else {
        const { data, error } = await supabase
          .from('agent_subagents' as any)
          .select('*')
          .order('created_at', { ascending: false })
          .limit(500);
        if (error) throw error;
        rows = (data || []) as any[];
      }

      if (rows.length === 0) return [];

      const allIds = [...new Set(rows.flatMap(r => [r.parent_agent_id, r.sub_agent_id]))];
      const BATCH = 50;
      const profiles: Record<string, any> = {};
      for (let i = 0; i < allIds.length; i += BATCH) {
        const { data: batch } = await supabase.from('profiles')
          .select('id, full_name, phone')
          .in('id', allIds.slice(i, i + BATCH));
        (batch || []).forEach(p => { profiles[p.id] = p; });
      }

      return rows.map(r => ({
        ...r,
        parent_name: profiles[r.parent_agent_id]?.full_name || 'Unknown',
        parent_phone: profiles[r.parent_agent_id]?.phone || '—',
        sub_name: profiles[r.sub_agent_id]?.full_name || 'Unknown',
        sub_phone: profiles[r.sub_agent_id]?.phone || '—',
      })) as SubAgentRecord[];
    },
    staleTime: 30000,
  });

  const filtered = records || [];
  const pending = filtered.filter(r => r.status === 'pending' || r.status === 'pending_acceptance');
  const verified = filtered.filter(r => r.status === 'verified');

  const handleVerify = async (id: string) => {
    if (!user?.id) return;
    setProcessingId(id);
    try {
      const { error } = await supabase.rpc('verify_subagent' as any, {
        _record_id: id,
        _action: 'verify',
      });
      if (error) throw error;
      toast.success('Sub-agent verified! Commission credited to parent agent.');
      queryClient.invalidateQueries({ queryKey: ['subagent-verification-queue'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to verify');
    } finally {
      setProcessingId(null);
    }
  };

  const handleReject = async (id: string) => {
    if (!rejectionReason.trim() || rejectionReason.trim().length < 10) {
      toast.error('Please provide a reason (at least 10 characters).');
      return;
    }
    setProcessingId(id);
    try {
      const { error } = await supabase.rpc('verify_subagent' as any, {
        _record_id: id,
        _action: 'reject',
        _rejection_reason: rejectionReason.trim(),
      });
      if (error) throw error;
      toast.success('Sub-agent registration rejected.');
      setRejectingId(null);
      setRejectionReason('');
      queryClient.invalidateQueries({ queryKey: ['subagent-verification-queue'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to reject');
    } finally {
      setProcessingId(null);
    }
  };

  const openTransfer = (r: SubAgentRecord) => {
    setTransferRecord(r);
    setTransferSearch('');
    setTransferReason('');
    setNewParent(null);
    setParentResults([]);
  };

  const openUnlink = (r: SubAgentRecord) => {
    setUnlinkRecord(r);
    setUnlinkReason('');
  };

  const handleUnlink = async () => {
    if (!unlinkRecord) return;
    if (unlinkReason.trim().length < 10) {
      toast.error('Please provide a reason (at least 10 characters).');
      return;
    }
    setUnlinking(true);
    try {
      const { error } = await supabase.rpc('admin_unlink_subagent' as any, {
        _record_id: unlinkRecord.id,
        _reason: unlinkReason.trim(),
      });
      if (error) throw error;
      toast.success(`${unlinkRecord.sub_name} is now an independent agent.`, {
        description: 'Link archived and the action was logged.',
      });
      setUnlinkRecord(null);
      setSelectedRecord(null);
      queryClient.invalidateQueries({ queryKey: ['subagent-verification-queue'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to unlink');
    } finally {
      setUnlinking(false);
    }
  };

  const searchParents = async (term: string) => {
    setTransferSearch(term);
    setNewParent(null);
    const t = term.trim();
    if (t.length < 2) { setParentResults([]); return; }
    setSearchingParents(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .or(`full_name.ilike.%${t}%,phone.ilike.%${t}%`)
        .limit(15);
      if (error) throw error;
      setParentResults((data || []).filter(p => p.id !== transferRecord?.sub_agent_id && p.id !== transferRecord?.parent_agent_id));
    } catch (err: any) {
      toast.error(err.message || 'Search failed');
    } finally {
      setSearchingParents(false);
    }
  };

  const handleTransfer = async () => {
    if (!transferRecord || !newParent) return;
    if (transferReason.trim().length < 10) {
      toast.error('Please provide a reason (at least 10 characters).');
      return;
    }
    setTransferring(true);
    try {
      const { error } = await supabase.rpc('reassign_subagent_parent' as any, {
        _record_id: transferRecord.id,
        _new_parent_id: newParent.id,
        _reason: transferReason.trim(),
      });
      if (error) throw error;
      toast.success(`Transferred ${transferRecord.sub_name} to ${newParent.full_name}. Action logged.`);
      setTransferRecord(null);
      setSelectedRecord(null);
      queryClient.invalidateQueries({ queryKey: ['subagent-verification-queue'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to transfer');
    } finally {
      setTransferring(false);
    }
  };

  const renderCard = (r: SubAgentRecord, showActions: boolean) => (
    <div key={r.id} className="rounded-xl border border-border p-3 space-y-2 cursor-pointer hover:bg-muted/30 transition-colors" onClick={() => setSelectedRecord(r)}>
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5 min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground truncate">
            {r.sub_name}
          </p>
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Phone className="h-3 w-3" />{r.sub_phone}
          </p>
        </div>
        <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium shrink-0">
          {r.source}
        </span>
      </div>

      <div className="text-xs text-muted-foreground space-y-0.5">
        <p>Parent: <span className="font-medium text-foreground">{r.parent_name}</span> ({r.parent_phone})</p>
        <p className="flex items-center gap-1">
          <Calendar className="h-3 w-3" />
          {format(new Date(r.created_at), 'dd MMM yyyy HH:mm')}
        </p>
        {r.verified_at && (
          <p className="flex items-center gap-1 text-success">
            <CheckCircle className="h-3 w-3" />
            Verified {format(new Date(r.verified_at), 'dd MMM yyyy')}
          </p>
        )}
        {r.rejection_reason && (
          <p className="text-destructive">Reason: {r.rejection_reason}</p>
        )}
      </div>

      <div onClick={e => e.stopPropagation()} className="grid grid-cols-2 gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => openTransfer(r)}
          className="w-full gap-1 h-7 text-xs"
        >
          <ArrowLeftRight className="h-3 w-3" />
          Transfer
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => openUnlink(r)}
          className="w-full gap-1 h-7 text-xs text-destructive border-destructive/30 hover:bg-destructive/10"
        >
          <Unlink className="h-3 w-3" />
          Unlink
        </Button>
      </div>

      {showActions && (
        <div onClick={e => e.stopPropagation()}>
          {rejectingId === r.id ? (
            <div className="space-y-2">
              <Input
                placeholder="Reason for rejection (min 10 chars)"
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                maxLength={500}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => handleReject(r.id)}
                  disabled={processingId === r.id}
                  className="flex-1 gap-1"
                >
                  {processingId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                  Confirm Reject
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setRejectingId(null); setRejectionReason(''); }}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => handleVerify(r.id)}
                disabled={processingId === r.id}
                className="flex-1 gap-1"
              >
                {processingId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                Verify ✅
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRejectingId(r.id)}
                className="flex-1 gap-1"
              >
                <XCircle className="h-3 w-3" />
                Reject
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <UsersRound className="h-4 w-4 text-orange-500" />
          Sub-Agent Verification
          {pending.length > 0 && (
            <span className="ml-auto bg-destructive/10 text-destructive text-xs font-bold px-2 py-0.5 rounded-full">
              {pending.length}
            </span>
          )}
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setAssignOpen(true)}
          className="mt-2 w-full gap-1 h-8 text-xs"
        >
          <UserPlus className="h-3.5 w-3.5" />
          Assign agent as sub-agent
        </Button>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search by name or phone..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-xs"
          />
        </div>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full grid grid-cols-2 mb-3">
            <TabsTrigger
              value="pending"
              className="text-xs gap-1 relative data-[state=inactive]:animate-pulse data-[state=inactive]:bg-destructive/15 data-[state=inactive]:text-destructive"
            >
              <Clock className="h-3 w-3" />
              Pending ({pending.length})
              {pending.length > 0 && (
                <span className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center">
                  {pending.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="verified" className="text-xs gap-1">
              <CheckCircle className="h-3 w-3" />
              Verified ({verified.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pending">
            {isLoading ? (
              <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : pending.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No pending sub-agent registrations.</p>
            ) : (
              <div className="space-y-3">{pending.map(r => renderCard(r, true))}</div>
            )}
          </TabsContent>

          <TabsContent value="verified">
            {isLoading ? (
              <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : verified.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No verified sub-agents yet.</p>
            ) : (
              <div className="space-y-3">{verified.map(r => renderCard(r, false))}</div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>

      {/* Detail Sheet */}
      <Sheet open={!!selectedRecord} onOpenChange={(open) => { if (!open) setSelectedRecord(null); }}>
        <SheetContent side="bottom" className="h-[75vh] rounded-t-2xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <UsersRound className="h-4 w-4 text-primary" />
              Sub-Agent Details
            </SheetTitle>
          </SheetHeader>
          {selectedRecord && (
            <div className="space-y-4 mt-4 overflow-y-auto max-h-[calc(75vh-80px)] pb-6">
              {/* Status */}
              <div className="flex items-center justify-between">
                <span className={`text-xs px-3 py-1 rounded-full font-medium ${
                  selectedRecord.status === 'verified' ? 'bg-emerald-100 text-emerald-700' :
                  selectedRecord.status === 'rejected' ? 'bg-destructive/10 text-destructive' :
                  'bg-amber-100 text-amber-700'
                }`}>
                  {selectedRecord.status.charAt(0).toUpperCase() + selectedRecord.status.slice(1)}
                </span>
                <span className="text-xs text-muted-foreground">
                  Source: <span className="font-medium text-foreground">{selectedRecord.source}</span>
                </span>
              </div>

              {/* Sub-Agent Info */}
              <Card>
                <CardContent className="p-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase">Sub-Agent</p>
                  <p className="font-semibold text-base">{selectedRecord.sub_name}</p>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Phone className="h-3.5 w-3.5" />
                    <span>{selectedRecord.sub_phone}</span>
                  </div>
                </CardContent>
              </Card>

              {/* Parent Agent Info */}
              <Card>
                <CardContent className="p-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase">Parent Agent</p>
                  <p className="font-semibold">{selectedRecord.parent_name}</p>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Phone className="h-3.5 w-3.5" />
                    <span>{selectedRecord.parent_phone}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openTransfer(selectedRecord)}
                    className="w-full gap-1 mt-1"
                  >
                    <ArrowLeftRight className="h-3.5 w-3.5" />
                    Transfer to another agent
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openUnlink(selectedRecord)}
                    className="w-full gap-1 text-destructive border-destructive/30 hover:bg-destructive/10"
                  >
                    <Unlink className="h-3.5 w-3.5" />
                    Unlink — make independent agent
                  </Button>
                </CardContent>
              </Card>

              {/* Timeline */}
              <Card>
                <CardContent className="p-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase">Timeline</p>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex items-center gap-2">
                      <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-muted-foreground">Registered:</span>
                      <span className="font-medium">{format(new Date(selectedRecord.created_at), 'dd MMM yyyy HH:mm')}</span>
                    </div>
                    {selectedRecord.verified_at && (
                      <div className="flex items-center gap-2">
                        <CheckCircle className="h-3.5 w-3.5 text-emerald-600" />
                        <span className="text-muted-foreground">Verified:</span>
                        <span className="font-medium text-emerald-600">{format(new Date(selectedRecord.verified_at), 'dd MMM yyyy HH:mm')}</span>
                      </div>
                    )}
                    {selectedRecord.rejection_reason && (
                      <div className="mt-2 p-2 rounded-lg bg-destructive/5 border border-destructive/20">
                        <p className="text-xs font-medium text-destructive">Rejection Reason</p>
                        <p className="text-sm mt-0.5">{selectedRecord.rejection_reason}</p>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Transfer Dialog */}
      <Dialog open={!!transferRecord} onOpenChange={(open) => { if (!open) setTransferRecord(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <ArrowLeftRight className="h-4 w-4 text-primary" />
              Transfer Sub-Agent
            </DialogTitle>
          </DialogHeader>
          {transferRecord && (
            <div className="space-y-4">
              <div className="rounded-lg bg-muted/40 p-3 text-sm space-y-1">
                <p><span className="text-muted-foreground">Sub-agent:</span> <span className="font-semibold">{transferRecord.sub_name}</span> ({transferRecord.sub_phone})</p>
                <p><span className="text-muted-foreground">Current parent:</span> <span className="font-medium">{transferRecord.parent_name}</span></p>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground uppercase">New parent agent</label>
                {newParent ? (
                  <div className="flex items-center justify-between rounded-lg border border-primary/40 bg-primary/5 p-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{newParent.full_name}</p>
                      <p className="text-xs text-muted-foreground">{newParent.phone || '—'}</p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => { setNewParent(null); }}>Change</Button>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        placeholder="Search agent by name or phone..."
                        value={transferSearch}
                        onChange={e => searchParents(e.target.value)}
                        className="pl-8 h-9 text-sm"
                      />
                    </div>
                    {searchingParents ? (
                      <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
                    ) : parentResults.length > 0 ? (
                      <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg border border-border p-1">
                        {parentResults.map(p => (
                          <button
                            key={p.id}
                            onClick={() => setNewParent(p)}
                            className="w-full text-left rounded-md px-2.5 py-2 hover:bg-muted transition-colors"
                          >
                            <p className="text-sm font-medium truncate">{p.full_name || 'Unnamed'}</p>
                            <p className="text-xs text-muted-foreground">{p.phone || '—'}</p>
                          </button>
                        ))}
                      </div>
                    ) : transferSearch.trim().length >= 2 ? (
                      <p className="text-xs text-muted-foreground text-center py-2">No matching agents.</p>
                    ) : null}
                  </>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase">Reason (for audit log)</label>
                <Textarea
                  placeholder="Why is this sub-agent being transferred? (min 10 characters)"
                  value={transferReason}
                  onChange={e => setTransferReason(e.target.value)}
                  maxLength={500}
                  rows={3}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTransferRecord(null)} disabled={transferring}>Cancel</Button>
            <Button
              onClick={handleTransfer}
              disabled={transferring || !newParent || transferReason.trim().length < 10}
              className="gap-1"
            >
              {transferring ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeftRight className="h-4 w-4" />}
              Confirm Transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin: Assign agent as sub-agent */}
      <Dialog open={assignOpen} onOpenChange={(o) => { if (!o) resetAssignDialog(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-4 w-4" />
              Assign agent as sub-agent
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2 max-h-[70vh] overflow-y-auto">
            <p className="text-xs text-muted-foreground">
              Search for the agent you want to make a sub-agent, then search for their parent agent.
              If the agent already has a parent, they will be re-assigned. A reason is required and every
              action is logged in the audit trail.
            </p>

            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase">Agent to make a sub-agent</label>
              {assignSub ? (
                <div className="flex items-center justify-between rounded-lg border p-2 bg-muted/30">
                  <div className="text-sm">
                    <p className="font-medium">{assignSub.full_name}</p>
                    <p className="text-xs text-muted-foreground">{assignSub.phone || '—'}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setAssignSub(null)}>Change</Button>
                </div>
              ) : (
                <>
                  <Input
                    placeholder="Search by name or phone…"
                    value={assignSubSearch}
                    onChange={(e) => {
                      setAssignSubSearch(e.target.value);
                      searchAgents(e.target.value, setAssignSubResults, setAssignSearchingSub, assignParent?.id);
                    }}
                  />
                  {assignSearchingSub && <p className="text-xs text-muted-foreground">Searching…</p>}
                  {assignSubResults.length > 0 && (
                    <div className="rounded-lg border divide-y max-h-48 overflow-y-auto">
                      {assignSubResults.map((p) => (
                        <button
                          key={p.id}
                          className="w-full text-left p-2 hover:bg-muted/40 text-sm"
                          onClick={() => { setAssignSub(p); setAssignSubResults([]); setAssignSubSearch(''); }}
                        >
                          <p className="font-medium">{p.full_name}</p>
                          <p className="text-xs text-muted-foreground">{p.phone || '—'}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase">Parent agent</label>
              {assignParent ? (
                <div className="flex items-center justify-between rounded-lg border p-2 bg-muted/30">
                  <div className="text-sm">
                    <p className="font-medium">{assignParent.full_name}</p>
                    <p className="text-xs text-muted-foreground">{assignParent.phone || '—'}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setAssignParent(null)}>Change</Button>
                </div>
              ) : (
                <>
                  <Input
                    placeholder="Search by name or phone…"
                    value={assignParentSearch}
                    onChange={(e) => {
                      setAssignParentSearch(e.target.value);
                      searchAgents(e.target.value, setAssignParentResults, setAssignSearchingParent, assignSub?.id);
                    }}
                  />
                  {assignSearchingParent && <p className="text-xs text-muted-foreground">Searching…</p>}
                  {assignParentResults.length > 0 && (
                    <div className="rounded-lg border divide-y max-h-48 overflow-y-auto">
                      {assignParentResults.map((p) => (
                        <button
                          key={p.id}
                          className="w-full text-left p-2 hover:bg-muted/40 text-sm"
                          onClick={() => { setAssignParent(p); setAssignParentResults([]); setAssignParentSearch(''); }}
                        >
                          <p className="font-medium">{p.full_name}</p>
                          <p className="text-xs text-muted-foreground">{p.phone || '—'}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase">Reason (for audit log)</label>
              <Textarea
                placeholder="Why is this agent being made a sub-agent? (min 10 characters)"
                value={assignReason}
                onChange={(e) => setAssignReason(e.target.value)}
                maxLength={500}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={resetAssignDialog} disabled={assigning}>Cancel</Button>
            <Button
              onClick={handleAssign}
              disabled={assigning || !assignSub || !assignParent || assignReason.trim().length < 10}
              className="gap-1"
            >
              {assigning ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              Confirm Assignment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unlink → independent agent */}
      <Dialog open={!!unlinkRecord} onOpenChange={(open) => { if (!open && !unlinking) setUnlinkRecord(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Unlink className="h-4 w-4 text-destructive" />
              Make independent agent
            </DialogTitle>
          </DialogHeader>
          {unlinkRecord && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{unlinkRecord.sub_name}</span> will be detached from{' '}
                <span className="font-medium text-foreground">{unlinkRecord.parent_name}</span> and will operate as a fully
                independent agent. Their tenants stay with them — nothing is transferred — and they keep the full
                commission going forward. Pending tenant transfers between them are cancelled and any suspension
                placed by the parent is lifted.
              </p>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase">Reason (for audit log)</label>
                <Textarea
                  placeholder="Why is this agent being made independent? (min 10 characters)"
                  value={unlinkReason}
                  onChange={(e) => setUnlinkReason(e.target.value)}
                  maxLength={500}
                  rows={3}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUnlinkRecord(null)} disabled={unlinking}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleUnlink}
              disabled={unlinking || unlinkReason.trim().length < 10}
              className="gap-1"
            >
              {unlinking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
              Unlink agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
