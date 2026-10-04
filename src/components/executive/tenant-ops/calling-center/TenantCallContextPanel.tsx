/**
 * Tenant context for a live Calling Center call.
 *
 * Presentation only. Every figure comes from `useCcSubjectSnapshot` — the exact
 * hook (and therefore the exact source of truth) behind the Calling Hub's
 * Reveal Number panel — and the layout reuses the Hub's own drawer building
 * blocks, so the two surfaces read identically. No new data source, no new
 * arithmetic, no workflow logic.
 */
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { UserRound } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useCcSubjectSnapshot } from '@/hooks/useCcSubjectSnapshot';
import type { CcCallingHub, CcRow } from '@/hooks/useCcCallingHub';
import { StatGrid, StatTile, DrawerSection, ContactCard, PersonHeader } from '@/components/ops/calling/CallDrawerUi';

const titleCase = (v?: string | null) => (v ? String(v).replace(/_/g, ' ') : null);

/** yyyy-MM-dd rendered as a short, unambiguous day for calling officers. */
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
};


export function TenantCallContextPanel({
  hub,
  subjectId,
  fallbackName,
  district,
  linkedAgent,
  phone,
  row,
}: {
  hub: CcCallingHub;
  subjectId: string | null;
  fallbackName: string;
  district?: string | null;
  linkedAgent?: string | null;
  phone?: string | null;
  row?: CcRow | null;
}) {
  const snapshotQ = useCcSubjectSnapshot('tenant', subjectId);
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

  const followups = hub.followups.filter(
    (f: any) => f.subject_id === subjectId || f.tenant_id === subjectId,
  );

  return (
    <div className="space-y-3">
      <PersonHeader
        name={snap?.tenant_name || fallbackName}
        subtitle={
          [district, titleCase(snap?.status)].filter(Boolean).join(' · ') || undefined
        }
        badges={
          <>
            {snap?.is_weekly && (
              <Badge variant="outline" className="border-primary/30 bg-primary/10 text-[10px] text-primary">
                Weekly payments
              </Badge>
            )}
            {risk && (
              <Badge variant="outline" className={`text-[10px] ${riskTone}`}>
                {snap?.is_weekly ? `${snap.days_overdue}d overdue` : `${snap?.missed_days}d missed`}
              </Badge>
            )}
            {snap && (
              <Badge variant="outline" className="text-[10px]">
                {snap.repayment_pct}% repaid
              </Badge>
            )}
            {row?.state && (
              <Badge variant="outline" className="text-[10px]">
                {titleCase(row.state)}
              </Badge>
            )}
          </>
        }
      />

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
          <>
            {snap.is_weekly && (
              <p className="mb-2 rounded-xl border border-primary/25 bg-primary/5 px-2.5 py-2 text-[11px] leading-relaxed">
                <span className="font-bold">Weekly-payment tenant.</span> Expected{' '}
                <span className="font-semibold tabular-nums">{formatUGX(snap.period_amount)}</span> every week.{' '}
                {snap.current_due_settled ? (
                  <span className="font-semibold text-emerald-600">Rent Plan fully repaid — nothing due.</span>
                ) : (
                  <>
                    Payment due{' '}
                    <span className="font-semibold">{snap.current_due_date ? dayLabel(snap.current_due_date) : '—'}</span>{' '}
                    ·{' '}
                    {snap.current_due_paid > 0 ? (
                      <span className="font-semibold text-amber-600">
                        part paid ({formatUGX(snap.current_due_paid)} of {formatUGX(snap.period_amount)})
                      </span>
                    ) : (
                      <span className="font-semibold text-destructive">not paid</span>
                    )}{' '}
                    ·{' '}
                    {snap.days_overdue > 0 ? (
                      <span className="font-semibold text-destructive">
                        {snap.days_overdue} day{snap.days_overdue === 1 ? '' : 's'} overdue
                      </span>
                    ) : (
                      <span className="font-semibold text-emerald-600">not yet overdue</span>
                    )}
                    {snap.next_due_date && (
                      <span className="text-muted-foreground"> · next payment {dayLabel(snap.next_due_date)}</span>
                    )}
                  </>
                )}
              </p>
            )}
            <StatGrid>
              {snap.is_weekly ? (
                <>
                  <StatTile label="Days overdue" value={`${snap.days_overdue}d`} tone={missedTone} />
                  <StatTile label="Weekly payment" value={formatUGX(snap.period_amount)} />
                  <StatTile
                    label="Payment due"
                    value={snap.current_due_date ? dayLabel(snap.current_due_date) : '—'}
                  />
                  <StatTile
                    label="This payment"
                    value={
                      snap.current_due_settled
                        ? 'Cleared'
                        : snap.current_due_paid > 0
                          ? `Part paid ${formatUGX(snap.current_due_paid)}`
                          : 'Not paid'
                    }
                    tone={snap.current_due_settled ? 'text-emerald-600' : 'text-destructive'}
                  />
                  <StatTile label="Weeks unpaid" value={`${snap.periods_overdue}`} />
                  <StatTile label="Overdue amount" value={formatUGX(snap.missed_amount)} tone="text-destructive" />
                </>
              ) : (
                <>
                  <StatTile label="Days missed" value={`${snap.missed_days}d`} tone={missedTone} />
                  <StatTile label="Missed amount" value={formatUGX(snap.missed_amount)} tone="text-destructive" />
                  <StatTile label="Daily payment" value={formatUGX(snap.daily_repayment)} />
                </>
              )}
              <StatTile label="Total owed" value={formatUGX(snap.outstanding_balance)} />
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
          </>
        )}
      </DrawerSection>


      <DrawerSection title="Contacts" icon={UserRound} className="mt-1">
        <div className="space-y-2">
          <ContactCard
            role="Tenant"
            name={snap?.tenant_name || fallbackName}
            phone={phone || snap?.tenant_phone || null}
            meta={phone || snap?.tenant_phone ? undefined : 'Number not revealed'}
          />
          <ContactCard
            role="Responsible agent"
            name={snap?.agent_name || linkedAgent || '—'}
            phone={snap?.agent_phone || null}
            meta={snap && snap.agent_id ? `Agent wallet ${formatUGX(snap.agent_wallet)}` : 'No agent linked'}
          />
        </div>
      </DrawerSection>

      {(row?.feedback_category || row?.ticket_ref || row?.park_reason || followups.length > 0) && (
        <DrawerSection title="Call status, comments and follow-ups" className="mt-1">
          <div className="space-y-2 rounded-xl border border-border/60 bg-muted/40 p-2.5 text-[11px]">
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {row?.feedback_category && (
                <p>
                  <span className="text-muted-foreground">Last feedback: </span>
                  <span className="font-semibold">{row.feedback_category}</span>
                </p>
              )}
              {row?.ticket_ref && (
                <p>
                  <span className="text-muted-foreground">Ticket: </span>
                  <span className="font-semibold">
                    {row.ticket_ref}
                    {row.ticket_status ? ` · ${titleCase(row.ticket_status)}` : ''}
                  </span>
                </p>
              )}
              {row?.park_reason && (
                <p>
                  <span className="text-muted-foreground">Park reason: </span>
                  <span className="font-semibold">{titleCase(row.park_reason)}</span>
                </p>
              )}
              {row?.last_attempt_at && (
                <p>
                  <span className="text-muted-foreground">Last attempt: </span>
                  <span className="font-semibold">{new Date(row.last_attempt_at).toLocaleString()}</span>
                </p>
              )}
            </div>
            {followups.length > 0 && (
              <ul className="space-y-1 border-t border-border/60 pt-1.5">
                {followups.map((f: any) => (
                  <li key={f.id}>
                    <span className="font-semibold">{f.reason}</span>
                    <span className="text-muted-foreground">
                      {f.due_at ? ` · due ${new Date(f.due_at).toLocaleString()}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DrawerSection>
      )}
    </div>
  );
}
