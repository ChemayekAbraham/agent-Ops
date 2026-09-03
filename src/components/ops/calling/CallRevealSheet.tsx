import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageCircle, Phone, PhoneOff, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { QUICK_OUTCOMES, ccErrorText, type CcCallingHub, type CcSubjectType } from '@/hooks/useCcCallingHub';
import { useCcSubjectSnapshot } from '@/hooks/useCcSubjectSnapshot';
import { telHref, waHref } from './ccPhone';
import { StatGrid, StatTile, DrawerSection, ContactCard, PersonHeader } from './CallDrawerUi';
import type { OpenFormAttempt } from './OpenAttemptList';

export type RevealTarget = {
  attemptId: string;
  cycleRowId: string;
  subjectId: string | null;
  name: string;
  attemptNo: number | null;
  phone: string | null;
  district?: string | null;
  linkedAgent?: string | null;
};

/**
 * Reveal panel: identity, the Missed Days figures for the same tenant, dial
 * shortcuts and outcome recording — all in one surface, at every viewport.
 * Bottom sheet on handsets, side panel from lg up.
 */
export function CallRevealSheet({
  hub,
  target,
  subjectType,
  belowLg,
  onClose,
  onOpenForm,
}: {
  hub: CcCallingHub;
  target: RevealTarget | null;
  subjectType: CcSubjectType;
  belowLg: boolean;
  onClose: () => void;
  onOpenForm: (attempt: OpenFormAttempt) => void;
}) {
  const phone = target?.phone ?? null;
  const attemptNo =
    target?.attemptNo ?? hub.openAttempts.find((a) => a.id === target?.attemptId)?.attempt_no ?? 1;

  const snapshotQ = useCcSubjectSnapshot(subjectType, target?.subjectId ?? null);
  const snap = snapshotQ.data ?? null;

  const risk = !snap ? null : snap.missed_days >= 5 ? 'critical' : snap.missed_days >= 2 ? 'warning' : 'on_track';
  const riskTone =
    risk === 'critical'
      ? 'bg-destructive/15 text-destructive border-destructive/30'
      : risk === 'warning'
        ? 'bg-amber-500/15 text-amber-600 border-amber-500/30'
        : 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30';
  const missedTone =
    risk === 'critical' ? 'text-destructive' : risk === 'warning' ? 'text-amber-600' : 'text-emerald-600';

  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side={belowLg ? 'bottom' : 'right'}
        className={
          belowLg
            ? 'max-h-[88vh] overflow-y-auto rounded-t-2xl pb-[calc(1.25rem+env(safe-area-inset-bottom))]'
            : 'flex w-full max-w-md flex-col gap-0 overflow-y-auto sm:max-w-md'
        }
      >
        <SheetHeader className="text-left">
          <SheetTitle className="text-base">Call details</SheetTitle>
          <p className="text-xs text-muted-foreground">
            Attempt {attemptNo} · dial, then come back and record the outcome
          </p>
        </SheetHeader>

        <div className="mt-3 space-y-3">
          <PersonHeader
            name={snap?.tenant_name || target?.name || 'Unnamed'}
            subtitle={
              [target?.district, snap?.status ? String(snap.status).replace(/_/g, ' ') : null]
                .filter(Boolean)
                .join(' · ') || undefined
            }
            badges={
              <>
                {risk && (
                  <Badge variant="outline" className={`text-[10px] ${riskTone}`}>
                    {snap?.missed_days}d missed
                  </Badge>
                )}
                {snap && (
                  <Badge variant="outline" className="text-[10px]">
                    {snap.repayment_pct}% repaid
                  </Badge>
                )}
              </>
            }
          >
            {phone ? (
              <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                <Button asChild className="h-12 w-full text-base font-bold">
                  <a href={telHref(phone)}>
                    <Phone className="mr-2 h-4 w-4" />
                    {phone}
                  </a>
                </Button>
                <Button asChild variant="outline" className="h-12 w-full">
                  <a href={waHref(phone)} target="_blank" rel="noreferrer">
                    <MessageCircle className="mr-2 h-4 w-4" />
                    WhatsApp
                  </a>
                </Button>
              </div>
            ) : (
              <p className="w-full rounded-lg bg-muted px-2.5 py-2 text-xs font-medium">
                No number is on file for this subject. Record the outcome so the attempt is not left open.
              </p>
            )}
          </PersonHeader>

          {subjectType === 'tenant' && (
            <DrawerSection title="Repayment position" className="mt-1">
              {snapshotQ.isLoading ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <Skeleton key={i} className="h-16 w-full rounded-xl" />
                  ))}
                </div>
              ) : !snap ? (
                <p className="rounded-xl border border-border/60 bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
                  No active rent plan figures are on file for this tenant.
                </p>
              ) : (
                <StatGrid>
                  <StatTile label="Days missed" value={`${snap.missed_days}d`} tone={missedTone} />
                  <StatTile label="Missed amount" value={formatUGX(snap.missed_amount)} tone="text-destructive" />
                  <StatTile label="Total owed" value={formatUGX(snap.outstanding_balance)} />
                  <StatTile label="Daily payment" value={formatUGX(snap.daily_repayment)} />
                  <StatTile label="Repaid so far" value={formatUGX(snap.amount_repaid)} tone="text-emerald-600" />
                  <StatTile label="Days active" value={`${snap.days_since_disbursed}d`} />
                  <StatTile label="Rent amount" value={formatUGX(snap.rent_amount)} />
                  <StatTile label="Plan total" value={formatUGX(snap.total_repayment)} />
                  <StatTile
                    label="Tenant wallet"
                    value={formatUGX(snap.tenant_wallet)}
                    tone={snap.tenant_wallet > 0 ? 'text-emerald-600' : 'text-destructive'}
                  />
                </StatGrid>
              )}
            </DrawerSection>
          )}

          <DrawerSection title="Contacts" icon={UserRound} className="mt-1">
            <div className="space-y-2">
              <ContactCard
                role="Tenant"
                name={snap?.tenant_name || target?.name || 'Unnamed'}
                phone={phone}
                meta={phone ? undefined : 'Number not revealed'}
              />
              <ContactCard
                role="Responsible agent"
                name={snap?.agent_name || target?.linkedAgent || '—'}
                phone={snap?.agent_phone || null}
                meta={
                  snap && snap.agent_id
                    ? `Agent wallet ${formatUGX(snap.agent_wallet)}`
                    : 'No agent linked'
                }
              />
            </div>
          </DrawerSection>

          <DrawerSection title="Record the outcome" icon={PhoneOff} className="mt-1">
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {QUICK_OUTCOMES.map((o) => (
                <Button
                  key={o.value}
                  variant="outline"
                  className="h-11 justify-start text-xs"
                  disabled={hub.recordQuick.isPending || !target}
                  onClick={() => {
                    const currentTarget = target;
                    if (!currentTarget) return;
                    hub.recordQuick.mutate(
                      { attemptId: currentTarget.attemptId, outcome: o.value },
                      {
                        onSuccess: () => {
                          toast.success(`Recorded: ${o.label}`);
                          onClose();
                        },
                        onError: (e) => toast.error(ccErrorText(e)),
                      },
                    );
                  }}

                >
                  <PhoneOff className="mr-2 h-4 w-4" />
                  {o.label}
                </Button>
              ))}
            </div>
            <Button
              className="mt-1.5 h-11 w-full"
              disabled={!target}
              onClick={() => {
                if (!target) return;
                onOpenForm({ id: target.attemptId, cycle_row_id: target.cycleRowId, name: target.name });
                onClose();
              }}
            >
              Engaged / Callback booked
            </Button>
          </DrawerSection>
        </div>
      </SheetContent>
    </Sheet>
  );
}
