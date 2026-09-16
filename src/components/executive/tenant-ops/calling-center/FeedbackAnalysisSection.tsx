/**
 * Feedback Analysis & Insights — read-only presentation of patterns derived from
 * the officer comments already loaded for the selected period/filters.
 *
 * Original comments are untouched: they continue to appear, verbatim, in the
 * detailed calls table below this section.
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { AlertTriangle, Info, Lightbulb, MessageSquareText, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { FeedbackAnalysis } from '@/lib/tenantCallFeedbackAnalysis';

const toneClass = (tone: string) =>
  tone === 'concern'
    ? 'bg-destructive/10 text-destructive border-destructive/30'
    : tone === 'progress'
      ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
      : 'bg-muted text-muted-foreground border-border';

const barClass = (tone: string) =>
  tone === 'concern' ? '[&>div]:bg-destructive' : tone === 'progress' ? '[&>div]:bg-emerald-500' : '[&>div]:bg-primary';

export function FeedbackAnalysisSection({
  analysis,
  periodLabel,
}: {
  analysis: FeedbackAnalysis;
  periodLabel: string;
}) {
  const tiles = [
    { label: 'Comments analysed', value: analysis.commented, tone: 'context' as const, icon: MessageSquareText },
    { label: 'Concern signals', value: analysis.sentiment.negative, tone: 'concern' as const, icon: ThumbsDown },
    { label: 'Positive signals', value: analysis.sentiment.positive, tone: 'progress' as const, icon: ThumbsUp },
    { label: 'Open / unresolved', value: analysis.unresolved.openAttempts + analysis.unresolved.followUpsPending, tone: 'concern' as const, icon: AlertTriangle },
  ];

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-3">
        <CardTitle className="flex items-center gap-2 text-xs font-bold">
          <Sparkles className="h-4 w-4 text-primary" />
          Feedback Analysis &amp; Insights
        </CardTitle>
        <span className="text-[10px] text-muted-foreground">{periodLabel}</span>
      </CardHeader>
      <CardContent className="space-y-3 p-3">
        {analysis.insufficient ? (
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Not enough officer comments in this period to read reliable patterns
              ({analysis.commented} comment{analysis.commented === 1 ? '' : 's'} on {analysis.totalCalls} call
              {analysis.totalCalls === 1 ? '' : 's'}). Widen the date range or record more feedback.
            </span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {tiles.map((t) => (
                <div key={t.label} className={`rounded-xl border p-2.5 ${toneClass(t.tone)}`}>
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide">
                    <t.icon className="h-3.5 w-3.5" />
                    {t.label}
                  </div>
                  <div className="mt-1 text-lg font-bold tabular-nums">{t.value.toLocaleString()}</div>
                </div>
              ))}
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-border bg-card p-3">
                <h4 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                  Recurring themes in the comments
                </h4>
                <div className="mt-2 space-y-2">
                  {analysis.themes.slice(0, 10).map((t) => (
                    <div key={t.key}>
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="font-medium">{t.label}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {t.count} · {t.pct}%
                        </span>
                      </div>
                      <Progress value={t.pct} className={`mt-1 h-1.5 ${barClass(t.tone)}`} />
                      <p className="mt-0.5 text-[10px] text-muted-foreground">{t.hint}</p>
                    </div>
                  ))}
                  {!analysis.themes.length && (
                    <p className="text-xs text-muted-foreground">
                      Comments were recorded but none matched a known pattern.
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <div className="rounded-xl border border-border bg-card p-3">
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    Feedback categories chosen by officers
                  </h4>
                  {analysis.categories.length ? (
                    <table className="mt-2 w-full text-xs">
                      <tbody>
                        {analysis.categories.map((c) => (
                          <tr key={c.label} className="border-b border-border/50 last:border-0">
                            <td className="py-1.5">{c.label}</td>
                            <td className="py-1.5 text-right tabular-nums text-muted-foreground">{c.count}</td>
                            <td className="w-14 py-1.5 text-right tabular-nums text-muted-foreground">{c.pct}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">No categories were tagged in this period.</p>
                  )}
                </div>

                <div className="rounded-xl border border-border bg-card p-3">
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    Unresolved &amp; follow-up load
                  </h4>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-muted/40 p-2">
                      <div className="text-[10px] text-muted-foreground">Open attempts</div>
                      <div className="font-bold tabular-nums">{analysis.unresolved.openAttempts}</div>
                    </div>
                    <div className="rounded-lg bg-muted/40 p-2">
                      <div className="text-[10px] text-muted-foreground">Follow-ups pending</div>
                      <div className="font-bold tabular-nums">{analysis.unresolved.followUpsPending}</div>
                    </div>
                    <div className="rounded-lg bg-muted/40 p-2">
                      <div className="text-[10px] text-muted-foreground">Balance disputes raised</div>
                      <div className="font-bold tabular-nums">{analysis.unresolved.disputesOpen}</div>
                    </div>
                    <div className="rounded-lg bg-muted/40 p-2">
                      <div className="text-[10px] text-muted-foreground">Not reached</div>
                      <div className="font-bold tabular-nums">{analysis.unresolved.unreachable}</div>
                    </div>
                  </div>
                  {analysis.severities.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {analysis.severities.map((s) => (
                        <Badge key={s.label} variant="outline" className="text-[10px] capitalize">
                          {s.label}: {s.count}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
              <h4 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-primary">
                <Lightbulb className="h-3.5 w-3.5" />
                Recommended officer actions / areas for attention
              </h4>
              {analysis.recommendations.length ? (
                <ol className="mt-2 space-y-1.5">
                  {analysis.recommendations.map((r, i) => (
                    <li key={r.title} className="flex gap-2 text-xs">
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-bold text-primary">
                        {i + 1}
                      </span>
                      <span>
                        <span className="font-semibold">{r.title}.</span>{' '}
                        <span className="text-muted-foreground">{r.detail}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  The comments in this period do not point to any specific action.
                </p>
              )}
            </div>

            <p className="text-[10px] text-muted-foreground">
              Patterns are counted from the officer comments in this period only. Percentages are of the{' '}
              {analysis.commented} commented call{analysis.commented === 1 ? '' : 's'}. Original comments are shown
              unchanged in the detailed table below.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
