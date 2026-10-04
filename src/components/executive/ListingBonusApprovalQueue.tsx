import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Home,
  Banknote,
  EyeOff,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

interface BonusApproval {
  id: string;
  listing_id: string;
  agent_id: string;
  amount: number;
  status: string;
  landlord_ops_approved_by: string | null;
  landlord_ops_approved_at: string | null;
  landlord_ops_notes: string | null;
  cfo_approved_by: string | null;
  cfo_approved_at: string | null;
  paid_at: string | null;
  created_at: string;
  // joined
  agent_name?: string;
  listing_title?: string;
  // hidden-row metadata
  hide_reason?: string | null;
  hide_actor_name?: string | null;
}

interface Props {
  /** 'pending_cfo' for CFO dashboard, 'all' for landlord ops */
  filter?: 'pending_cfo' | 'all';
  /** When true, the card content is collapsed by default */
  collapsible?: boolean;
  /** Initial open state when collapsible */
  defaultOpen?: boolean;
}

type Classified = {
  visible: BonusApproval[];
  hidden: BonusApproval[];
};

/**
 * Determines whether an approval row should be hidden from the CFO action queue,
 * and returns a human-readable reason if so. Centralizing this keeps the filter
 * rule and the disclosure UI in lock-step — finance staff can always see WHY a
 * row was filtered, never just THAT it was.
 */
function classifyForCfoQueue(row: BonusApproval): { hidden: boolean; reason: string | null } {
  const sameActor =
    !!row.landlord_ops_approved_by &&
    !!row.cfo_approved_by &&
    row.landlord_ops_approved_by === row.cfo_approved_by;

  if (row.status === 'paid' && sameActor) {
    return {
      hidden: true,
      reason: 'Auto-paid on Landlord Ops verification (same actor on both stamps — no CFO review needed)',
    };
  }
  if (row.status === 'paid' && !sameActor) {
    return { hidden: true, reason: 'Already paid via manual CFO approval' };
  }
  if (row.status === 'failed') {
    return { hidden: true, reason: 'Ledger write failed and was rolled back — needs admin retry, not CFO approval' };
  }
  return { hidden: false, reason: null };
}

export function ListingBonusApprovalQueue({ filter = 'pending_cfo', collapsible = false, defaultOpen = false }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [rejectNotes, setRejectNotes] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(defaultOpen);

  const { data: classified, isLoading } = useQuery<Classified>({
    queryKey: ['listing-bonus-approvals', filter],
    queryFn: async () => {
      // For the CFO queue we need both pending_cfo rows AND a recent sample of
      // hidden rows so we can disclose what was filtered out and why. For the
      // 'all' (Landlord Ops) view we just take everything recent.
      let pendingPromise = supabase
        .from('listing_bonus_approvals')
        .select('*')
        .eq('status', 'pending_cfo')
        .order('created_at', { ascending: false })
        .limit(100);

      // Hidden = paid (auto or manual) or failed, recent slice for transparency
      let hiddenPromise = supabase
        .from('listing_bonus_approvals')
        .select('*')
        .in('status', ['paid', 'failed'])
        .order('created_at', { ascending: false })
        .limit(20);

      if (filter === 'all') {
        // 'all' view: one query for everything; no separate hidden bucket needed
        const { data } = await supabase
          .from('listing_bonus_approvals')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(100);
        return await enrich(data || [], []);
      }

      const [pendingRes, hiddenRes] = await Promise.all([pendingPromise, hiddenPromise]);
      const pendingRows = pendingRes.data || [];
      const hiddenRowsRaw = hiddenRes.data || [];
      return await enrich(pendingRows, hiddenRowsRaw);
    },
    staleTime: 15000,
  });

  const handleAction = async (approvalId: string, action: 'approve' | 'reject') => {
    setProcessingId(approvalId);
    try {
      const { error } = await supabase.functions.invoke('approve-listing-bonus', {
        body: {
          approval_id: approvalId,
          action,
          notes: action === 'reject' ? (rejectNotes[approvalId] || 'Rejected') : 'Approved',
        },
      });

      if (error) throw error;

      toast({
        title: action === 'approve' ? '✅ Bonus Approved & Paid' : '❌ Bonus Rejected',
        description: action === 'approve'
          ? 'UGX 5,000 credited to agent wallet as platform expense'
          : 'Agent has been notified',
      });
      queryClient.invalidateQueries({ queryKey: ['listing-bonus-approvals'] });
    } catch (err: any) {
      toast({ title: 'Failed', description: err.message, variant: 'destructive' });
    } finally {
      setProcessingId(null);
    }
  };

  const visible = classified?.visible || [];
  const hidden = classified?.hidden || [];
  const pending = visible.filter(a => a.status === 'pending_cfo');
  const processed = visible.filter(a => a.status !== 'pending_cfo');

  if (isLoading) {
    return <Skeleton className="h-24 w-full rounded-xl" />;
  }

  // For CFO queue, render even when nothing pending IF there are hidden rows to disclose
  if (filter === 'pending_cfo' && pending.length === 0 && hidden.length === 0) {
    return null;
  }

  return (
    <Card className="border-amber-400/40 bg-amber-50/50 dark:bg-amber-950/20">
      <CardHeader className="pb-2 px-4 pt-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Banknote className="h-4 w-4 text-amber-600" />
            Listing Bonus Approvals
            {pending.length > 0 && (
              <Badge className="bg-amber-500/20 text-amber-700 border-0 text-xs animate-pulse">
                {pending.length} pending
              </Badge>
            )}
          </CardTitle>
          {collapsible && (
            <button
              onClick={() => setOpen(o => !o)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {open ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" /> Hide
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" /> Show
                </>
              )}
            </button>
          )}
        </div>
      </CardHeader>
      {(!collapsible || open) && (
      <CardContent className="px-4 pb-4 space-y-2">
        {pending.length === 0 && filter !== 'pending_cfo' && processed.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">No listing bonus approvals yet</p>
        )}

        {pending.map(approval => (
          <div key={approval.id} className="rounded-xl border border-border bg-card p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Home className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <p className="font-semibold text-sm truncate">{approval.listing_title}</p>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Agent: <span className="font-medium text-foreground">{approval.agent_name}</span>
                </p>
                {approval.landlord_ops_notes && (
                  <p className="text-[10px] text-muted-foreground mt-0.5 italic">
                    Landlord Ops: "{approval.landlord_ops_notes}"
                  </p>
                )}
              </div>
              <Badge className="bg-primary/10 text-primary border-0 font-bold shrink-0">
                UGX {approval.amount.toLocaleString()}
              </Badge>
            </div>

            {filter === 'pending_cfo' && (
              <div className="flex gap-2 items-center">
                <Input
                  placeholder="Rejection reason (optional)"
                  value={rejectNotes[approval.id] || ''}
                  onChange={e => setRejectNotes(prev => ({ ...prev, [approval.id]: e.target.value }))}
                  className="h-8 text-xs flex-1"
                />
                <Button
                  size="sm"
                  className="h-8 text-xs gap-1 bg-green-600 hover:bg-green-700"
                  onClick={() => handleAction(approval.id, 'approve')}
                  disabled={processingId === approval.id}
                >
                  {processingId === approval.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                  Pay
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-8 text-xs gap-1"
                  onClick={() => handleAction(approval.id, 'reject')}
                  disabled={processingId === approval.id}
                >
                  <XCircle className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        ))}

        {/* ─── HIDDEN ROW DISCLOSURE (CFO queue only) ─── */}
        {filter === 'pending_cfo' && hidden.length > 0 && (
          <HiddenDisclosure rows={hidden} />
        )}

        {/* Show processed history when viewing all */}
        {filter === 'all' && processed.length > 0 && (
          <div className="space-y-1.5 pt-2 border-t border-border">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase">History</p>
            {processed.slice(0, 20).map(a => (
              <div key={a.id} className="flex items-center justify-between text-xs px-2 py-1.5 rounded-lg bg-muted/30">
                <div className="flex items-center gap-2 min-w-0">
                  <Home className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="truncate">{a.listing_title}</span>
                  <span className="text-muted-foreground">→ {a.agent_name}</span>
                </div>
                <Badge
                  className={`text-[9px] border-0 shrink-0 ${
                    a.status === 'paid' ? 'bg-green-500/20 text-green-700' :
                    a.status === 'rejected' ? 'bg-red-500/20 text-red-700' :
                    'bg-amber-500/20 text-amber-700'
                  }`}
                >
                  {a.status === 'paid' ? '✅ Paid' : a.status === 'rejected' ? '❌ Rejected' : '⏳ Pending'}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      )}
    </Card>
  );
}

/**
 * Joins listing titles, agent names, and (for hidden rows) the actor name
 * who stamped the row, then runs the CFO-queue classifier so the UI can
 * always render the WHY beside the WHAT.
 */
async function enrich(visibleRaw: any[], hiddenRaw: any[]): Promise<Classified> {
  const all = [...visibleRaw, ...hiddenRaw];
  if (!all.length) return { visible: [], hidden: [] };

  const agentIds = [...new Set(all.map(d => d.agent_id))];
  const listingIds = [...new Set(all.map(d => d.listing_id))];
  const actorIds = [
    ...new Set(
      hiddenRaw
        .flatMap(d => [d.cfo_approved_by, d.landlord_ops_approved_by])
        .filter(Boolean) as string[],
    ),
  ];

  const [agentsRes, listingsRes, actorsRes] = await Promise.all([
    supabase.from('profiles').select('id, full_name').in('id', agentIds),
    supabase.from('house_listings').select('id, title').in('id', listingIds),
    actorIds.length
      ? supabase.from('profiles').select('id, full_name').in('id', actorIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const agentMap = new Map((agentsRes.data || []).map(p => [p.id, p.full_name]));
  const listingMap = new Map((listingsRes.data || []).map(l => [l.id, l.title]));
  const actorMap = new Map((actorsRes.data || []).map((p: any) => [p.id, p.full_name]));

  const visible: BonusApproval[] = visibleRaw.map(d => ({
    ...d,
    agent_name: agentMap.get(d.agent_id) || 'Unknown',
    listing_title: listingMap.get(d.listing_id) || 'Unknown',
  }));

  const hidden: BonusApproval[] = hiddenRaw.map(d => {
    const { reason } = classifyForCfoQueue(d);
    // Attribute the hide to whoever stamped CFO (auto-pay self-approves with manager id;
    // manual CFO approval also stamps cfo_approved_by). Fall back to landlord_ops actor.
    const actorId = d.cfo_approved_by || d.landlord_ops_approved_by;
    return {
      ...d,
      agent_name: agentMap.get(d.agent_id) || 'Unknown',
      listing_title: listingMap.get(d.listing_id) || 'Unknown',
      hide_reason: reason,
      hide_actor_name: actorId ? (actorMap.get(actorId) || null) : null,
    };
  });

  return { visible, hidden };
}

/**
 * Collapsible footer that lists every bonus row hidden from the CFO action
 * queue, with the rule that excluded it and who stamped it. Lets finance
 * staff trust the filter — never silent, always auditable.
 */
function HiddenDisclosure({ rows }: { rows: BonusApproval[] }) {
  const [open, setOpen] = useState(false);

  // Group by reason for a clean summary
  const groups = rows.reduce<Record<string, BonusApproval[]>>((acc, r) => {
    const key = r.hide_reason || 'Hidden';
    if (!acc[key]) acc[key] = [];
    acc[key].push(r);
    return acc;
  }, {});

  return (
    <div className="rounded-xl border border-dashed border-muted-foreground/30 bg-muted/20 p-3 mt-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 text-left min-h-[32px]"
      >
        <div className="flex items-center gap-2 min-w-0">
          <EyeOff className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium text-foreground">
            {rows.length} bonus {rows.length === 1 ? 'row' : 'rows'} hidden from this queue
          </span>
          <Badge className="bg-muted text-muted-foreground border-0 text-[9px]">Why?</Badge>
        </div>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {Object.entries(groups).map(([reason, items]) => (
            <div key={reason} className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {reason}{' '}
                <span className="text-foreground">({items.length})</span>
              </p>
              <div className="space-y-1">
                {items.slice(0, 10).map(r => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-2 text-[11px] px-2 py-1.5 rounded-lg bg-card border border-border"
                  >
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <Home className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="truncate font-medium">{r.listing_title}</span>
                      <span className="text-muted-foreground shrink-0">→ {r.agent_name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {r.hide_actor_name && (
                        <span className="text-[10px] text-muted-foreground">
                          by <span className="text-foreground font-medium">{r.hide_actor_name}</span>
                        </span>
                      )}
                      <Badge
                        className={`text-[9px] border-0 ${
                          r.status === 'paid'
                            ? 'bg-green-500/15 text-green-700'
                            : r.status === 'failed'
                              ? 'bg-red-500/15 text-red-700'
                              : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {r.status}
                      </Badge>
                    </div>
                  </div>
                ))}
                {items.length > 10 && (
                  <p className="text-[10px] text-muted-foreground text-center pt-1">
                    + {items.length - 10} more
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
