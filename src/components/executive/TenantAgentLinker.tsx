import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { UserSearchPicker } from '@/components/cfo/UserSearchPicker';
import { AlertTriangle, ArrowDown, ArrowRightLeft, ArrowUp, ArrowUpDown, CalendarX2, Link2, Loader2, MapPin, User } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { TenantReassignmentSuggestions } from './TenantReassignmentSuggestions';
import { useCaptureLocation } from '@/hooks/useCaptureLocation';

interface SelectedUser {
  id: string;
  full_name: string;
  phone: string;
}

type ActorLocationStatus = 'captured' | 'denied' | 'unavailable' | 'timeout' | 'unsupported';

// Agent earns ~2% of rent collections — see RegisterTenantDialog.tsx for source rate.
const AGENT_COMMISSION_RATE = 0.02;
const MISSED_DAYS_FLAG_THRESHOLD = 7;

/**
 * Estimate how many daily payments a tenant has missed on a single rent request.
 * Compares calendar days since disbursement against the days actually covered by
 * the amount they have repaid (amount_repaid / daily_repayment).
 */
function computeMissedDays(rr: {
  disbursed_at?: string | null;
  amount_repaid?: number | string | null;
  daily_repayment?: number | string | null;
}): number {
  if (!rr.disbursed_at) return 0;
  const daily = Number(rr.daily_repayment || 0);
  if (daily <= 0) return 0;
  const start = new Date(rr.disbursed_at).getTime();
  if (Number.isNaN(start)) return 0;
  const daysElapsed = Math.max(0, Math.floor((Date.now() - start) / (24 * 60 * 60 * 1000)));
  const daysCovered = Math.floor(Number(rr.amount_repaid || 0) / daily);
  return Math.max(0, daysElapsed - daysCovered);
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return `${days} d ago`;
}

function haversineKm(
  a: { latitude: number; longitude: number } | null,
  b: { latitude: number; longitude: number } | null,
): number | null {
  if (!a || !b) return null;
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function TenantAgentLinker() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedTenant, setSelectedTenant] = useState<SelectedUser | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<SelectedUser | null>(null);
  const [transferReason, setTransferReason] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [previewSortKey, setPreviewSortKey] = useState<'id' | 'agent' | 'amount'>('amount');
  const [previewSortDir, setPreviewSortDir] = useState<'asc' | 'desc'>('desc');
  const { captureLocation: captureActorLocation } = useCaptureLocation();
  const [lastActorStatus, setLastActorStatus] = useState<ActorLocationStatus | null>(null);
  const [lastActorAccuracy, setLastActorAccuracy] = useState<number | null>(null);

  // Capture executive geo before running an action; never blocks the action.
  const captureActorContext = async (): Promise<{
    actor_latitude: number | null;
    actor_longitude: number | null;
    actor_accuracy: number | null;
    actor_location_status: ActorLocationStatus;
  }> => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLastActorStatus('unsupported');
      toast({ title: '📍 Location unavailable', description: 'Browser does not support geolocation — proceeding without it.' });
      return { actor_latitude: null, actor_longitude: null, actor_accuracy: null, actor_location_status: 'unsupported' };
    }
    try {
      const loc = await captureActorLocation();
      if (loc) {
        setLastActorStatus('captured');
        setLastActorAccuracy(loc.accuracy ?? null);
        return {
          actor_latitude: loc.latitude,
          actor_longitude: loc.longitude,
          actor_accuracy: loc.accuracy,
          actor_location_status: 'captured',
        };
      }
      setLastActorStatus('unavailable');
      setLastActorAccuracy(null);
      toast({ title: '📍 Location unavailable', description: 'Proceeding without geo — action will be tagged accordingly.' });
      return { actor_latitude: null, actor_longitude: null, actor_accuracy: null, actor_location_status: 'unavailable' };
    } catch {
      setLastActorStatus('denied');
      setLastActorAccuracy(null);
      toast({ title: '📍 Location denied', description: 'Proceeding without geo — action will be tagged accordingly.' });
      return { actor_latitude: null, actor_longitude: null, actor_accuracy: null, actor_location_status: 'denied' };
    }
  };

  // Reset preview sort each time the confirm dialog opens so it doesn't leak between transfers.
  useEffect(() => {
    if (confirmOpen) {
      setPreviewSortKey('amount');
      setPreviewSortDir('desc');
    }
  }, [confirmOpen]);

  const handlePreviewSort = (key: 'id' | 'agent' | 'amount') => {
    setPreviewSortKey((prevKey) => {
      if (prevKey === key) {
        setPreviewSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      setPreviewSortDir(key === 'amount' ? 'desc' : 'asc');
      return key;
    });
  };

  // Fetch active rent requests for selected tenant
  const { data: tenantRequests, isLoading: loadingRequests } = useQuery({
    queryKey: ['tenant-rent-requests', selectedTenant?.id],
    enabled: !!selectedTenant,
    queryFn: async () => {
      const { data } = await supabase
        .from('rent_requests')
        .select('id, status, rent_amount, amount_repaid, total_repayment, daily_repayment, agent_id, created_at, disbursed_at')
        .eq('tenant_id', selectedTenant!.id)
        .in('status', ['pending', 'funded', 'disbursed', 'repaying', 'approved', 'tenant_ops_approved', 'agent_verified', 'landlord_ops_approved', 'coo_approved'])
        .order('created_at', { ascending: false })
        .limit(10);

      if (!data || data.length === 0) return [];

      // Fetch agent names
      const agentIds = [...new Set(data.map(r => r.agent_id).filter(Boolean))];
      let agentMap = new Map<string, string>();
      if (agentIds.length > 0) {
        const { data: agents } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', agentIds);
        if (agents) agents.forEach(a => agentMap.set(a.id, a.full_name || '—'));
      }

      return data.map(r => ({
        ...r,
        agent_name: r.agent_id ? agentMap.get(r.agent_id) || '—' : 'No agent',
        outstanding: Number(r.total_repayment || 0) - Number(r.amount_repaid || 0),
        missed_days: computeMissedDays(r),
      }));
    },
  });

  const linkMutation = useMutation({
    mutationFn: async (rentRequestId: string) => {
      if (!selectedAgent) throw new Error('Select an agent first');
      const geo = await captureActorContext();
      const { error } = await supabase
        .from('rent_requests')
        .update({ agent_id: selectedAgent.id })
        .eq('id', rentRequestId);
      if (error) throw error;
      // Best-effort audit log; never block UX on logging failures.
      try {
        await supabase.from('audit_logs').insert({
          action_type: 'agent_linked',
          table_name: 'rent_requests',
          record_id: rentRequestId,
          metadata: {
            tenant_id: selectedTenant?.id ?? null,
            agent_id: selectedAgent.id,
            actor_latitude: geo.actor_latitude,
            actor_longitude: geo.actor_longitude,
            actor_accuracy: geo.actor_accuracy,
            actor_location_status: geo.actor_location_status,
            reason: 'manual_link',
          },
        });
      } catch (_) {
        // ignore audit failures
      }
    },
    onSuccess: () => {
      toast({ title: '✅ Agent linked', description: `${selectedAgent?.full_name} is now responsible for ${selectedTenant?.full_name}` });
      qc.invalidateQueries({ queryKey: ['tenant-rent-requests', selectedTenant?.id] });
      qc.invalidateQueries({ queryKey: ['exec-tenant-ops'] });
    },
    onError: (e: any) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  // Determine current (most common) agent across tenant's active requests
  const currentAgentId = (() => {
    if (!tenantRequests || tenantRequests.length === 0) return null;
    const counts = new Map<string, number>();
    tenantRequests.forEach((r: any) => {
      if (r.agent_id) counts.set(r.agent_id, (counts.get(r.agent_id) || 0) + 1);
    });
    let top: string | null = null;
    let max = 0;
    counts.forEach((v, k) => { if (v > max) { max = v; top = k; } });
    return top;
  })();

  // Last-known locations for tenant + selected agent (most recent row per user).
  const locationLookupIds = useMemo(() => {
    const ids = new Set<string>();
    if (selectedTenant?.id) ids.add(selectedTenant.id);
    if (selectedAgent?.id) ids.add(selectedAgent.id);
    return Array.from(ids);
  }, [selectedTenant?.id, selectedAgent?.id]);

  const { data: lastKnownLocations } = useQuery({
    queryKey: ['tenant-linker-last-locations', locationLookupIds.join(',')],
    enabled: locationLookupIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from('user_locations')
        .select('user_id, latitude, longitude, accuracy, city, country, captured_at')
        .in('user_id', locationLookupIds)
        .order('captured_at', { ascending: false })
        .limit(50);
      const byUser = new Map<string, any>();
      (data || []).forEach((row: any) => {
        if (!byUser.has(row.user_id)) byUser.set(row.user_id, row);
      });
      return byUser;
    },
  });

  const tenantLastLoc = selectedTenant ? lastKnownLocations?.get(selectedTenant.id) : null;
  const agentLastLoc = selectedAgent ? lastKnownLocations?.get(selectedAgent.id) : null;
  const tenantAgentDistanceKm = haversineKm(
    tenantLastLoc ? { latitude: Number(tenantLastLoc.latitude), longitude: Number(tenantLastLoc.longitude) } : null,
    agentLastLoc ? { latitude: Number(agentLastLoc.latitude), longitude: Number(agentLastLoc.longitude) } : null,
  );

  // Validation helpers reused by the preview button and the confirm dialog.
  const movingRequests = (tenantRequests || []).filter(
    (r: any) => currentAgentId && r.agent_id === currentAgentId
  );
  const sameAgent = !!selectedAgent && !!currentAgentId && currentAgentId === selectedAgent.id;
  const hasMovableRequests = movingRequests.length > 0;
  const reasonValid = transferReason.trim().length >= 10;
  const canSubmitTransfer = !sameAgent && hasMovableRequests && reasonValid;

  // Missed-days flagging: tenant is "at risk" if ANY of their active requests
  // has missed >= 7 daily payments. Used to nudge ops before transferring.
  const flaggedRequests = (tenantRequests || []).filter(
    (r: any) => (r.missed_days ?? 0) >= MISSED_DAYS_FLAG_THRESHOLD,
  );
  const tenantIsFlagged = flaggedRequests.length > 0;
  const worstMissedDays = flaggedRequests.reduce(
    (max: number, r: any) => Math.max(max, Number(r.missed_days || 0)),
    0,
  );

  // Revenue-loss projection for the source agent if we transfer.
  // We use the outstanding balance the source agent will no longer collect on
  // and apply the platform's standard agent commission rate (2%).
  const sourceAgentName =
    movingRequests.find((r: any) => r.agent_name && r.agent_name !== '—')?.agent_name ?? 'Current agent';
  const movingOutstanding = movingRequests.reduce(
    (s: number, r: any) => s + Number(r.outstanding || 0),
    0,
  );
  const projectedCommissionLoss = Math.round(movingOutstanding * AGENT_COMMISSION_RATE);

  const transferAllMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTenant) throw new Error('Select a tenant');
      if (!selectedAgent) throw new Error('Select a new agent');
      if (!currentAgentId) throw new Error('No current agent found on active requests');
      if (currentAgentId === selectedAgent.id) throw new Error('New agent is the same as current agent');
      if (transferReason.trim().length < 10) throw new Error('Please enter a reason (min 10 characters)');

      const geo = await captureActorContext();
      const { data, error } = await supabase.functions.invoke('transfer-tenant', {
        body: {
          tenant_id: selectedTenant.id,
          from_agent_id: currentAgentId,
          to_agent_id: selectedAgent.id,
          reason: transferReason.trim(),
          flag_type: 'manual',
          actor_latitude: geo.actor_latitude,
          actor_longitude: geo.actor_longitude,
          actor_accuracy: geo.actor_accuracy,
          actor_location_status: geo.actor_location_status,
        },
      });
      if (error) throw new Error(error.message || 'Transfer failed');
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
    onSuccess: (data: any) => {
      toast({
        title: '✅ Tenant transferred',
        description: `${data?.rent_requests_updated ?? 0} request(s) and ${data?.subscriptions_updated ?? 0} subscription(s) reassigned to ${selectedAgent?.full_name}.`,
      });
      setTransferReason('');
      qc.invalidateQueries({ queryKey: ['tenant-rent-requests', selectedTenant?.id] });
      qc.invalidateQueries({ queryKey: ['exec-tenant-ops'] });
    },
    onError: (e: any) => toast({ title: 'Transfer failed', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <TenantReassignmentSuggestions
        onApply={(tenant, agent) => {
          setSelectedTenant(tenant);
          setSelectedAgent(agent);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" />
            Link Agent to Tenant
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <UserSearchPicker
            label="Search Tenant"
            placeholder="Tenant name or phone..."
            selectedUser={selectedTenant}
            onSelect={(u) => { setSelectedTenant(u); }}
            roleFilter="tenant"
          />
          {selectedTenant && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground -mt-1.5 px-1">
              <MapPin className="h-3 w-3" />
              {tenantLastLoc ? (
                <span>
                  Tenant last seen:{' '}
                  <span className="font-medium text-foreground">
                    {tenantLastLoc.city || tenantLastLoc.country || `${Number(tenantLastLoc.latitude).toFixed(3)}, ${Number(tenantLastLoc.longitude).toFixed(3)}`}
                  </span>{' '}
                  · {formatRelativeTime(tenantLastLoc.captured_at)}
                </span>
              ) : (
                <span>No location on file for tenant</span>
              )}
            </div>
          )}

          <UserSearchPicker
            label="Search Agent"
            placeholder="Agent name or phone..."
            selectedUser={selectedAgent}
            onSelect={setSelectedAgent}
            roleFilter="agent"
          />
          {selectedAgent && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground -mt-1.5 px-1">
              <MapPin className="h-3 w-3" />
              {agentLastLoc ? (
                <span>
                  Agent last seen:{' '}
                  <span className="font-medium text-foreground">
                    {agentLastLoc.city || agentLastLoc.country || `${Number(agentLastLoc.latitude).toFixed(3)}, ${Number(agentLastLoc.longitude).toFixed(3)}`}
                  </span>{' '}
                  · {formatRelativeTime(agentLastLoc.captured_at)}
                </span>
              ) : (
                <span>No location on file for agent</span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bulk Transfer (move tenant from current agent → new agent) */}
      {selectedTenant && selectedAgent && currentAgentId && currentAgentId !== selectedAgent.id && (
        <Card className="border-primary/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-primary" />
              Transfer Tenant to New Agent
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Alert>
              <AlertDescription className="text-xs">
                This reassigns ALL active rent requests and subscriptions for{' '}
                <span className="font-semibold">{selectedTenant.full_name}</span> from the current agent
                to <span className="font-semibold">{selectedAgent.full_name}</span>. Both agents and the tenant will be notified.
              </AlertDescription>
            </Alert>

            {tenantIsFlagged && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  <span className="font-semibold">Tenant flagged:</span> {flaggedRequests.length}{' '}
                  active request{flaggedRequests.length === 1 ? '' : 's'} {flaggedRequests.length === 1 ? 'has' : 'have'} missed{' '}
                  <span className="font-semibold">{worstMissedDays}+ daily payments</span> (≥ {MISSED_DAYS_FLAG_THRESHOLD} days).
                  Consider whether transferring will improve collection or simply move the problem.
                </AlertDescription>
              </Alert>
            )}

            {hasMovableRequests && (
              <Alert className="border-amber-500/40 bg-amber-500/10">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <AlertDescription className="text-xs space-y-1">
                  <div>
                    <span className="font-semibold">{sourceAgentName}</span> will lose collection rights on{' '}
                    <span className="font-semibold">{movingRequests.length}</span> rent request{movingRequests.length === 1 ? '' : 's'}.
                  </div>
                  <div>
                    Estimated commission forgone:{' '}
                    <span className="font-semibold">UGX {projectedCommissionLoss.toLocaleString()}</span>{' '}
                    <span className="text-muted-foreground">
                      (~2% of UGX {movingOutstanding.toLocaleString()} outstanding).
                    </span>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            <Textarea
              placeholder="Reason for transfer (min 10 characters) — e.g., agent unavailable, tenant relocated, performance issue..."
              value={transferReason}
              onChange={(e) => setTransferReason(e.target.value)}
              rows={2}
              className="text-xs"
            />
            {sameAgent && (
              <Alert variant="destructive">
                <AlertDescription className="text-xs">
                  The selected new agent is the same as the current agent. Pick a different agent to transfer to.
                </AlertDescription>
              </Alert>
            )}
            {!sameAgent && !hasMovableRequests && !loadingRequests && (
              <Alert variant="destructive">
                <AlertDescription className="text-xs">
                  No active rent requests on the source agent are available to transfer.
                </AlertDescription>
              </Alert>
            )}
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={transferAllMutation.isPending || !canSubmitTransfer || loadingRequests}
              className="w-full gap-1.5"
              size="sm"
            >
              {transferAllMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRightLeft className="h-4 w-4" />
              )}
              {hasMovableRequests
                ? `Preview & Transfer ${movingRequests.length} request${movingRequests.length === 1 ? '' : 's'} to ${selectedAgent.full_name.split(' ')[0]}`
                : `Preview & Transfer to ${selectedAgent.full_name.split(' ')[0]}`}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Show tenant's active rent requests */}
      {selectedTenant && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground px-1">
            {selectedTenant.full_name}'s Active Requests
          </p>

          {loadingRequests && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!loadingRequests && (!tenantRequests || tenantRequests.length === 0) && (
            <Card className="border-dashed">
              <CardContent className="p-4 text-center text-sm text-muted-foreground">
                No active rent requests found
              </CardContent>
            </Card>
          )}

          {tenantRequests?.map((rr) => {
            const willMove =
              !!selectedAgent &&
              !!currentAgentId &&
              currentAgentId !== selectedAgent.id &&
              rr.agent_id === currentAgentId;
            const alreadyOnNewAgent =
              !!selectedAgent && rr.agent_id === selectedAgent.id;
            return (
            <Card
              key={rr.id}
              className={`border transition-colors ${
                willMove
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                  : alreadyOnNewAgent
                  ? 'border-emerald-500/40 bg-emerald-500/5'
                  : ''
              }`}
            >
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[10px]">
                      {rr.status.replace(/_/g, ' ')}
                    </Badge>
                    {(rr.missed_days ?? 0) >= MISSED_DAYS_FLAG_THRESHOLD && (
                      <Badge variant="destructive" className="text-[10px] gap-0.5">
                        <CalendarX2 className="h-2.5 w-2.5" />
                        Missed {rr.missed_days}d
                      </Badge>
                    )}
                    {willMove && (
                      <Badge className="text-[10px] bg-primary text-primary-foreground">
                        Will transfer
                      </Badge>
                    )}
                    {alreadyOnNewAgent && (
                      <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-700 dark:text-emerald-400">
                        Already on new agent
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {rr.id.slice(0, 8)}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <div>
                    <span className="text-muted-foreground">Rent:</span>{' '}
                    <span className="font-semibold">UGX {Number(rr.rent_amount).toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Due:</span>{' '}
                    <span className="font-bold text-destructive">UGX {rr.outstanding.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Daily:</span>{' '}
                    <span className="font-medium">UGX {Number(rr.daily_repayment || 0).toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Repaid:</span>{' '}
                    <span className="font-medium text-emerald-600">UGX {Number(rr.amount_repaid || 0).toLocaleString()}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1 border-t">
                  <div className="flex items-center gap-1.5 text-xs">
                    <User className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">Agent:</span>
                    <span className="font-medium">{rr.agent_name}</span>
                  </div>
                  {selectedAgent && (
                    <Button
                      size="sm"
                      variant="default"
                      className="h-7 text-xs gap-1"
                      disabled={linkMutation.isPending}
                      onClick={() => linkMutation.mutate(rr.id)}
                    >
                      {linkMutation.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Link2 className="h-3 w-3" />
                      )}
                      Link {selectedAgent.full_name.split(' ')[0]}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
            );
          })}
        </div>
      )}

      {/* Confirmation dialog with preview of affected requests */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-primary" />
              Confirm bulk transfer
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              Review every active rent request that will be reassigned. Only requests
              currently held by the source agent will move. Items already on the new
              agent or assigned elsewhere are skipped.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {(tenantIsFlagged || hasMovableRequests) && (
            <div className="space-y-2">
              {tenantIsFlagged && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    Tenant has missed <span className="font-semibold">{worstMissedDays}+ daily payments</span>{' '}
                    on {flaggedRequests.length} active request{flaggedRequests.length === 1 ? '' : 's'}.
                  </AlertDescription>
                </Alert>
              )}
              {hasMovableRequests && (
                <Alert className="border-amber-500/40 bg-amber-500/10">
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  <AlertDescription className="text-xs">
                    <span className="font-semibold">{sourceAgentName}</span> will lose ~UGX{' '}
                    <span className="font-semibold">{projectedCommissionLoss.toLocaleString()}</span>{' '}
                    in projected commission on UGX {movingOutstanding.toLocaleString()} outstanding.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          {(() => {
            const moving = (tenantRequests || []).filter(
              (r: any) => currentAgentId && r.agent_id === currentAgentId
            );
            const skipped = (tenantRequests || []).filter(
              (r: any) => !currentAgentId || r.agent_id !== currentAgentId
            );
            const totalOutstanding = moving.reduce((s: number, r: any) => s + (r.outstanding || 0), 0);
            const sortedMoving = [...moving].sort((a: any, b: any) => {
              const dir = previewSortDir === 'asc' ? 1 : -1;
              if (previewSortKey === 'amount') {
                return (Number(a.outstanding || 0) - Number(b.outstanding || 0)) * dir;
              }
              if (previewSortKey === 'agent') {
                return String(a.agent_name || '').localeCompare(String(b.agent_name || '')) * dir;
              }
              return String(a.id || '').localeCompare(String(b.id || '')) * dir;
            });
            const SortIcon = ({ col }: { col: 'id' | 'agent' | 'amount' }) => {
              if (previewSortKey !== col) return <ArrowUpDown className="h-3 w-3 opacity-30" />;
              return previewSortDir === 'asc'
                ? <ArrowUp className="h-3 w-3" />
                : <ArrowDown className="h-3 w-3" />;
            };
            return (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-md border bg-primary/5 p-2 text-center">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Will move</p>
                    <p className="text-lg font-bold text-primary">{moving.length}</p>
                  </div>
                  <div className="rounded-md border p-2 text-center">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Skipped</p>
                    <p className="text-lg font-bold">{skipped.length}</p>
                  </div>
                  <div className="rounded-md border p-2 text-center">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Outstanding</p>
                    <p className="text-sm font-bold">UGX {totalOutstanding.toLocaleString()}</p>
                  </div>
                </div>

                <div className="rounded-md border bg-muted/30 p-2 text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">From</span>
                    <span className="font-medium">
                      {moving[0]?.agent_name || 'Current agent'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">To</span>
                    <span className="font-medium text-primary">{selectedAgent?.full_name}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Tenant</span>
                    <span className="font-medium">{selectedTenant?.full_name}</span>
                  </div>
                </div>

                <div className="rounded-md border overflow-hidden">
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-2 px-2 py-1.5 bg-muted/50 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => handlePreviewSort('id')}
                      className="flex items-center gap-1 hover:text-foreground transition-colors text-left"
                    >
                      Request ID <SortIcon col="id" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePreviewSort('agent')}
                      className="flex items-center gap-1 hover:text-foreground transition-colors text-left"
                    >
                      Current Agent <SortIcon col="agent" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePreviewSort('amount')}
                      className="flex items-center justify-end gap-1 hover:text-foreground transition-colors"
                    >
                      Amount <SortIcon col="amount" />
                    </button>
                  </div>
                  <div className="max-h-56 overflow-y-auto divide-y">
                    {sortedMoving.length === 0 && (
                      <p className="p-3 text-xs text-center text-muted-foreground">
                        No requests will move.
                      </p>
                    )}
                    {sortedMoving.map((r: any) => (
                      <div
                        key={r.id}
                        className="grid grid-cols-[1fr_1fr_auto] gap-2 px-2 py-1.5 text-xs items-center"
                      >
                        <div className="min-w-0">
                          <p className="font-mono text-[11px] truncate" title={r.id}>
                            {r.id.slice(0, 8)}…
                          </p>
                          <p className="text-[10px] text-muted-foreground capitalize">
                            {String(r.status).replace(/_/g, ' ')}
                          </p>
                        </div>
                        <p className="font-medium truncate" title={r.agent_name}>
                          {r.agent_name}
                        </p>
                        <p className="text-right tabular-nums">
                          UGX {Number(r.rent_amount).toLocaleString()}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {skipped.length > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    {skipped.length} request{skipped.length === 1 ? '' : 's'} skipped
                    (not on the source agent).
                  </p>
                )}

                <p className="text-[11px] text-muted-foreground italic">
                  Reason: "{transferReason.trim()}"
                </p>

                <div className="rounded-md border bg-muted/30 p-2 text-xs space-y-1">
                  <div className="flex items-center gap-1.5 font-semibold text-[11px] uppercase tracking-wide text-muted-foreground">
                    <MapPin className="h-3 w-3" />
                    Location context
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Tenant last seen</span>
                    <span className="font-medium">
                      {tenantLastLoc
                        ? `${tenantLastLoc.city || `${Number(tenantLastLoc.latitude).toFixed(3)}, ${Number(tenantLastLoc.longitude).toFixed(3)}`} · ${formatRelativeTime(tenantLastLoc.captured_at)}`
                        : '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">New agent last seen</span>
                    <span className="font-medium">
                      {agentLastLoc
                        ? `${agentLastLoc.city || `${Number(agentLastLoc.latitude).toFixed(3)}, ${Number(agentLastLoc.longitude).toFixed(3)}`} · ${formatRelativeTime(agentLastLoc.captured_at)}`
                        : '—'}
                    </span>
                  </div>
                  {tenantAgentDistanceKm !== null && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Approx. distance</span>
                      <span className="font-medium">
                        {tenantAgentDistanceKm < 1
                          ? `${Math.round(tenantAgentDistanceKm * 1000)} m`
                          : `${tenantAgentDistanceKm.toFixed(1)} km`}
                      </span>
                    </div>
                  )}
                </div>

                {lastActorStatus && (
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <MapPin className="h-3 w-3" />
                    {lastActorStatus === 'captured'
                      ? `Your location captured${lastActorAccuracy ? ` (±${Math.round(lastActorAccuracy)} m)` : ''}`
                      : `Your location ${lastActorStatus} — proceeding without geo`}
                  </div>
                )}
              </div>
            );
          })()}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={transferAllMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={transferAllMutation.isPending || !canSubmitTransfer}
              onClick={(e) => {
                e.preventDefault();
                if (!canSubmitTransfer) return;
                transferAllMutation.mutate(undefined, {
                  onSuccess: () => setConfirmOpen(false),
                });
              }}
            >
              {transferAllMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <ArrowRightLeft className="h-4 w-4 mr-1.5" />
              )}
              Confirm transfer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
