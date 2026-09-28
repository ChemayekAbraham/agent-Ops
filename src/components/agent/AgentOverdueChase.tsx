import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Phone,
  ListOrdered,
  CheckCircle2,
  PhoneCall,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import {
  useAgentArrears,
  type AgentArrearsTenant,
} from '@/hooks/useAgentArrears';
import {
  useAgentOverdueTouches,
  useMarkAgentOverdueTouch,
  touchMapFrom,
} from '@/hooks/useAgentOverdueTouches';
import {
  AGENT_OVERDUE_CHASE_ENABLED,
  AGENT_OVERDUE_CHASE_MODAL_ENABLED,
  AGENT_OVERDUE_CHASE_NUDGE_MS,
  AGENT_OVERDUE_CHASE_SMS_REFIRING_ENABLED,
  AGENT_OVERDUE_CHASE_SMS_INTERVAL_MS,
} from '@/lib/agentOverdueChaseFlag';
import { toast } from 'sonner';

/**
 * Aggressive overdue chase on the agent dashboard.
 *
 * Success (Collections / Faith):
 *   TAPPED = tapped_at on open / Call CTA
 *   CALLED = Mark called / Call CTA writes called_at (tel: alone does NOT count)
 *   DONE   = both on the same EAT day
 * Banner + modal stay until 100% of due/overdue book is DONE.
 *
 * Copy: locked OPTION A + "Call every due tenant until all show Called."
 */

const COPY_HEADLINE = 'ACT NOW — Your tenants have rent DUE / OVERDUE.';
const COPY_BODY = "Call them. Go to the field. Collect today's rent before you do anything else.";
const COPY_UNTIL = 'Call every due tenant until all show Called.';
const COPY_PAY = 'Pay path: MTN 090777 (*165*3#) · Airtel 4380664 (*185*9#) · Equity 1046203375259 — Welile ref in reason. Climb toward 30M.';

interface Props {
  agentId: string;
}

export function AgentOverdueChase({ agentId }: Props) {
  const enabled = AGENT_OVERDUE_CHASE_ENABLED;
  const { data: arrears } = useAgentArrears(agentId, enabled);
  const { data: touchDay } = useAgentOverdueTouches(agentId, enabled);
  const markTouch = useMarkAgentOverdueTouch(agentId);

  const [modalOpen, setModalOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [nudgeTick, setNudgeTick] = useState(0);

  const tenants = arrears?.tenants ?? [];
  const totals = arrears?.totals;
  const arrearsUgx = Number(totals?.arrears_ugx ?? 0);
  const dueTodayUgx = Number(totals?.due_today_ugx ?? 0);
  const behindCount = Number(totals?.tenants_behind ?? tenants.length ?? 0);
  const pressureUgx = arrearsUgx > 0 ? arrearsUgx : dueTodayUgx;
  const hasPressure = behindCount > 0 || arrearsUgx > 0 || dueTodayUgx > 0;

  const touches = touchMapFrom(touchDay?.touches);
  const doneCount = useMemo(() => {
    if (!tenants.length) return 0;
    return tenants.filter((t) => touches[t.rent_request_id]?.done).length;
  }, [tenants, touches]);
  const totalCount = tenants.length;
  const pctDone =
    totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 100;
  const bookComplete =
    !hasPressure || (totalCount > 0 && doneCount >= totalCount);

  useEffect(() => {
    if (!enabled || bookComplete || !AGENT_OVERDUE_CHASE_MODAL_ENABLED) {
      setModalOpen(false);
      return;
    }
    setModalOpen(true);
  }, [enabled, bookComplete, nudgeTick]);

  useEffect(() => {
    if (!enabled || bookComplete || !AGENT_OVERDUE_CHASE_MODAL_ENABLED) return;
    const id = window.setInterval(() => {
      setNudgeTick((n) => n + 1);
    }, AGENT_OVERDUE_CHASE_NUDGE_MS);
    return () => window.clearInterval(id);
  }, [enabled, bookComplete]);

  useEffect(() => {
    if (
      !AGENT_OVERDUE_CHASE_SMS_REFIRING_ENABLED ||
      !enabled ||
      bookComplete
    ) {
      return;
    }
    const id = window.setInterval(() => {
      console.info(
        '[agent-overdue-chase] SMS re-fire stub tick (flag on, sender not wired)',
        { agentId, pctDone, totalCount, doneCount },
      );
    }, AGENT_OVERDUE_CHASE_SMS_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, bookComplete, agentId, pctDone, totalCount, doneCount]);

  if (!enabled || !hasPressure) return null;

  const openList = () => {
    hapticTap();
    setListOpen(true);
    setModalOpen(false);
  };

  const onTapOpen = async (t: AgentArrearsTenant) => {
    try {
      await markTouch.mutateAsync({
        rentRequestId: t.rent_request_id,
        event: 'tapped',
        tenantId: t.tenant_id,
      });
    } catch (e) {
      console.warn('[agent-overdue-chase] mark tapped failed', e);
    }
  };

  const onCallTenant = async (t: AgentArrearsTenant) => {
    hapticTap();
    // Call CTA writes called_at (+ tapped_at). Raw tel: alone would not count.
    try {
      await markTouch.mutateAsync({
        rentRequestId: t.rent_request_id,
        event: 'called',
        tenantId: t.tenant_id,
      });
    } catch (e) {
      console.warn('[agent-overdue-chase] mark called failed', e);
      toast.error('Could not save call mark — try Mark called');
    }
    const phone = (t.tenant_phone || '').trim();
    if (phone) {
      window.location.href = `tel:${phone}`;
    } else {
      toast.message('No phone on file — mark called after you reach them');
    }
  };

  const onMarkCalled = async (t: AgentArrearsTenant) => {
    hapticTap();
    try {
      await markTouch.mutateAsync({
        rentRequestId: t.rent_request_id,
        event: 'called',
        tenantId: t.tenant_id,
      });
      toast.success(`Marked called — ${t.tenant_name ?? 'tenant'}`);
    } catch (e) {
      console.warn('[agent-overdue-chase] mark called failed', e);
      toast.error('Could not save Mark called');
    }
  };

  const countLabel =
    behindCount > 0
      ? `${behindCount} tenant${behindCount === 1 ? '' : 's'}`
      : `${totalCount || '—'} tenant${totalCount === 1 ? '' : 's'}`;

  return (
    <>
      <div
        role="status"
        className="relative rounded-2xl border-2 border-destructive bg-destructive text-destructive-foreground p-4 overflow-hidden shadow-lg shadow-destructive/25 animate-fade-in"
      >
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-xl bg-white/15 shrink-0">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0 space-y-1.5">
            <p className="text-sm font-black uppercase tracking-wide leading-snug">
              {COPY_HEADLINE}
            </p>
            <p className="text-xs font-medium text-destructive-foreground/95 leading-relaxed">
              {COPY_BODY}
            </p>
            <p className="text-xs font-bold text-destructive-foreground">
              {COPY_UNTIL}
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <Badge
                variant="secondary"
                className="bg-white/20 text-destructive-foreground border-0 font-bold tabular-nums"
              >
                {doneCount}/{totalCount || behindCount} Called · {pctDone}%
              </Badge>
              {(behindCount > 0 || pressureUgx > 0) && (
                <span className="text-xs font-bold tabular-nums">
                  {countLabel}
                  {pressureUgx > 0 ? ` · ${formatUGX(pressureUgx)}` : ''}
                </span>
              )}
            </div>
            <p className="text-[11px] leading-relaxed text-destructive-foreground/90 pt-0.5">
              {COPY_PAY}
            </p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Button
            type="button"
            variant="secondary"
            className="h-11 gap-1.5 font-bold"
            onClick={openList}
          >
            <Phone className="h-4 w-4" /> Call tenants
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="h-11 gap-1.5 font-bold"
            onClick={openList}
          >
            <ListOrdered className="h-4 w-4" /> Open overdue list
          </Button>
        </div>
        {!bookComplete && (
          <p className="mt-2 text-[10px] text-center text-destructive-foreground/80">
            Banner stays until every due tenant shows Called ({pctDone}% today).
          </p>
        )}
      </div>

      <Dialog open={modalOpen} onOpenChange={() => { /* CTAs only */ }}>
        <DialogContent
          className="max-w-md border-2 border-destructive p-0 overflow-hidden gap-0 [&>button]:hidden"
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className="bg-destructive text-destructive-foreground px-5 pt-5 pb-4">
            <DialogHeader className="space-y-2 text-left">
              <DialogTitle className="flex items-start gap-2 text-base font-black uppercase tracking-wide text-destructive-foreground">
                <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                {COPY_HEADLINE}
              </DialogTitle>
              <DialogDescription className="text-sm text-destructive-foreground/95 font-medium leading-relaxed">
                {COPY_BODY}
              </DialogDescription>
            </DialogHeader>
            <p className="mt-2 text-xs font-bold">{COPY_UNTIL}</p>
            <p className="mt-2 text-sm font-bold tabular-nums">
              {doneCount}/{totalCount || behindCount} Called · {pctDone}%
              {pressureUgx > 0 ? ` · ${formatUGX(pressureUgx)}` : ''}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-destructive-foreground/90">
              {COPY_PAY}
            </p>
          </div>
          <div className="p-4 space-y-2 bg-background">
            <Button
              type="button"
              className="w-full h-12 gap-2 font-bold text-base"
              onClick={openList}
            >
              <Phone className="h-4 w-4" /> Call tenants
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="w-full h-11 gap-2 font-bold"
              onClick={openList}
            >
              <ListOrdered className="h-4 w-4" /> Open overdue list
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Sheet open={listOpen} onOpenChange={setListOpen}>
        <SheetContent
          side="bottom"
          className="h-[85vh] rounded-t-2xl p-0 flex flex-col"
        >
          <SheetHeader className="p-4 pb-2 border-b border-border/40 text-left">
            <SheetTitle className="flex items-center gap-2">
              <PhoneCall className="h-5 w-5 text-destructive" />
              Due / overdue — call until Called
            </SheetTitle>
            <SheetDescription>
              {doneCount}/{totalCount} Called today ({pctDone}%). Call CTA saves
              Called; tel: alone does not. Mark called if you reached them
              another way.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {tenants.length === 0 && (
              <div className="text-center py-12 text-muted-foreground text-sm">
                No due / overdue tenants on your book right now.
              </div>
            )}
            {tenants.map((t) => {
              const touch = touches[t.rent_request_id];
              const isDone = Boolean(touch?.done);
              const isTapped = Boolean(touch?.tapped_at);
              const isCalled = Boolean(touch?.called_at);
              return (
                <div
                  key={t.rent_request_id}
                  className={`rounded-xl border p-3 space-y-2 ${
                    isDone
                      ? 'border-emerald-500/40 bg-emerald-500/5'
                      : 'border-destructive/25 bg-destructive/5'
                  }`}
                >
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => void onTapOpen(t)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-sm truncate">
                          {t.tenant_name ?? 'Tenant'}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {Number(t.days_behind ?? 0)}d behind
                          {Number(t.due_today_ugx ?? 0) > 0
                            ? ` · +${formatUGX(Number(t.due_today_ugx))} today`
                            : ''}
                        </p>
                      </div>
                      <div className="text-right shrink-0 space-y-1">
                        <p className="font-bold text-sm text-destructive tabular-nums">
                          {formatUGX(Number(t.arrears_ugx ?? 0))}
                        </p>
                        <Badge
                          variant={isDone ? 'default' : 'outline'}
                          className={`text-[10px] ${
                            isDone
                              ? 'bg-emerald-600'
                              : isCalled
                                ? 'border-amber-500 text-amber-700'
                                : isTapped
                                  ? 'border-sky-500 text-sky-700'
                                  : ''
                          }`}
                        >
                          {isDone
                            ? 'Called ✓'
                            : isCalled
                              ? 'Called (need tap)'
                              : isTapped
                                ? 'Tapped'
                                : 'Not touched'}
                        </Badge>
                      </div>
                    </div>
                  </button>
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      className="flex-1 h-9 text-xs gap-1"
                      onClick={() => void onCallTenant(t)}
                      disabled={markTouch.isPending}
                    >
                      <Phone className="h-3 w-3" /> Call
                    </Button>
                    <Button
                      size="sm"
                      variant={isCalled ? 'secondary' : 'outline'}
                      className="flex-1 h-9 text-xs gap-1"
                      onClick={() => void onMarkCalled(t)}
                      disabled={markTouch.isPending || isDone}
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      {isCalled ? 'Called' : 'Mark called'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export default AgentOverdueChase;
