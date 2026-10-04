import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Loader2, RotateCcw, ShieldCheck, XCircle, Search, ChevronDown, ChevronUp, Trash2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatLocation, locationHaystack } from '@/lib/locationText';

type RejectedStage =
  | 'pending'
  | 'agent_ops_approved'
  | 'tenant_ops_approved'
  | 'agent_verified'
  | 'landlord_ops_approved'
  | 'partner_ops_approved'
  | 'coo_approved';

const STAGE_LABEL: Record<string, string> = {
  pending: 'Agent Ops',
  agent_ops_approved: 'Tenant Ops',
  tenant_ops_approved: 'Landlord Ops',
  agent_verified: 'Landlord Ops (legacy)',
  landlord_ops_approved: 'Partner Ops',
  partner_ops_approved: 'COO',
  coo_approved: 'CFO',
};

const STAGE_NEXT: Record<string, string> = {
  pending: 'tenant_ops_approved',
  tenant_ops_approved: 'agent_verified',
  agent_verified: 'landlord_ops_approved',
  landlord_ops_approved: 'partner_ops_approved',
  partner_ops_approved: 'coo_approved',
  coo_approved: 'funded',
};

interface RejectedRow {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  landlord_id: string | null;
  rent_amount: number;
  status: string;
  rejected_reason: string | null;
  rejected_at: string | null;
  rejected_at_stage: string | null;
  reopen_count: number;
  reopened_at: string | null;
  reopen_reason: string | null;
  created_at: string;
  tenant_name?: string;
  tenant_phone?: string;
  tenant_address?: string;
  landlord_address?: string;
  search_text?: string;
}

interface Props {
  /** When provided, only rows whose rejected_at_stage matches are shown. */
  stageFilter?: RejectedStage | RejectedStage[];
  /** Card title — defaults to "Rejected Rent Requests". */
  title?: string;
  /** When true, renders a collapsible card. Defaults to false. */
  collapsible?: boolean;
  /** When collapsible, whether the card starts collapsed. Defaults to true. */
  defaultCollapsed?: boolean;
}

export function RejectedRequestsQueue({ stageFilter, title = 'Rejected Rent Requests', collapsible = false, defaultCollapsed = true }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [active, setActive] = useState<RejectedRow | null>(null);
  const [mode, setMode] = useState<'reopen' | 'force'>('reopen');
  const [reason, setReason] = useState('');
  const [payoutRef, setPayoutRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState(collapsible ? defaultCollapsed : false);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [requestToDelete, setRequestToDelete] = useState<RejectedRow | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['rejected-rent-requests'] });
    qc.invalidateQueries({ queryKey: ['rent-pipeline'] });
    qc.invalidateQueries({ queryKey: ['tenant-ops-rejected-count'] });
    qc.invalidateQueries({ queryKey: ['pipeline-counts'] });
    qc.invalidateQueries({ queryKey: ['agent-ops-counts'] });
    qc.invalidateQueries({ queryKey: ['agent-ops-rejected-history'] });
  };

  const handleDeleteSingle = async () => {
    if (!requestToDelete) return;
    const targetId = requestToDelete.id;
    setDeletingId(targetId);
    setRequestToDelete(null);

    try {
      const { error: edgeErr } = await supabase.functions.invoke('delete-rent-request', {
        body: { rent_request_id: targetId },
      });
      if (edgeErr) {
        const { error: directErr } = await supabase.from('rent_requests').delete().eq('id', targetId);
        if (directErr) throw directErr;
      }
      toast({
        title: '🗑️ Request deleted',
        description: `Rejected request for ${requestToDelete.tenant_name} has been deleted.`,
      });
      invalidateAll();
    } catch (err: any) {
      toast({
        title: 'Delete failed',
        description: err.message || 'Could not delete rent request',
        variant: 'destructive',
      });
    } finally {
      setDeletingId(null);
    }
  };

  const handleBulkDeleteAll = async () => {
    if (filtered.length === 0) return;
    setIsBulkDeleting(true);

    let successCount = 0;
    let failCount = 0;

    for (const req of filtered) {
      try {
        const { error: edgeErr } = await supabase.functions.invoke('delete-rent-request', {
          body: { rent_request_id: req.id },
        });
        if (edgeErr) {
          const { error: directErr } = await supabase.from('rent_requests').delete().eq('id', req.id);
          if (directErr) throw directErr;
        }
        successCount++;
      } catch {
        failCount++;
      }
    }

    setIsBulkDeleting(false);
    setBulkDeleteOpen(false);
    invalidateAll();

    if (failCount === 0) {
      toast({
        title: '✅ All rejected requests deleted',
        description: `Successfully removed ${successCount} rejected request${successCount === 1 ? '' : 's'}.`,
      });
    } else {
      toast({
        title: `Deleted ${successCount} requests`,
        description: `${failCount} requests could not be removed.`,
        variant: 'destructive',
      });
    }
  };

  // Capability check — manager/CFO can force-approve
  const { data: caps } = useQuery({
    queryKey: ['rejected-queue-caps', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user!.id);
      const roles = new Set((data ?? []).map((r) => r.role));
      return {
        canForce: roles.has('manager') || roles.has('cfo'),
        isManager: roles.has('manager'),
      };
    },
  });

  const stages: RejectedStage[] | null = stageFilter
    ? Array.isArray(stageFilter) ? stageFilter : [stageFilter]
    : null;

  const { data: rows, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['rejected-rent-requests', stages?.join(',') ?? 'all'],
    queryFn: async () => {
      let q = supabase
        .from('rent_requests')
        .select('id, tenant_id, agent_id, landlord_id, rent_amount, status, rejected_reason, rejected_at, rejected_at_stage, reopen_count, reopened_at, reopen_reason, created_at')
        .eq('status', 'rejected')
        .order('rejected_at', { ascending: false, nullsFirst: false })
        .limit(200);
      if (stages && stages.length > 0) q = q.in('rejected_at_stage', stages);
      const { data, error } = await q;
      if (error) throw error;
      const tenantIds = [...new Set((data ?? []).map((r) => r.tenant_id).filter(Boolean))];
      const landlordIds = [...new Set((data ?? []).map((r) => r.landlord_id).filter(Boolean))] as string[];
      const [profiles, landlords] = await Promise.all([
        tenantIds.length
          ? supabase
              .from('profiles')
              .select('id, full_name, phone, region, district, sub_county, parish, village, city, town, landmark')
              .in('id', tenantIds)
              .then((res) => res.data ?? [])
          : Promise.resolve([] as any[]),
        landlordIds.length
          ? supabase
              .from('landlords')
              .select('id, name, property_address, region, district, sub_county, village')
              .in('id', landlordIds)
              .then((res) => res.data ?? [])
          : Promise.resolve([] as any[]),
      ]);
      const pmap = new Map<string, any>(profiles.map((p: any) => [p.id, p] as [string, any]));
      const lmap = new Map<string, any>(landlords.map((l: any) => [l.id, l] as [string, any]));
      return (data ?? []).map((r) => {
        const t = pmap.get(r.tenant_id) as any;
        const l = r.landlord_id ? (lmap.get(r.landlord_id) as any) : null;
        const tenantAddress = formatLocation([
          t?.landmark, t?.village, t?.parish, t?.sub_county, t?.city || t?.town, t?.district, t?.region,
        ]);
        const landlordAddress = formatLocation([
          l?.property_address, l?.village, l?.sub_county, l?.district, l?.region,
        ]);
        return {
          ...r,
          tenant_name: t?.full_name ?? 'Unknown',
          tenant_phone: t?.phone ?? '',
          tenant_address: tenantAddress,
          landlord_address: landlordAddress,
          search_text: locationHaystack([
            t?.full_name, t?.phone, l?.name, r.rejected_reason, tenantAddress, landlordAddress,
          ]),
        };
      }) as RejectedRow[];
    },
  });

  const filtered = useMemo(() => {
    if (!rows) return [];
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter((r) => (r.search_text ?? '').includes(s));
  }, [rows, search]);

  const openDialog = (row: RejectedRow, m: 'reopen' | 'force') => {
    setActive(row);
    setMode(m);
    setReason('');
    setPayoutRef('');
  };

  const submit = async () => {
    if (!active || !user) return;
    if (reason.trim().length < 10) {
      toast({ title: 'Reason must be at least 10 characters', variant: 'destructive' });
      return;
    }
    const stage = active.rejected_at_stage ?? 'pending';
    if (mode === 'force' && STAGE_NEXT[stage] === 'funded' && !payoutRef.trim()) {
      toast({ title: 'Transaction reference (TID) is required', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'reopen') {
        const { error } = await supabase.rpc('reopen_rent_request', {
          p_request_id: active.id,
          p_reason: reason.trim(),
        });
        if (error) throw error;
        toast({ title: '🔁 Reopened', description: `Returned to ${STAGE_LABEL[stage] ?? stage}` });
      } else {
        const { error } = await supabase.rpc('force_approve_rejected_rent_request', {
          p_request_id: active.id,
          p_reason: reason.trim(),
          p_payout_ref: payoutRef.trim() || null,
        });
        if (error) throw error;
        toast({ title: '⚡ Force-approved', description: `Advanced past ${STAGE_LABEL[stage] ?? stage}` });
      }
      setActive(null);
      qc.invalidateQueries({ queryKey: ['rejected-rent-requests'] });
      qc.invalidateQueries({ queryKey: ['rent-pipeline'] });
    } catch (e: any) {
      toast({ title: 'Action failed', description: e.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div
          className={cn(collapsible && 'cursor-pointer select-none flex-1')}
          onClick={collapsible ? () => setCollapsed((c) => !c) : undefined}
        >
          <CardTitle className="flex items-center gap-2">
            {collapsible && (
              collapsed
                ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                : <ChevronUp className="w-4 h-4 text-muted-foreground" />
            )}
            <XCircle className="w-5 h-5 text-destructive" />
            {title}
            <Badge variant="outline" className="ml-1">{rows?.length ?? 0}</Badge>
          </CardTitle>
          {!collapsed && (
            <p className="text-xs text-muted-foreground mt-1">
              Reopen sends the request back to the stage that rejected it.
              {caps?.canForce && ' Force-approve advances it directly to the next stage.'}
            </p>
          )}
        </div>
        {!collapsed && (
          <div className="flex items-center gap-2">
            {filtered.length > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkDeleteOpen(true)}
                disabled={isBulkDeleting}
                className="gap-1.5 font-bold"
              >
                {isBulkDeleting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
                <span>Delete All ({filtered.length})</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
              {isRefetching ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-2" />}
              Refresh
            </Button>
          </div>
        )}
      </CardHeader>
      {!collapsed && (
      <CardContent className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search tenant, phone, district, address, or rejection reason"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-muted-foreground py-8 text-sm">
            No rejected requests in this scope.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2.5 pr-3">Tenant</th>
                  <th className="py-2.5 pr-3 text-right">Rent (UGX)</th>
                  <th className="py-2.5 pr-3">Rejected at</th>
                  <th className="py-2.5 pr-3 text-xs">Reopens</th>
                  <th className="py-2.5 pr-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const stage = r.rejected_at_stage ?? 'pending';
                  const locked = (r.reopen_count ?? 0) >= 5 && !caps?.isManager;
                  return (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40 transition-colors">
                      <td className="py-2.5 pr-3">
                        <div className="font-medium text-sm">{r.tenant_name}</div>
                        <div className="text-xs text-muted-foreground">{r.tenant_phone || r.id.slice(0, 8)}</div>
                        {(r.landlord_address || r.tenant_address) && (
                          <div className="text-xs text-muted-foreground truncate max-w-sm">
                            📍 {r.landlord_address || r.tenant_address}
                          </div>
                        )}
                        {r.rejected_reason && (
                          <div className="text-xs text-muted-foreground line-clamp-1 italic mt-0.5 max-w-sm" title={r.rejected_reason}>
                            <span className="font-medium not-italic text-foreground/70">Reason:</span> {r.rejected_reason}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-medium whitespace-nowrap">
                        {Number(r.rent_amount || 0).toLocaleString()}
                      </td>
                      <td className="py-2.5 pr-3">
                        <Badge variant="outline" className="bg-amber-500/10 text-amber-700 border-amber-500/30 whitespace-nowrap">
                          {STAGE_LABEL[stage] ?? stage}
                        </Badge>
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-muted-foreground whitespace-nowrap">
                        {r.reopen_count ?? 0}
                        {locked && <span className="ml-1 text-destructive font-medium">(locked)</span>}
                      </td>
                      <td className="py-2.5 pr-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-2.5 text-xs"
                            onClick={() => openDialog(r, 'reopen')}
                            disabled={locked}
                            title={locked ? 'Reopen limit reached — manager only' : 'Send back to rejecting stage'}
                          >
                            <RotateCcw className="w-3.5 h-3.5 mr-1" /> Reopen
                          </Button>
                          {caps?.canForce && (
                            <Button
                              size="sm"
                              variant="default"
                              className="h-8 px-2.5 text-xs"
                              onClick={() => openDialog(r, 'force')}
                              title="Skip the chain and advance to next stage"
                            >
                              <ShieldCheck className="w-3.5 h-3.5 mr-1" /> Force-approve
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-8 w-8 p-0 shrink-0 shadow-sm"
                            onClick={() => setRequestToDelete(r)}
                            disabled={deletingId === r.id}
                            title="Delete this rejected request"
                          >
                            {deletingId === r.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="w-3.5 h-3.5" />
                            )}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      )}

      <Dialog open={!!active} onOpenChange={(o) => !o && setActive(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mode === 'reopen' ? 'Reopen rent request' : 'Force-approve rejected request'}
            </DialogTitle>
            <DialogDescription>
              {active && mode === 'reopen' && (
                <>Returns to <strong>{STAGE_LABEL[active.rejected_at_stage ?? 'pending']}</strong> for fresh review.</>
              )}
              {active && mode === 'force' && (
                <>Advances directly to <strong>{STAGE_LABEL[STAGE_NEXT[active.rejected_at_stage ?? 'pending']] ?? STAGE_NEXT[active.rejected_at_stage ?? 'pending']}</strong>, skipping re-review.</>
              )}
            </DialogDescription>
          </DialogHeader>
          {active && (
            <div className="space-y-3 text-sm">
              <div className="rounded-md bg-muted p-3 space-y-1">
                <div><span className="text-muted-foreground">Tenant:</span> {active.tenant_name}</div>
                {active.tenant_address && (
                  <div><span className="text-muted-foreground">Tenant address:</span> {active.tenant_address}</div>
                )}
                {active.landlord_address && (
                  <div><span className="text-muted-foreground">Property address:</span> {active.landlord_address}</div>
                )}
                <div><span className="text-muted-foreground">Rent:</span> UGX {Number(active.rent_amount || 0).toLocaleString()}</div>
                <div className="line-clamp-3"><span className="text-muted-foreground">Original reason:</span> {active.rejected_reason ?? '—'}</div>
              </div>
              <div>
                <label className="text-xs font-medium">
                  {mode === 'reopen' ? 'Reopen reason' : 'Override justification'} (min 10 characters)
                </label>
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
              </div>
              {mode === 'force' && STAGE_NEXT[active.rejected_at_stage ?? 'pending'] === 'funded' && (
                <div>
                  <label className="text-xs font-medium">Transaction Reference (TID)</label>
                  <Input value={payoutRef} onChange={(e) => setPayoutRef(e.target.value)} placeholder="MoMo / bank reference" />
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setActive(null)}>Cancel</Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Single Delete Dialog */}
      <AlertDialog open={!!requestToDelete} onOpenChange={(open) => !open && setRequestToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete Rejected Request?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the rejected rent request of{' '}
              <strong>{requestToDelete?.tenant_name}</strong> (UGX{' '}
              {requestToDelete?.rent_amount?.toLocaleString()}). This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSingle}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm Bulk Delete All Dialog */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete All {filtered.length} Rejected Requests?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to permanently delete all{' '}
              <strong>{filtered.length}</strong> rejected requests in this view? This action is immediate and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBulkDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDeleteAll}
              disabled={isBulkDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 gap-1.5"
            >
              {isBulkDeleting && <Loader2 className="h-4 w-4 animate-spin" />}
              <span>Delete All {filtered.length}</span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default RejectedRequestsQueue;