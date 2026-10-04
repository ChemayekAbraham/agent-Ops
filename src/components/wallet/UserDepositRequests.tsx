import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useDepositRequests } from '@/hooks/wallet/useWalletRequests';
import {
  Clock,
  CheckCircle2,
  XCircle,
  Wallet,
  ChevronDown,
  ChevronUp,
  Target,
  Pencil,
  BadgeCheck,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { isAutoCancelledDuplicate } from '@/lib/depositDuplicateDetection';
import {
  DepositAutoMatchAudit,
  type DepositAutoMatchAuditPayload,
} from '@/components/wallet/DepositAutoMatchAudit';
import DepositStatusTracker, { type DepositStage } from '@/components/payments/DepositStatusTracker';
import { format, parseISO, isToday, isYesterday } from 'date-fns';
import { cn } from '@/lib/utils';

const DepositFlow = lazy(() => import('@/components/payments/DepositFlow'));

interface DepositRequest {
  id: string;
  agent_id: string;
  amount: number;
  status: string;
  created_at: string;
  rejection_reason?: string;
  agent_name?: string;
  notes?: string;
  deposit_purpose?: string | null;
  purpose_audit?: { chosen_purpose?: string } | null;
  auto_match_audit?: DepositAutoMatchAuditPayload | null;
  provider?: string | null;
  approved_at?: string | null;
}

interface CashVerification {
  status: string;
  verified_at: string | null;
}

const PURPOSE_LABELS: Record<string, string> = {
  operational_float: 'Operational Float',
  personal_deposit: 'Personal Deposit',
  partnership_deposit: 'Supporter Wallet Top-Up',
  personal_rent_repayment: 'Personal Rent Repayment',
  other: 'Other',
};

const purposeBadgeClass = (p: string | null | undefined) => {
  switch (p) {
    case 'operational_float':
      return 'bg-primary/15 text-primary border-primary/30';
    case 'personal_deposit':
      return 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30';
    case 'partnership_deposit':
      return 'bg-violet-500/15 text-violet-700 border-violet-500/30';
    case 'personal_rent_repayment':
      return 'bg-amber-500/15 text-amber-700 border-amber-500/30';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
};

function dayLabel(iso: string): string {
  const d = parseISO(iso);
  if (isToday(d)) return 'TODAY';
  if (isYesterday(d)) return 'YESTERDAY';
  return format(d, 'EEE, d MMM yyyy').toUpperCase();
}

export function UserDepositRequests() {
  const { user } = useAuth();
  const { requests: rawRequests, isLoading, refetch } = useDepositRequests(user?.id);
  const [requests, setRequests] = useState<DepositRequest[]>([]);
  const [enriching, setEnriching] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [verifications, setVerifications] = useState<Record<string, CashVerification>>({});
  const loading = isLoading || enriching;

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-UG', {
      style: 'currency',
      currency: 'UGX',
      minimumFractionDigits: 0,
    }).format(value);

  // Enrichment (agent names + cash-verification status) runs off the
  // shared, cached deposit_requests read above — this component no longer
  // fetches the base rows itself. The two lookups below are independent of
  // each other (profiles by agent_id, verifications by deposit id), so
  // they run in parallel instead of sequentially.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (rawRequests.length === 0) {
        if (!cancelled) {
          setRequests([]);
          setVerifications({});
          setEnriching(false);
        }
        return;
      }
      setEnriching(true);
      const agentIds = [...new Set(rawRequests.map((d) => d.agent_id))];
      const cashIds = rawRequests.filter((r) => r.provider === 'cash_deposit').map((r) => r.id);

      const [profilesRes, versRes] = await Promise.all([
        supabase.from('profiles').select('id, full_name').in('id', agentIds),
        cashIds.length > 0
          ? supabase
              .from('cash_deposit_verifications')
              .select('deposit_request_id, status, verified_at')
              .in('deposit_request_id', cashIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      if (cancelled) return;

      const profileMap = new Map(profilesRes.data?.map((p) => [p.id, p.full_name]) || []);
      const enrichedRequests = rawRequests.map((d: any) => ({
        ...d,
        agent_name: profileMap.get(d.agent_id) || 'Agent',
      })) as DepositRequest[];
      setRequests(enrichedRequests);

      const map: Record<string, CashVerification> = {};
      (versRes.data ?? []).forEach((v: any) => {
        map[v.deposit_request_id] = { status: v.status, verified_at: v.verified_at };
      });
      setVerifications(map);
      setEnriching(false);
    })();
    return () => { cancelled = true; };
  }, [rawRequests]);

  const handleEditClose = (open: boolean) => {
    if (!open) {
      setEditingId(null);
      void refetch();
    }
  };

  const visualFor = (req: DepositRequest) => {
    if (isAutoCancelledDuplicate(req)) {
      return {
        Icon: BadgeCheck,
        accent: 'border-l-success',
        iconWrap: 'bg-success/10 text-success',
        pill: 'bg-success/10 text-success',
        label: 'Already credited',
      };
    }
    switch (req.status) {
      case 'approved':
        return {
          Icon: CheckCircle2,
          accent: 'border-l-success',
          iconWrap: 'bg-success/10 text-success',
          pill: 'bg-success/10 text-success',
          label: 'Approved',
        };
      case 'rejected':
        return {
          Icon: XCircle,
          accent: 'border-l-destructive',
          iconWrap: 'bg-destructive/10 text-destructive',
          pill: 'bg-destructive/10 text-destructive',
          label: 'Rejected',
        };
      default:
        return {
          Icon: Clock,
          accent: 'border-l-warning',
          iconWrap: 'bg-warning/15 text-warning',
          pill: 'bg-warning/15 text-warning',
          label: 'Pending',
        };
    }
  };

  const computeStage = (req: DepositRequest): DepositStage => {
    if (req.status === 'rejected') return 'rejected';
    if (req.status === 'approved') return 'approved';
    const ver = verifications[req.id];
    if (ver?.status === 'expired') return 'expired';
    if (ver?.status === 'verified') return 'verified';
    return 'pending';
  };

  const dayGroups = useMemo(() => {
    const groups: { key: string; label: string; rows: DepositRequest[] }[] = [];
    for (const r of requests) {
      const key = format(parseISO(r.created_at), 'yyyy-MM-dd');
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.rows.push(r);
      else groups.push({ key, label: dayLabel(r.created_at), rows: [r] });
    }
    return groups;
  }, [requests]);

  if (loading) {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled
        className="w-full justify-between text-muted-foreground"
      >
        <span className="flex items-center gap-2">
          <Wallet className="h-4 w-4" />
          Loading deposit requests...
        </span>
      </Button>
    );
  }

  if (requests.length === 0) return null;

  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  const rejectedCount = requests.filter(
    (r) => r.status === 'rejected' && !isAutoCancelledDuplicate(r),
  ).length;

  return (
    <>
      <Collapsible open={isOpen || rejectedCount > 0} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={`w-full justify-between hover:bg-muted/50 ${
              rejectedCount > 0 ? 'bg-destructive/5' : ''
            }`}
          >
            <span className="flex items-center gap-2">
              <Wallet
                className={`h-4 w-4 ${rejectedCount > 0 ? 'text-destructive' : 'text-primary'}`}
              />
              <span className="text-sm font-medium">Deposit Requests</span>
              {rejectedCount > 0 && (
                <Badge variant="destructive" className="text-xs">
                  {rejectedCount} rejected
                </Badge>
              )}
              {pendingCount > 0 && (
                <Badge variant="secondary" className="bg-warning/15 text-warning text-xs">
                  {pendingCount} pending
                </Badge>
              )}
            </span>
            {isOpen ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Card className="mt-2 border-border/50 rounded-2xl">
            <CardContent className="p-4 space-y-6">
              <AnimatePresence mode="popLayout">
                {dayGroups.map((group) => (
                  <section key={group.key} aria-labelledby={`dep-${group.key}`}>
                    <h4
                      id={`dep-${group.key}`}
                      className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground"
                    >
                      {group.label}
                    </h4>
                    <ul className="space-y-2.5 list-none p-0 m-0">
                      {group.rows.map((request) => {
                        const v = visualFor(request);
                        const Icon = v.Icon;
                        const purpose =
                          request.purpose_audit?.chosen_purpose ?? request.deposit_purpose ?? null;
                        const purposeLabel = purpose ? PURPOSE_LABELS[purpose] ?? purpose : null;
                        const isCashTracker =
                          request.provider === 'cash_deposit' && !isAutoCancelledDuplicate(request);

                        return (
                          <motion.li
                            key={request.id}
                            layout
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, x: -30 }}
                          >
                            <div
                              className={cn(
                                'rounded-2xl border border-border/60 border-l-4 bg-card p-3.5 shadow-sm',
                                v.accent,
                              )}
                            >
                              <div className="flex items-center gap-3">
                                <div
                                  className={cn(
                                    'h-11 w-11 shrink-0 rounded-full flex items-center justify-center',
                                    v.iconWrap,
                                  )}
                                  aria-hidden="true"
                                >
                                  <Icon className="h-5 w-5" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-bold text-foreground">
                                    {formatCurrency(request.amount)}
                                  </p>
                                  <p className="mt-0.5 text-[11px] text-muted-foreground truncate">
                                    via {request.agent_name}
                                    {purposeLabel && (
                                      <>
                                        <span className="mx-1.5 text-muted-foreground/60">|</span>
                                        {purposeLabel}
                                      </>
                                    )}
                                  </p>
                                  {request.notes && (
                                    <p className="mt-0.5 text-[11px] text-muted-foreground/80 italic truncate">
                                      "{request.notes}"
                                    </p>
                                  )}
                                  {purpose && (
                                    <Badge
                                      variant="outline"
                                      className={cn(
                                        'mt-1 text-[10px] px-1.5 py-0 h-4',
                                        purposeBadgeClass(purpose),
                                      )}
                                    >
                                      <Target className="h-2.5 w-2.5 mr-0.5" />
                                      {purposeLabel}
                                    </Badge>
                                  )}
                                </div>
                                <div className="shrink-0 text-right">
                                  <span
                                    className={cn(
                                      'inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                      v.pill,
                                    )}
                                  >
                                    {v.label}
                                  </span>
                                  <p className="mt-1 text-[10px] text-muted-foreground/80">
                                    {new Date(request.created_at).toLocaleDateString()}
                                  </p>
                                </div>
                              </div>

                              {isAutoCancelledDuplicate(request) ? (
                                <div className="mt-3 p-2 rounded-lg bg-success/10 border border-success/20 text-xs text-success-foreground">
                                  <p className="font-medium flex items-center gap-1 text-success">
                                    <BadgeCheck className="h-3.5 w-3.5" />
                                    No duplicate created
                                  </p>
                                  <p className="mt-0.5 text-success/90">
                                    {request.rejection_reason}
                                  </p>
                                </div>
                              ) : (
                                request.status === 'rejected' &&
                                request.rejection_reason && (
                                  <div className="mt-3 space-y-2">
                                    <p className="text-xs text-destructive bg-destructive/10 p-2 rounded-lg">
                                      Reason: {request.rejection_reason}
                                    </p>
                                    <Button
                                      variant="default"
                                      size="sm"
                                      className="h-7 text-xs"
                                      onClick={() => setEditingId(request.id)}
                                    >
                                      <Pencil className="h-3 w-3 mr-1" />
                                      Fix details & resubmit
                                    </Button>
                                  </div>
                                )
                              )}

                              {request.status === 'pending' &&
                                (request.deposit_purpose === 'operational_float' ||
                                  request.purpose_audit?.chosen_purpose === 'operational_float') && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="mt-3 h-7 text-xs"
                                    onClick={() => setEditingId(request.id)}
                                  >
                                    <Pencil className="h-3 w-3 mr-1" />
                                    Edit allocations
                                  </Button>
                                )}

                              {isCashTracker && (
                                <div className="mt-3 pt-3 border-t border-border/60">
                                  <DepositStatusTracker
                                    stage={computeStage(request)}
                                    compact
                                    timestamps={{
                                      pendingAt: request.created_at,
                                      verifiedAt: verifications[request.id]?.verified_at ?? null,
                                      approvedAt:
                                        request.status === 'approved'
                                          ? request.approved_at ?? null
                                          : null,
                                    }}
                                  />
                                </div>
                              )}
                              <DepositAutoMatchAudit audit={request.auto_match_audit} />
                            </div>
                          </motion.li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </AnimatePresence>
            </CardContent>
          </Card>
        </CollapsibleContent>
      </Collapsible>

      {editingId && (
        <Suspense fallback={null}>
          <DepositFlow
            open={!!editingId}
            onOpenChange={handleEditClose}
            editRequestId={editingId}
          />
        </Suspense>
      )}
    </>
  );
}