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
