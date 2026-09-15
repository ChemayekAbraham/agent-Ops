import React, { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format, formatDistanceToNow } from 'date-fns';
import {
  Clock,
  Trash2,
  AlertTriangle,
  Search,
  ArrowUpDown,
  User,
  Home,
  Briefcase,
  MapPin,
  Loader2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { RentRequestDetailDrawer } from '@/components/rent/RentRequestDetailDrawer';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
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

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface ExpiredRequestRow {
  id: string;
  tenant_id: string | null;
  agent_id: string | null;
  assigned_agent_id: string | null;
  landlord_id: string | null;
  rent_amount: number;
  created_at: string;
  status: string;
  agent_verified: boolean | null;
  tenant_name: string;
  tenant_phone: string;
  landlord_name: string;
  agent_name: string;
  location: string;
  daysExpired: number;
  expiryDate: Date;
}

interface AgentOpsExpiredRequestsPanelProps {
  statuses?: string[];
  title?: string;
  description?: string;
}

export function AgentOpsExpiredRequestsPanel({
  statuses = ['pending'],
  title = 'Expired Rent Requests',
  description,
}: AgentOpsExpiredRequestsPanelProps = {}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [requestToDelete, setRequestToDelete] = useState<ExpiredRequestRow | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['agent-ops-expired-requests'] });
    queryClient.invalidateQueries({ queryKey: ['rent-pipeline'] });
    queryClient.invalidateQueries({ queryKey: ['pipeline-counts'] });
    queryClient.invalidateQueries({ queryKey: ['agent-ops-counts'] });
    queryClient.invalidateQueries({ queryKey: ['tenant-ops-tool-counts'] });
    queryClient.invalidateQueries({ queryKey: ['tenant-ops-expired-count'] });
  };

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['agent-ops-expired-requests', statuses.join(',')],
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: async (): Promise<ExpiredRequestRow[]> => {
      const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();

      let query = supabase
        .from('rent_requests')
        .select('id, tenant_id, agent_id, assigned_agent_id, landlord_id, rent_amount, created_at, status, agent_verified, request_city')
        .lt('created_at', thirtyDaysAgo)
        .order('created_at', { ascending: false });

      if (statuses.length === 1) {
        query = query.eq('status', statuses[0]);
      } else {
        query = query.in('status', statuses);
      }

      const { data, error } = await query;
      if (error) throw error;
      if (!data || data.length === 0) return [];

      const unverified = statuses.includes('pending')
        ? data.filter((r: any) => !r.agent_verified)
        : data;
      if (unverified.length === 0) return [];

      // Resolve tenant, agent, and landlord names
      const tenantIds = [...new Set(unverified.map(r => r.tenant_id).filter(Boolean))] as string[];
      const agentIds = [...new Set(unverified.flatMap(r => [r.agent_id, r.assigned_agent_id]).filter(Boolean))] as string[];
      const landlordIds = [...new Set(unverified.map(r => r.landlord_id).filter(Boolean))] as string[];

      const [tenantsRes, agentsRes, landlordsRes] = await Promise.all([
        tenantIds.length ? supabase.from('profiles').select('id, full_name, phone').in('id', tenantIds) : { data: [] },
        agentIds.length ? supabase.from('profiles').select('id, full_name').in('id', agentIds) : { data: [] },
        landlordIds.length ? supabase.from('landlords').select('id, name').in('id', landlordIds) : { data: [] },
      ]);

      const tenantMap = new Map((tenantsRes.data || []).map(p => [p.id, p]));
      const agentMap = new Map((agentsRes.data || []).map(p => [p.id, p]));
      const landlordMap = new Map((landlordsRes.data || []).map(l => [l.id, l]));

      return unverified.map(r => {
        const t = r.tenant_id ? tenantMap.get(r.tenant_id) : null;
        const agId = r.assigned_agent_id || r.agent_id;
        const ag = agId ? agentMap.get(agId) : null;
        const l = r.landlord_id ? landlordMap.get(r.landlord_id) : null;

        const createdTs = new Date(r.created_at).getTime();
        const expiryTs = createdTs + THIRTY_DAYS_MS;
        const daysExpired = Math.max(1, Math.floor((Date.now() - expiryTs) / (24 * 60 * 60 * 1000)));

        return {
          id: r.id,
          tenant_id: r.tenant_id,
          agent_id: r.agent_id,
          assigned_agent_id: r.assigned_agent_id,
          landlord_id: r.landlord_id,
          rent_amount: Number(r.rent_amount || 0),
          created_at: r.created_at,
          status: r.status,
          agent_verified: r.agent_verified,
          tenant_name: t?.full_name || 'Unnamed Tenant',
          tenant_phone: t?.phone || '—',
          landlord_name: l?.name || 'Unnamed Landlord',
          agent_name: ag?.full_name || 'No Agent Assigned',
          location: r.request_city || '—',
          daysExpired,
          expiryDate: new Date(expiryTs),
        };
      });
    },
  });

  const filtered = useMemo(() => {
    let list = rows;
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(r =>
        r.tenant_name.toLowerCase().includes(q) ||
        r.tenant_phone.includes(q) ||
        r.landlord_name.toLowerCase().includes(q) ||
        r.agent_name.toLowerCase().includes(q) ||
        r.location.toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      const tsA = new Date(a.created_at).getTime();
      const tsB = new Date(b.created_at).getTime();
      return sortOrder === 'desc' ? tsB - tsA : tsA - tsB;
    });
  }, [rows, search, sortOrder]);

  const totalExpiredAmount = useMemo(() => {
    return filtered.reduce((sum, r) => sum + r.rent_amount, 0);
  }, [filtered]);

  // Delete single request
  const handleDeleteSingle = async () => {
    if (!requestToDelete) return;
    const targetId = requestToDelete.id;
    setDeletingId(targetId);
    setRequestToDelete(null);

    try {
      // First try delete-rent-request edge function
      const { error: edgeErr } = await supabase.functions.invoke('delete-rent-request', {
        body: { rent_request_id: targetId },
      });

      if (edgeErr) {
        // Fallback: direct delete from rent_requests
        const { error: directErr } = await supabase.from('rent_requests').delete().eq('id', targetId);
        if (directErr) throw directErr;
      }

      toast({
        title: '🗑️ Request deleted',
        description: `Expired request for ${requestToDelete.tenant_name} has been removed.`,
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

  // Delete all expired requests
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
        title: '✅ All expired requests deleted',
        description: `Successfully removed ${successCount} expired request${successCount === 1 ? '' : 's'}.`,
      });
    } else {
      toast({
        title: `Deleted ${successCount} requests`,
        description: `${failCount} requests could not be removed.`,
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Header Card */}
      <Card className="border-border">
        <CardContent className="p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-destructive" />
              <h2 className="text-base font-semibold">{title}</h2>
              <Badge variant="destructive" size="sm" className="font-bold">
                {filtered.length} expired
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {description || 'Pending requests submitted over 30 days ago that were never field-verified.'}{' '}
              Total volume: <strong>UGX {totalExpiredAmount.toLocaleString()}</strong>.
            </p>
          </div>

          {filtered.length > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
              disabled={isBulkDeleting}
              className="gap-1.5 shrink-0 font-bold"
            >
              {isBulkDeleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              <span>Delete All ({filtered.length})</span>
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Search & Sort Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search tenant, phone, landlord, agent, or location..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc')}
          className="h-9 gap-1.5 text-xs shrink-0 border-border"
          title={sortOrder === 'desc' ? 'Sorted by Date (Newest first)' : 'Sorted by Date (Oldest first)'}
        >
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
          <span>{sortOrder === 'desc' ? 'Newest first' : 'Oldest first'}</span>
        </Button>
      </div>

      {/* State views */}
      {isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <Card className="border-dashed border-border py-12 text-center">
          <CardContent className="space-y-2">
            <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto" />
            <h3 className="font-semibold text-base">No Expired Requests</h3>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              {rows.length === 0
                ? 'All pending rent requests are currently active within their 30-day verification window.'
                : 'No expired requests match your search criteria.'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Expired Request Cards */}
      <div className="space-y-2">
        {filtered.map(req => {
          const isDeletingThis = deletingId === req.id;
          return (
            <Card
              key={req.id}
              className="border border-border/80 hover:border-destructive/40 transition-colors"
            >
              <CardContent className="p-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <User className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="font-semibold text-sm">{req.tenant_name}</span>
                    <Badge variant="destructive" size="sm" className="text-[10px] uppercase font-bold tracking-wide">
                      Expired ({req.daysExpired}d ago)
                    </Badge>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                    <span className="flex items-center gap-1">
                      <Home className="h-3 w-3" />
                      {req.landlord_name}
                    </span>
                    <span className="flex items-center gap-1">
                      <Briefcase className="h-3 w-3" />
                      {req.agent_name}
                    </span>
                    {req.location !== '—' && (
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {req.location}
                      </span>
                    )}
                  </div>

                  {/* Submission and Expiration Timestamps */}
                  <div className="flex items-center gap-3 pt-1 text-[11px] font-mono text-muted-foreground flex-wrap">
                    <span>Submitted: {format(new Date(req.created_at), 'dd MMM yyyy, HH:mm')}</span>
                    <span className="text-destructive font-semibold flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      Expired: {format(req.expiryDate, 'dd MMM yyyy, HH:mm')} ({formatDistanceToNow(req.expiryDate, { addSuffix: true })})
                    </span>
                  </div>
                </div>

                {/* Right Area: Amount and Single Delete Icon Button */}
                <div className="flex items-center justify-between sm:justify-end gap-4 w-full sm:w-auto shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0">
                  <div className="text-left sm:text-right">
                    <p className="font-bold text-sm text-foreground">UGX {req.rent_amount.toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground font-mono">Unverified</p>
                  </div>

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRequestToDelete(req)}
                    disabled={isDeletingThis || isBulkDeleting}
                    className="h-8 w-8 p-0 text-destructive hover:bg-destructive/10 shrink-0"
                    title="Delete this expired request"
                  >
                    {isDeletingThis ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Confirmation Dialog: Delete Single */}
      <AlertDialog open={!!requestToDelete} onOpenChange={(open) => !open && setRequestToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete Expired Rent Request?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm">
              Are you sure you want to delete the expired rent request for <strong>{requestToDelete?.tenant_name}</strong> (UGX {requestToDelete?.rent_amount.toLocaleString()})?
              <br /><br />
              This request was submitted on <strong>{requestToDelete?.created_at ? format(new Date(requestToDelete.created_at), 'dd MMM yyyy, HH:mm') : ''}</strong> and expired over 30 days ago without verification.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSingle}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <Trash2 className="h-4 w-4 mr-1.5" />
              Delete Request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmation Dialog: Delete All */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete All {filtered.length} Expired Requests?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm">
              This will permanently delete all <strong>{filtered.length}</strong> expired rent requests totaling <strong>UGX {totalExpiredAmount.toLocaleString()}</strong>.
              <br /><br />
              All associated pending logs and draft allocations will be cleaned up. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBulkDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDeleteAll}
              disabled={isBulkDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 font-bold"
            >
              {isBulkDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting All...
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Yes, Delete All ({filtered.length})
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
