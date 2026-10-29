import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Calendar,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Lightbulb,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import {
  canManageZoeIdeas,
  fetchZoeWeeklyLookAtSummary,
  type ZoeWeeklyLookAtSummary,
} from '@/lib/zoe';

export interface ZoeWeeklyLookAtCardProps {
  roles?: readonly string[];
  summary?: ZoeWeeklyLookAtSummary | null;
  onFetchSummary?: () => Promise<ZoeWeeklyLookAtSummary | null>;
  defaultExpanded?: boolean;
}

/**
 * Monday "What to look at this week" card for managers, the COO, and the CEO in My Space.
 *
 * Rules:
 *   - Shows the top 5 operational issues with evidence, official sources, and links to the screens.
 *   - Strictly in-app only (`in_app_only: true`); never sent outside the app.
 *   - Mobile-first (360px), text-xs+, 44px tap targets, semantic theme tokens, no emojis.
 */
export const ZoeWeeklyLookAtCard: React.FC<ZoeWeeklyLookAtCardProps> = ({
  roles = [],
  summary: propSummary,
  onFetchSummary = () => fetchZoeWeeklyLookAtSummary(),
  defaultExpanded = true,
}) => {
  const isEligibleRole = canManageZoeIdeas(roles);
  const [expanded, setExpanded] = useState(defaultExpanded);

  const { data: queriedSummary, isLoading } = useQuery({
    queryKey: ['zoe-weekly-look-at-summary'],
    staleTime: 5 * 60 * 1000,
    enabled: isEligibleRole && propSummary === undefined,
    queryFn: onFetchSummary,
  });

  if (!isEligibleRole) return null;

  const activeSummary = propSummary !== undefined ? propSummary : queriedSummary;

  if (isLoading && !activeSummary) {
    return (
      <section
        data-testid="zoe-weekly-look-at-loading"
        aria-label="What to look at this week"
        className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground shadow-sm"
      >
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
        <span>Loading Monday What to look at this week summary...</span>
      </section>
    );
  }

  if (!activeSummary || activeSummary.issues.length === 0) return null;

  return (
    <section
      data-testid="zoe-weekly-look-at-card"
      aria-labelledby="zoe-weekly-look-at-heading"
      className="rounded-xl border border-primary/25 bg-card p-3.5 text-card-foreground shadow-sm sm:p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2.5 border-b border-border/70 pb-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Calendar className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="zoe-weekly-look-at-heading"
                className="text-sm font-semibold text-foreground sm:text-base"
              >
                What to look at this week
              </h2>
              <span className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span>In-app only</span>
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Monday priority brief for Managers, COO, and CEO · Week of{' '}
              <span className="font-mono">{activeSummary.week_start || activeSummary.as_of}</span> ·
              Top {activeSummary.issues.length} evidence-backed focus areas
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/me/ideas"
            data-testid="zoe-weekly-ideas-link"
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Lightbulb className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            <span>
              Ideas for Welile
              {activeSummary.new_ideas_count > 0 ? ` (${activeSummary.new_ideas_count} new)` : ''}
            </span>
          </Link>

          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            data-testid="zoe-weekly-look-at-toggle"
            className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>{expanded ? 'Collapse' : 'Show top 5'}</span>
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {expanded && (
        <>
          <ol
            data-testid="zoe-weekly-look-at-list"
            className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3"
          >
            {activeSummary.issues.slice(0, 5).map((issue) => (
              <li
                key={`${issue.rank}-${issue.category}`}
                data-testid={`zoe-weekly-issue-${issue.rank}`}
                className="flex flex-col justify-between gap-2.5 rounded-lg border border-border/80 bg-muted/25 p-3 text-xs"
              >
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 font-semibold text-primary">
                      Priority #{issue.rank}
                    </span>
                    {issue.metric_label && (
                      <span className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-xs font-semibold text-foreground">
                        {issue.metric_label}
                      </span>
                    )}
                  </div>

                  <h3 className="font-semibold text-foreground leading-snug">{issue.title}</h3>
                  <p className="leading-relaxed text-muted-foreground">{issue.evidence}</p>
                </div>

                <div className="space-y-2 border-t border-border/60 pt-2">
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    Source: {issue.source}
                  </p>
                  <Link
                    to={issue.screen_path}
                    data-testid={`zoe-weekly-issue-link-${issue.rank}`}
                    className="inline-flex min-h-[44px] w-full items-center justify-between gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span>{issue.screen_label}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  </Link>
                </div>
              </li>
            ))}
          </ol>

          {activeSummary.anomaly_notes && activeSummary.anomaly_notes.length > 0 && (
            <div
              data-testid="zoe-weekly-anomaly-notes"
              className="mt-3 rounded-lg border border-border/80 bg-muted/20 p-3 text-xs"
            >
              <h3 className="font-semibold text-foreground">
                4-week anomaly notes (proactive comparisons)
              </h3>
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                {activeSummary.anomaly_notes.slice(0, 4).map((note, idx) => (
                  <li
                    key={`${note.category}-${idx}`}
                    data-testid={`zoe-weekly-anomaly-${idx}`}
                    className="rounded-md border border-border/70 bg-background p-2.5"
                  >
                    <p className="font-medium text-foreground">{note.title}</p>
                    <p className="mt-0.5 text-muted-foreground">{note.summary}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      Source: {note.source_function}
                      {note.period_label ? ` · ${note.period_label}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(Boolean(activeSummary.unanswered_questions?.length) ||
            Boolean(activeSummary.feedback_summary)) && (
            <div
              data-testid="zoe-weekly-unanswered-section"
              className="mt-3 rounded-lg border border-border/80 bg-muted/20 p-3 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-foreground">
                    Questions Zoe could not answer this week (redacted: question, role, outcome only)
                  </h3>
                  <p className="text-muted-foreground">
                    Used by managers to prioritize new certified lookups or glossary notes. Never shows answer text or figures.
                  </p>
                </div>
                {activeSummary.feedback_summary && (
                  <div
                    data-testid="zoe-weekly-feedback-counts"
                    className="flex flex-wrap items-center gap-1.5 font-mono text-xs"
                  >
                    <span className="rounded border border-border bg-background px-2 py-0.5 text-foreground">
                      Helpful: {activeSummary.feedback_summary.thumbs_up_count}
                    </span>
                    <span className="rounded border border-border bg-background px-2 py-0.5 text-foreground">
                      Not helpful: {activeSummary.feedback_summary.thumbs_down_count}
                    </span>
                    <span className="rounded border border-border bg-background px-2 py-0.5 text-foreground">
                      Reported problems: {activeSummary.feedback_summary.problem_reports_count}
                    </span>
                  </div>
                )}
              </div>

              {activeSummary.unanswered_questions &&
              activeSummary.unanswered_questions.length > 0 ? (
                <div className="mt-2.5 overflow-x-auto rounded-md border border-border bg-background">
                  <table
                    data-testid="zoe-weekly-unanswered-table"
                    className="w-full border-collapse text-left text-xs"
                  >
                    <thead>
                      <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                        <th className="px-2.5 py-2 font-semibold">Question</th>
                        <th className="px-2.5 py-2 font-semibold">Role</th>
                        <th className="px-2.5 py-2 font-semibold">Outcome</th>
                        <th className="px-2.5 py-2 text-right font-semibold">Count</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {activeSummary.unanswered_questions.slice(0, 10).map((item, idx) => (
                        <tr
                          key={`${item.question}-${idx}`}
                          data-testid={`zoe-weekly-unanswered-row-${idx}`}
                        >
                          <td className="px-2.5 py-2 text-foreground">{item.question}</td>
                          <td className="px-2.5 py-2 font-mono text-muted-foreground">
                            {item.role}
                          </td>
                          <td className="px-2.5 py-2 font-mono text-muted-foreground">
                            {item.outcome}
                          </td>
                          <td className="px-2.5 py-2 text-right font-mono text-foreground">
                            {item.ask_count}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p
                  data-testid="zoe-weekly-unanswered-empty"
                  className="mt-2 text-muted-foreground"
                >
                  No unanswered questions recorded in the last 7 days.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
};

export default ZoeWeeklyLookAtCard;
