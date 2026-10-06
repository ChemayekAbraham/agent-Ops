import type { PaymentBehaviorSummary } from '@/hooks/tenantOpsWorkspace/usePaymentBehavior';
import { fmtDay } from './labels';
import { EstimateBadge, ObservedBadge, SectionCard } from './shared';

export function MethodSection({ summary }: { summary: PaymentBehaviorSummary | undefined }) {
  return (
    <div className="space-y-3">
      <SectionCard title="Where the figures come from" description="Every number on this tab is calculated by the database from records already kept; nothing is typed in or re-derived on screen." badge={<ObservedBadge />}>
        <ul className="list-disc space-y-2 pl-5 text-xs leading-relaxed text-muted-foreground marker:text-primary">
          <li><span className="font-semibold text-foreground">Paid by the tenant.</span> A rent receipt written when the tenant paid from their own registered phone and the system applied it to their Rent Plan automatically. These match one-for-one the settled attempts on the Tenant Self-Repayments list.</li>
          <li><span className="font-semibold text-foreground">Paid by an agent.</span> A rent receipt the agent recorded, settled from the agent's own float. A single agent liability settlement is excluded from both.</li>
          <li><span className="font-semibold text-foreground">What is excluded.</span> Reversed receipts, zero amounts and receipts without a Rent Plan. Days are Kampala days.</li>
          <li><span className="font-semibold text-foreground">Billed and covered.</span> The bill is the daily amount pinned for each Rent Plan. Covered is what was paid against it, capped at the bill for each Rent Plan, exactly as on the Collection Shortfall page.</li>
          <li><span className="font-semibold text-foreground">Agent and place.</span> Those of the Rent Plan (its agent, and the tenant's registered location), the same attribution the daily bill uses.</li>
          <li><span className="font-semibold text-foreground">On time or late.</span> The system settles each receipt against the oldest unpaid billed day. A receipt entered on or before that day is on time; after it, late.</li>
        </ul>
      </SectionCard>
      <SectionCard title="What is an estimate" description="Anything that looks forward, compares groups or scores risk is marked and carries its sample size." badge={<EstimateBadge />}>
        <ul className="list-disc space-y-2 pl-5 text-xs leading-relaxed text-muted-foreground marker:text-warning">
          <li><span className="font-semibold text-foreground">Projection.</span> A straight line through the recent complete weeks. It is shown only with four or more weeks and is labelled low confidence until eight weeks fit it well.</li>
          <li><span className="font-semibold text-foreground">Comparison and correlations.</span> Tenants choose how they pay, so a difference between self-payers and agent-only tenants is an association, not proof that one method causes better payment.</li>
          <li><span className="font-semibold text-foreground">Early-warning signs.</span> Plain rules, not a hidden model. The back-test replays them from a week ago and shows what happened next, so you can see which signs actually carry information.</li>
        </ul>
      </SectionCard>
      <SectionCard title="Limits of the data today">
        <ul className="list-disc space-y-2 pl-5 text-xs leading-relaxed text-muted-foreground marker:text-border">
          <li>Self-payments began on <span className="font-semibold text-foreground">{fmtDay(summary?.data_since.first_self_payment_day)}</span>. Before that date every payment was made by an agent, so any period reaching earlier mixes two very different situations.</li>
          <li>Billed-day detail and the daily bill begin on <span className="font-semibold text-foreground">{fmtDay(summary?.data_since.first_billed_day)}</span>. Coverage, on-time and early-warning figures cannot look back further.</li>
          <li>Self-paying tenants are a small share of all tenants, so group comparisons and correlations have wide margins. The tab says so where it matters.</li>
          <li>Agents enter many payments in batches late in the evening, so the hour-of-day pattern for agent-paid receipts reflects when entry happens, not necessarily when the tenant handed over money.</li>
        </ul>
      </SectionCard>
    </div>
  );
}
