import { buildSupportPlanExampleLineAt, supportExampleStepsAt } from '@/lib/supportPlanExample';

/**
 * "How it works — example" block, shared by the public support page and the
 * in-app Support Plan sheet so the worked example and the for-this-plan line
 * can never drift apart between the two surfaces.
 *
 * `rate` is the monthly Returns rate the figures are priced at (e.g. 15), from the caller: the
 * public new-partner rate (usePartnerReturnPolicy().newContractRate) on the public page, the
 * signed-in partner's own rate (useOwnNewPortfolioRate) in the app. null (unknown) -> the steps
 * state no Returns figure and the for-this-plan line is hidden.
 */
export function SupportPlanExample({
  fundingAmount,
  rate,
  headingTag = 'h3',
}: {
  fundingAmount: number;
  rate: number | null;
  headingTag?: 'h2' | 'h3';
}) {
  const line = buildSupportPlanExampleLineAt(fundingAmount, rate);
  const steps = supportExampleStepsAt(rate);
  const Heading = headingTag;

  return (
    <div className="space-y-3">
      <Heading className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        How it works — example
      </Heading>
      <ol className="space-y-2">
        {steps.map((text, i) => (
          <li key={text} className="flex items-start gap-3 rounded-2xl bg-muted/40 p-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
              {i + 1}
            </span>
            <span className="min-w-0 text-sm leading-relaxed sm:text-base">{text}</span>
          </li>
        ))}
      </ol>
      {line ? (
        <p className="rounded-2xl border border-primary/25 bg-primary/5 p-3 text-sm font-medium leading-relaxed">
          <span className="text-muted-foreground">For this plan: </span>
          {line}
        </p>
      ) : null}
    </div>
  );
}
