import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/UserAvatar';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
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
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import {
  CheckCircle2, Clock, Coins, ShieldCheck, Users, Loader2, XCircle,
  ChevronRight, Wallet, ReceiptText, TrendingUp, UserMinus,
} from 'lucide-react';

interface OverrideAgg {
  total: number;
  count: number;
  lastAt: string | null;
}

interface StatusRow {
  id: string;
  sub_agent_id: string;
  status: string;
  created_at: string;
  name: string;
  phone: string | null;
  avatar_url: string | null;
  override: OverrideAgg;
}

const ACCEPTED_STATES = ['verified', 'accepted', 'approved'];
const DECLINED_STATES = ['declined', 'rejected'];

interface OverrideEvent {
  id: string;
  event_type: string;
  label: string | null;
  amount: number;
  status: string;
  created_at: string;
}

interface RecruiterSplit {
  trace_id: string;
  created_at: string;
  tenant_name: string;
  amount: number;
  recruiter_override: number;
}

interface WalletSnapshot {
  balance: number;
  withdrawable_balance: number;
  float_balance: number;
  advance_balance: number;
}

interface DrawerData {
  loading: boolean;
  wallet: WalletSnapshot | null;
  events: OverrideEvent[];
  splits: RecruiterSplit[];
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  house_listed_verified: 'House listing verified',
  landlord_verified: 'Landlord verified',
  lc1_verified: 'LC1 chairperson verified',
};

function prettyEventType(t: string): string {
  return EVENT_TYPE_LABELS[t] || t.replace(/_/g, ' ');
}

function acceptanceLabel(status: string): { label: string; tone: 'accepted' | 'pending' | 'declined' } {
  if (ACCEPTED_STATES.includes(status)) return { label: 'Accepted', tone: 'accepted' };
  if (DECLINED_STATES.includes(status)) return { label: 'Declined', tone: 'declined' };
  return { label: 'Invite pending', tone: 'pending' };
}

/**
 * Sub-agent earnings/status board.
 * Lists each invitee, their acceptance state, and whether recruiter
 * override earnings are active (earning now) or not yet (pending/eligible).
 */
export function SubAgentStatusBoard() {
  const { user } = useAuth();
  const [rows, setRows] = useState<StatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<StatusRow | null>(null);
  const [drawer, setDrawer] = useState<DrawerData>({ loading: false, wallet: null, events: [], splits: [] });
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const handleUnlink = async () => {
    if (!selected || !user) return;
    setUnlinking(true);
    try {
      const { error } = await supabase.rpc('release_sub_agent', {
        p_sub_agent_id: selected.sub_agent_id,
      });
      if (error) {
        toast.error('Could not unlink sub-agent', { description: error.message });
        return;
      }

      // Fire-and-forget web-push to the released sub-agent.
      supabase.functions
        .invoke('send-push-notification', {
          body: {
            userIds: [selected.sub_agent_id],
            payload: {
              title: 'You are now an independent agent',
              body:
                'Your lead agent has released you from their team. Your override earnings from them have stopped. You can be invited again by another agent, or keep growing on your own.',
              type: 'sub_agent_released',
              url: '/dashboard',
            },
          },
        })
        .catch(() => {});

      toast.success(`${selected.name} unlinked`, {
        description: 'They are now an independent agent and can be reinvited.',
      });
      setConfirmUnlink(false);
      setSelected(null);
      // Refresh the board
      setRows((prev) => prev.filter((r) => r.sub_agent_id !== selected.sub_agent_id));
    } finally {
      setUnlinking(false);
    }
  };

  // Load wallet + override breakdown when a row is opened
  useEffect(() => {
    if (!selected || !user) return;
    let cancelled = false;
    (async () => {
      setDrawer({ loading: true, wallet: null, events: [], splits: [] });
      try {
        const [walletRes, eventsRes, splitsRes] = await Promise.all([
          supabase
            .from('wallets')
            .select('balance, withdrawable_balance, float_balance, advance_balance')
            .eq('user_id', selected.sub_agent_id)
            .maybeSingle(),
          supabase
            .from('recruiter_override_events')
            .select('id, event_type, label, amount, status, created_at')
            .eq('recruiter_id', user.id)
            .eq('sub_agent_id', selected.sub_agent_id)
            .order('created_at', { ascending: false }),
          supabase.rpc('get_subagent_recruiter_splits', { p_sub_agent_id: selected.sub_agent_id }),
        ]);

        if (cancelled) return;
        setDrawer({
          loading: false,
          wallet: (walletRes.data as WalletSnapshot) || null,
          events: (eventsRes.data as OverrideEvent[]) || [],
          splits: ((splitsRes.data as RecruiterSplit[]) || []).filter((s) => Number(s.recruiter_override) > 0),
        });
      } catch (err) {
        console.error('Error loading invitee breakdown:', err);
        if (!cancelled) setDrawer({ loading: false, wallet: null, events: [], splits: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [selected, user]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [subRes, ovrRes] = await Promise.all([
          supabase
            .from('agent_subagents')
            .select('id, sub_agent_id, status, created_at')
            .eq('parent_agent_id', user.id)
            .order('created_at', { ascending: false }),
          supabase
            .from('recruiter_override_events')
            .select('sub_agent_id, amount, status, created_at')
            .eq('recruiter_id', user.id)
            .eq('status', 'credited'),
        ]);

        const subs = subRes.data || [];
        const overrides = ovrRes.data || [];

        // Aggregate override earnings per sub-agent
        const ovrMap: Record<string, OverrideAgg> = {};
        for (const o of overrides) {
          const key = o.sub_agent_id as string;
          if (!ovrMap[key]) ovrMap[key] = { total: 0, count: 0, lastAt: null };
          ovrMap[key].total += Number(o.amount) || 0;
          ovrMap[key].count += 1;
          if (!ovrMap[key].lastAt || (o.created_at as string) > ovrMap[key].lastAt!) {
            ovrMap[key].lastAt = o.created_at as string;
          }
        }

        // Resolve profile names
        const ids = [...new Set(subs.map((s) => s.sub_agent_id))] as string[];
        const nameMap: Record<string, { full_name: string; phone: string | null; avatar_url: string | null }> = {};
        if (ids.length > 0) {
          // SECURITY DEFINER RPC — lets the parent agent resolve their
          // sub-agents' names/phones (profiles RLS blocks direct reads).
          const { data: profiles } = await supabase.rpc('get_my_subagent_profiles');
          const idSet = new Set(ids);
          for (const p of (profiles as Array<{ id: string; full_name: string; phone: string | null; avatar_url: string | null }>) || []) {
            if (idSet.has(p.id)) {
              nameMap[p.id] = { full_name: p.full_name || 'Unknown', phone: p.phone, avatar_url: p.avatar_url };
            }
          }
        }

        const out: StatusRow[] = subs.map((s) => ({
          id: s.id,
          sub_agent_id: s.sub_agent_id,
          status: s.status || 'pending_acceptance',
          created_at: s.created_at,
          name: nameMap[s.sub_agent_id]?.full_name || 'Unknown',
          phone: nameMap[s.sub_agent_id]?.phone ?? null,
          avatar_url: nameMap[s.sub_agent_id]?.avatar_url ?? null,
          override: ovrMap[s.sub_agent_id] || { total: 0, count: 0, lastAt: null },
        }));

        if (!cancelled) setRows(out);
      } catch (err) {
        console.error('Error loading sub-agent status board:', err);
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const acceptedCount = rows.filter((r) => ACCEPTED_STATES.includes(r.status)).length;
  const activeEarnersCount = rows.filter((r) => r.override.total > 0).length;
  const totalOverride = rows.reduce((sum, r) => sum + r.override.total, 0);

  return (
    <Card id="subagent-status" className="scroll-mt-28 border-border/60 shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-orange-500" />
          Sub-Agent Status &amp; Earnings
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Each invitee's acceptance state and whether your recruiter override earnings are active.
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center space-y-2">
            <Users className="h-8 w-8 text-muted-foreground/50 mx-auto" />
            <p className="text-sm text-muted-foreground">No sub-agents invited yet.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary chips */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl bg-muted/60 p-2.5 text-center">
                <p className="text-[10px] text-muted-foreground">Invitees</p>
                <p className="font-bold text-lg leading-none mt-1">{rows.length}</p>
              </div>
              <div className="rounded-xl bg-muted/60 p-2.5 text-center">
                <p className="text-[10px] text-muted-foreground">Accepted</p>
                <p className="font-bold text-lg leading-none mt-1 text-emerald-600">{acceptedCount}</p>
              </div>
              <div className="rounded-xl bg-muted/60 p-2.5 text-center">
                <p className="text-[10px] text-muted-foreground">Active earners</p>
                <p className="font-bold text-lg leading-none mt-1 text-orange-500">{activeEarnersCount}</p>
              </div>
            </div>

            {totalOverride > 0 && (
              <div className="flex items-center justify-between rounded-xl border border-orange-500/20 bg-orange-500/[0.06] px-3 py-2">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <Coins className="h-3.5 w-3.5 text-orange-500" />
                  Total recruiter override earned
                </span>
                <span className="text-sm font-bold text-orange-600">{formatUGX(totalOverride)}</span>
              </div>
            )}

            {/* Rows */}
            <div className="space-y-2">
              {rows.map((r) => {
                const accept = acceptanceLabel(r.status);
                const isAccepted = accept.tone === 'accepted';
                const earningActive = r.override.total > 0;

                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelected(r)}
                    className="w-full text-left flex items-center gap-3 rounded-xl border border-border/60 p-3 transition-colors hover:bg-muted/50 active:scale-[0.99]"
                  >
                    <UserAvatar avatarUrl={r.avatar_url} fullName={r.name} size="sm" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm leading-tight truncate">{r.name}</p>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        {/* Acceptance state */}
                        {accept.tone === 'accepted' && (
                          <Badge className="gap-1 text-[10px] px-1.5 py-0 bg-emerald-500/15 text-emerald-600 border border-emerald-500/30 hover:bg-emerald-500/15">
                            <CheckCircle2 className="h-3 w-3" /> {accept.label}
                          </Badge>
                        )}
                        {accept.tone === 'pending' && (
                          <Badge className="gap-1 text-[10px] px-1.5 py-0 bg-amber-500/15 text-amber-600 border border-amber-500/30 hover:bg-amber-500/15">
                            <Clock className="h-3 w-3" /> {accept.label}
                          </Badge>
                        )}
                        {accept.tone === 'declined' && (
                          <Badge className="gap-1 text-[10px] px-1.5 py-0 bg-destructive/15 text-destructive border border-destructive/30 hover:bg-destructive/15">
                            <XCircle className="h-3 w-3" /> {accept.label}
                          </Badge>
                        )}
                      </div>
                    </div>

                    {/* Override earnings status */}
                    <div className="text-right shrink-0">
                      {earningActive ? (
                        <>
                          <Badge className="gap-1 text-[10px] px-1.5 py-0 bg-orange-500/15 text-orange-600 border border-orange-500/30 hover:bg-orange-500/15">
                            <span className="relative flex h-1.5 w-1.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-orange-500" />
                            </span>
                            Active
                          </Badge>
                          <p className="text-xs font-bold text-orange-600 mt-1">{formatUGX(r.override.total)}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {r.override.count} payout{r.override.count === 1 ? '' : 's'}
                          </p>
                        </>
                      ) : isAccepted ? (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                          Eligible · no earnings yet
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                          Not yet
                        </Badge>
                      )}
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground/60 shrink-0" />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>

      {/* Click-through breakdown drawer */}
      <Sheet open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <SheetContent side="bottom" className="h-[88vh] rounded-t-2xl overflow-y-auto pb-10">
          {selected && (
            <>
              <SheetHeader className="pb-3 border-b border-border mb-4">
                <SheetTitle className="flex items-center gap-3 text-left">
                  <UserAvatar avatarUrl={selected.avatar_url} fullName={selected.name} size="md" />
                  <div className="min-w-0">
                    <p className="font-bold text-base leading-tight truncate">{selected.name}</p>
                    {selected.phone && <p className="text-xs text-muted-foreground font-normal">{selected.phone}</p>}
                  </div>
                </SheetTitle>
              </SheetHeader>

              {drawer.loading ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : (
                <div className="space-y-5">
                  {/* Wallet snapshot */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-2">
                      <Wallet className="h-3.5 w-3.5" /> Wallet breakdown
                    </p>
                    {drawer.wallet ? (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-xl bg-muted/60 p-3">
                          <p className="text-[10px] text-muted-foreground">Withdrawable</p>
                          <p className="font-bold text-base leading-none mt-1 text-emerald-600">{formatUGX(drawer.wallet.withdrawable_balance || 0)}</p>
                        </div>
                        <div className="rounded-xl bg-muted/60 p-3">
                          <p className="text-[10px] text-muted-foreground">Float</p>
                          <p className="font-bold text-base leading-none mt-1">{formatUGX(drawer.wallet.float_balance || 0)}</p>
                        </div>
                        <div className="rounded-xl bg-muted/60 p-3">
                          <p className="text-[10px] text-muted-foreground">Advance owed</p>
                          <p className="font-bold text-base leading-none mt-1 text-amber-600">{formatUGX(drawer.wallet.advance_balance || 0)}</p>
                        </div>
                        <div className="rounded-xl bg-muted/60 p-3">
                          <p className="text-[10px] text-muted-foreground">Total balance</p>
                          <p className="font-bold text-base leading-none mt-1">{formatUGX(drawer.wallet.balance || 0)}</p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">No wallet found for this invitee.</p>
                    )}
                  </div>

                  {/* Your recruiter override earnings from this invitee */}
                  <div className="rounded-xl border border-orange-500/20 bg-orange-500/[0.06] p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium flex items-center gap-1.5">
                        <Coins className="h-3.5 w-3.5 text-orange-500" />
                        Your total override earned
                      </span>
                      <span className="text-sm font-bold text-orange-600">{formatUGX(selected.override.total)}</span>
                    </div>
                  </div>

                  {/* Verification bonus ledger entries (UGX 3,000 each) */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-2">
                      <ReceiptText className="h-3.5 w-3.5" /> Verification override entries
                    </p>
                    {drawer.events.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No verification override entries yet.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {drawer.events.map((e) => (
                          <div key={e.id} className="flex items-center gap-2 rounded-lg border border-border/60 p-2.5">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium leading-tight truncate">{prettyEventType(e.event_type)}</p>
                              {e.label && <p className="text-[10px] text-muted-foreground truncate">{e.label}</p>}
                              <p className="text-[10px] text-muted-foreground">{format(new Date(e.created_at), 'd MMM yyyy, HH:mm')}</p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-xs font-bold text-orange-600">{formatUGX(e.amount)}</p>
                              <Badge variant="secondary" className="text-[9px] px-1 py-0 capitalize">{e.status}</Badge>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 2% rent-collection override splits */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-2">
                      <TrendingUp className="h-3.5 w-3.5" /> Rent collection overrides (2%)
                    </p>
                    {drawer.splits.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No rent-collection overrides yet.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {drawer.splits.map((s) => (
                          <div key={s.trace_id} className="flex items-center gap-2 rounded-lg border border-border/60 p-2.5">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium leading-tight truncate">{s.tenant_name || 'Tenant collection'}</p>
                              <p className="text-[10px] text-muted-foreground">
                                On {formatUGX(s.amount)} · {format(new Date(s.created_at), 'd MMM yyyy')}
                              </p>
                            </div>
                            <p className="text-xs font-bold text-orange-600 shrink-0">+{formatUGX(s.recruiter_override)}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Unlink sub-agent */}
                  <div className="pt-2 border-t border-border/60">
                    <Button
                      variant="outline"
                      className="w-full gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setConfirmUnlink(true)}
                    >
                      <UserMinus className="h-4 w-4" />
                      Unlink sub-agent
                    </Button>
                    <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
                      They become an independent agent. Your override earnings from them stop, and they can be reinvited.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmUnlink} onOpenChange={setConfirmUnlink}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink {selected?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They will be released from your team and become an independent agent. Their tenants stay with
              them — nothing is transferred — and they will earn their full commission from now on. Your
              recruiter override earnings on their activity stop immediately. They can be invited again later
              by you or another agent, and they will be notified of this change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unlinking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleUnlink();
              }}
              disabled={unlinking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {unlinking ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" /> Unlinking…
                </>
              ) : (
                'Yes, unlink'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default SubAgentStatusBoard;