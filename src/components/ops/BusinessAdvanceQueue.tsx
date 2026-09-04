import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX, projectOutstanding } from '@/lib/businessAdvanceCalculations';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  CheckCircle2, XCircle, Loader2, Clock, Briefcase, MapPin, Banknote, UserCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AssignNearbyAgentDialog } from './AssignNearbyAgentDialog';
import { BusinessAdvanceEconomicsCard, BusinessAdvancePortfolioPanel } from './BusinessAdvanceEconomics';

type Stage = 'agent_ops' | 'tenant_ops' | 'landlord_ops' | 'coo' | 'cfo';

interface BusinessAdvanceQueueProps {
  stage: Stage;
}

const STAGE_CONFIG: Record<Stage, {
  filterStatus: string;
  nextStatus: string | null;
  reviewerCol: string;
  reviewedAtCol: string;
  notesCol: string;
  title: string;
  ctaLabel: string;
}> = {
  agent_ops: {
    filterStatus: 'pending',
    nextStatus: 'agent_ops_approved',
    reviewerCol: 'agent_ops_reviewed_by',
    reviewedAtCol: 'agent_ops_reviewed_at',
    notesCol: 'agent_ops_notes',
    title: 'Business Advance Requests',
    ctaLabel: 'Approve',
  },
  tenant_ops: {
    filterStatus: 'agent_ops_approved',
    nextStatus: 'tenant_ops_approved',
    reviewerCol: 'tenant_ops_reviewed_by',
    reviewedAtCol: 'tenant_ops_reviewed_at',
    notesCol: 'tenant_ops_notes',
    title: 'Business Advance Requests',
    ctaLabel: 'Approve',
  },
  landlord_ops: {
    filterStatus: 'tenant_ops_approved',
    nextStatus: 'landlord_ops_approved',
    reviewerCol: 'landlord_ops_reviewed_by',
    reviewedAtCol: 'landlord_ops_reviewed_at',
    notesCol: 'landlord_ops_notes',
    title: 'Business Advance — Verify Location',
    ctaLabel: 'Approve',
  },
  coo: {
    filterStatus: 'landlord_ops_approved',
    nextStatus: 'coo_approved',
    reviewerCol: 'coo_approved_by',
    reviewedAtCol: 'coo_approved_at',
    notesCol: 'coo_notes',
    title: 'Business Advance Approvals',
    ctaLabel: 'Approve',
  },
  cfo: {
    filterStatus: 'coo_approved',
    nextStatus: null, // disbursement uses edge function
    reviewerCol: 'cfo_disbursed_by',
    reviewedAtCol: 'cfo_disbursed_at',
    notesCol: 'cfo_notes',
    title: 'Business Advance Disbursements',
    ctaLabel: 'Disburse to wallet',
  },
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Agent Ops review',
  agent_ops_approved: 'Tenant Ops review',
  tenant_ops_approved: 'Landlord Ops review',
  landlord_ops_approved: 'COO review',
  coo_approved: 'CFO disbursement',
  disbursed: 'Disbursed',
  rejected: 'Declined',
};

const PAGE_SIZE = 10;

function getPageNumbers(totalPages: number, currentPage: number) {
  const pages: (number | string)[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else if (currentPage <= 4) {
    pages.push(1, 2, 3, 4, 5, '...', totalPages);
  } else if (currentPage >= totalPages - 3) {
    pages.push(1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
  } else {
    pages.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages);
  }
  return pages;
}

function StatusBadge({ status }: { status: string }) {
  const label = STATUS_LABEL[status] ?? status.replace(/_/g, ' ');
  const tone =
    status === 'rejected'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : status === 'disbursed'
        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
        : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400';
  return (
    <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 h-5 whitespace-nowrap', tone)}>
      {label}
    </Badge>
  );
}

export function BusinessAdvanceQueue({ stage }: BusinessAdvanceQueueProps) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const config = STAGE_CONFIG[stage];
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<any | null>(null);
  const [assignDialogFor, setAssignDialogFor] = useState<any>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(1);

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['business-advance-queue', stage],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('business_advances')
        .select('*, tenant:profiles!business_advances_tenant_id_fkey(full_name, phone), agent:profiles!business_advances_agent_id_fkey(full_name, phone)')
        .eq('status', config.filterStatus as any)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  const approveMutation = useMutation({
    mutationFn: async ({ id, approve }: { id: string; approve: boolean }) => {
      if (!user?.id) throw new Error('Not authenticated');

      // CFO disbursement uses the edge function
      if (stage === 'cfo' && approve) {
        const { error } = await supabase.functions.invoke('disburse-business-advance', {
          body: { advance_id: id, notes: notes[id] || null },
        });
        if (error) throw error;
        return;
      }

      const updateData: any = {};
      if (approve) {
        if (!config.nextStatus) throw new Error('Invalid stage');
        updateData.status = config.nextStatus;
        updateData[config.reviewerCol] = user.id;
        updateData[config.reviewedAtCol] = new Date().toISOString();
        if (notes[id]) updateData[config.notesCol] = notes[id];
      } else {
        updateData.status = 'rejected';
        updateData.rejection_reason = notes[id] || `Rejected at ${stage.replace('_', ' ')} stage`;
        updateData[config.reviewerCol] = user.id;
        updateData[config.reviewedAtCol] = new Date().toISOString();
      }

      const { data, error } = await (supabase as any)
        .from('business_advances')
        .update(updateData)
        .eq('id', id)
        .select('id')
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error('Action blocked — your role may not have permission, or the request has already moved on.');
    },
    onSuccess: (_, { approve }) => {
      toast.success(approve ? (stage === 'cfo' ? 'Disbursed to tenant wallet' : 'Approved') : 'Rejected');
      setDetail(null);
      qc.invalidateQueries({ queryKey: ['business-advance-queue'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const businessTypes = useMemo(
    () => Array.from(new Set((requests as any[]).map((r) => r.business_type).filter(Boolean))).sort(),
    [requests],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (requests as any[]).filter((r) => {
      if (q) {
        const hay = [
          r.business_name, r.business_type, r.business_address, r.business_city,
          r.tenant?.full_name, r.tenant?.phone, r.agent?.full_name, r.agent?.phone,
          String(r.id).slice(0, 8),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (typeFilter !== 'all' && r.business_type !== typeFilter) return false;
      const day = String(r.created_at).slice(0, 10);
      if (fromDate && day < fromDate) return false;
      if (toDate && day > toDate) return false;
      return true;
    });
  }, [requests, search, typeFilter, fromDate, toDate]);

  const hasActiveFilters = !!(search || typeFilter !== 'all' || fromDate || toDate);
  const clearFilters = () => {
    setSearch(''); setTypeFilter('all'); setFromDate(''); setToDate(''); setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const totalRequested = visible.reduce((s, r: any) => s + Number(r.principal || 0), 0);

  if (isLoading) {
    return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  const detailTenant = detail?.tenant;
  const detailAgent = detail?.agent;
  const detailPrincipal = Number(detail?.principal ?? 0);
  const detailOutstanding = Number(detail?.outstanding_balance ?? 0);

  return (
    <div className="space-y-4">
      {stage === 'cfo' && <BusinessAdvancePortfolioPanel />}

      <div>
        <h2 className="flex items-center gap-2 text-lg sm:text-xl font-semibold">
          <Briefcase className="h-4 w-4 sm:h-5 sm:w-5 text-primary" /> {config.title}
        </h2>
        <p className="text-xs sm:text-sm text-muted-foreground">
          {requests.length} awaiting this desk · {formatUGX(totalRequested)} requested in the current view.
        </p>
      </div>

      {/* Filter bar — same shape as the agent advance review table */}
      <Card className="border-muted">
        <CardContent className="p-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
            <div className="space-y-1">
              <Label htmlFor="ba-search" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Search</Label>
              <Input
                id="ba-search"
                placeholder="Business, applicant or phone"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ba-type" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Business type</Label>
              <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(1); }}>
                <SelectTrigger id="ba-type" className="h-8 text-xs">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {businessTypes.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Application date range</Label>
              <div className="flex items-center gap-2">
                <Input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setPage(1); }} className="h-8 text-xs" />
                <span className="text-muted-foreground">-</span>
                <Input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); setPage(1); }} className="h-8 text-xs" />
              </div>
            </div>
            <div>
              <Button variant="outline" size="sm" className="h-8 text-xs w-full" onClick={clearFilters} disabled={!hasActiveFilters}>
                Clear Filters
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold">Business advances</h3>
        <Badge variant="secondary">{visible.length} of {requests.length} shown</Badge>
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Clock className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              {requests.length === 0
                ? 'No business advance requests pending at this stage'
                : 'No business advances match the selected filters.'}
            </p>
            {requests.length > 0 && (
              <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>Clear filters</Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">Advance ID</th>
                  <th className="text-left px-3 py-2 font-semibold">Business / Applicant</th>
                  <th className="text-left px-3 py-2 font-semibold">Contact</th>
                  <th className="text-right px-3 py-2 font-semibold">Requested</th>
                  <th className="text-right px-3 py-2 font-semibold">Approved</th>
                  <th className="text-right px-3 py-2 font-semibold">Charges (30d)</th>
                  <th className="text-right px-3 py-2 font-semibold">Total payable (30d)</th>
                  <th className="text-left px-3 py-2 font-semibold">Repayment</th>
                  <th className="text-left px-3 py-2 font-semibold">Applied</th>
                  <th className="text-left px-3 py-2 font-semibold">Status</th>
                  <th className="text-right px-3 py-2 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pageRows.map((req: any) => {
                  const principal = Number(req.principal || 0);
                  const outstanding = Number(req.outstanding_balance || 0);
                  const projected = projectOutstanding(outstanding, 30);
                  const charges = Math.max(0, projected - outstanding);
                  return (
                    <tr
                      key={req.id}
                      tabIndex={0}
                      role="button"
                      aria-label={`Open business advance for ${req.business_name}`}
                      onClick={() => setDetail(req)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(req); }
                      }}
                      className="cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    >
                      <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">{String(req.id).slice(0, 8)}</td>
                      <td className="px-3 py-2 max-w-[200px]">
                        <p className="truncate font-semibold">{req.business_name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {req.tenant?.full_name || 'Tenant'} • {req.business_type}
                        </p>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {req.tenant?.phone || '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{formatUGX(principal)}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-primary">{formatUGX(outstanding)}</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-700 dark:text-amber-400">{formatUGX(charges)}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatUGX(projected)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">Open-ended · 1%/day</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{format(new Date(req.created_at), 'dd MMM yyyy')}</td>
                      <td className="px-3 py-2"><StatusBadge status={req.status} /></td>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => setDetail(req)}>
                            View details
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="border-t px-3 py-2">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">
                  Page {safePage} of {totalPages} • {visible.length} advances
                </span>
                <div className="flex flex-wrap items-center justify-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={safePage === 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  {getPageNumbers(totalPages, safePage).map((p, idx) => (
                    p === '...' ? (
                      <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground">…</span>
                    ) : (
                      <Button
                        key={p}
                        size="sm"
                        variant={safePage === p ? 'default' : 'outline'}
                        className="h-7 min-w-[28px] px-2 text-xs"
                        onClick={() => setPage(Number(p))}
                      >
                        {p}
                      </Button>
                    )
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={safePage === totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Row details + actions */}
      <Dialog open={!!detail} onOpenChange={(o) => { if (!o) setDetail(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <span>{detail?.business_name}</span>
              {detail && <StatusBadge status={detail.status} />}
            </DialogTitle>
            <DialogDescription>
              {detail ? `${detail.business_type} • applied ${format(new Date(detail.created_at), 'dd MMM yyyy')}` : ''}
            </DialogDescription>
          </DialogHeader>

          {detail && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 p-3 rounded-xl bg-muted/50 text-xs">
                <div>
                  <span className="text-muted-foreground">Tenant</span><br />
                  <span className="font-bold">{detailTenant?.full_name || '—'}</span><br />
                  <span className="text-[10px] text-muted-foreground">{detailTenant?.phone || ''}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Agent</span><br />
                  <span className="font-bold">{detailAgent?.full_name || '—'}</span><br />
                  <span className="text-[10px] text-muted-foreground">{detailAgent?.phone || ''}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Principal</span><br />
                  <span className="font-bold">{formatUGX(detailPrincipal)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Outstanding</span><br />
                  <span className="font-bold text-amber-600">{formatUGX(detailOutstanding)}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-muted-foreground">30-day projection @ 1%/day</span><br />
                  <span className="font-bold text-red-500">{formatUGX(projectOutstanding(detailOutstanding, 30))}</span>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-muted/30">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1 flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> Business location
                </p>
                <p className="text-sm">{detail.business_address}{detail.business_city ? `, ${detail.business_city}` : ''}</p>
                {detail.business_latitude && (
                  <a
                    className="text-xs text-primary underline mt-1 inline-block"
                    href={`https://maps.google.com/?q=${detail.business_latitude},${detail.business_longitude}`}
                    target="_blank" rel="noreferrer"
                  >
                    Open in Maps ({Number(detail.business_latitude).toFixed(4)}, {Number(detail.business_longitude).toFixed(4)})
                  </a>
                )}
              </div>

              <div className="p-3 rounded-xl bg-muted/30">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">Reason</p>
                <p className="text-sm">{detail.reason}</p>
              </div>

              {detail.monthly_revenue && (
                <div className="grid grid-cols-2 gap-2 text-xs p-3 rounded-xl bg-muted/30">
                  <div><span className="text-muted-foreground">Monthly revenue</span><br />{formatUGX(Number(detail.monthly_revenue))}</div>
                  <div><span className="text-muted-foreground">Years in business</span><br />{detail.years_in_business || '—'}</div>
                </div>
              )}

              {stage === 'cfo' && (
                <BusinessAdvanceEconomicsCard principal={detailPrincipal} outstanding={detailOutstanding} />
              )}

              {stage === 'agent_ops' && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAssignDialogFor(detail)}
                  className="w-full gap-1.5 border-primary/40"
                >
                  <UserCheck className="h-4 w-4 text-primary" />
                  Dispatch nearby agent to verify landlord
                </Button>
              )}

              <Textarea
                placeholder="Notes (optional)..."
                value={notes[detail.id] || ''}
                onChange={(e) => setNotes((prev) => ({ ...prev, [detail.id]: e.target.value }))}
                rows={2}
                className="text-sm"
              />

              <div className="flex gap-2">
                <Button
                  onClick={() => approveMutation.mutate({ id: detail.id, approve: true })}
                  disabled={approveMutation.isPending}
                  className="flex-1 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {stage === 'cfo' ? <Banknote className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                  {config.ctaLabel}
                </Button>
                <Button
                  onClick={() => approveMutation.mutate({ id: detail.id, approve: false })}
                  disabled={approveMutation.isPending}
                  variant="destructive"
                  className="flex-1 gap-1.5"
                >
                  <XCircle className="h-4 w-4" /> Reject
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {assignDialogFor && (
        <AssignNearbyAgentDialog
          open={!!assignDialogFor}
          onOpenChange={(o) => !o && setAssignDialogFor(null)}
          advance={assignDialogFor}
        />
      )}
    </div>
  );
}
