import { SUPPORT_EXAMPLE_STEPS, buildSupportPlanExampleLine } from '@/lib/supportPlanExample';

/**
 * "How it works — example" block, shared by the public support page and the
 * in-app Support Plan sheet so the worked example and the for-this-plan line
 * can never drift apart between the two surfaces.
 */
export function SupportPlanExample({
  fundingAmount,
  headingTag = 'h3',
}: {
  fundingAmount: number;
  headingTag?: 'h2' | 'h3';
}) {
  const line = buildSupportPlanExampleLine(fundingAmount);
  const Heading = headingTag;

  return (
    <div className="space-y-3">
      <Heading className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        How it works — example
      </Heading>
      <ol className="space-y-2">
        {SUPPORT_EXAMPLE_STEPS.map((text, i) => (
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
