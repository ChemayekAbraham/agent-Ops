import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  RefreshCw,
  Sunrise,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  fetchZoeMorningBrief,
  updateZoeMorningBriefPrefs,
  type ConfirmZoeActionResult,
  type ZoeMorningBriefPayload,
} from '@/lib/zoe';

export const MAX_MORNING_BRIEF_DISPLAY_ITEMS = 3;

export interface ZoeMorningBriefCardProps {
  brief: ZoeMorningBriefPayload | null;
  onUpdatePrefs?: (input: {
    enabled: boolean;
    brief_time?: string;
    dismiss_today?: boolean;
  }) => Promise<ConfirmZoeActionResult>;
  onRefreshBrief?: (force?: boolean) => Promise<ZoeMorningBriefPayload | null>;
}

/**
 * Optional 07:30 Kampala Morning Brief ("What changed") card shown inside Zoe.
 *
 * Rules (Prompt 4 Deliverable 4):
 *   - Opt-in per person (`staff_assistant_preferences.morning_brief_enabled`), off by default.
 *   - Two or three lines per role from the existing read-only reports, comparing today with the 4-week average.
 *   - Every item includes its source, a mute switch, and a link to the screen.
 *   - Capped strictly at 3 items (`MAX_MORNING_BRIEF_DISPLAY_ITEMS = 3`).
 *   - In-app only: no outbound email or SMS from this feature.
 */
export const ZoeMorningBriefCard: React.FC<ZoeMorningBriefCardProps> = ({
  brief: initialBrief,
  onUpdatePrefs = updateZoeMorningBriefPrefs,
  onRefreshBrief = fetchZoeMorningBrief,
}) => {
  const [brief, setBrief] = useState<ZoeMorningBriefPayload | null>(initialBrief);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDismissedToday, setIsDismissedToday] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  React.useEffect(() => {
    setBrief(initialBrief);
  }, [initialBrief]);

  if (!brief || isDismissedToday) return null;

  const briefTime = brief.scheduled_time_kampala || brief.brief_time_kampala || '07:30';
  const cappedSections = (brief.sections ?? []).slice(0, MAX_MORNING_BRIEF_DISPLAY_ITEMS);

  const handleToggleEnabled = async (nextEnabled: boolean) => {
    if (isUpdating) return;
    setIsUpdating(true);
    setErrorMessage(null);
    try {
      const res = await onUpdatePrefs({
        enabled: nextEnabled,
        brief_time: briefTime,
      });
      if (!res.ok) {
        setErrorMessage(res.error || 'Could not update Morning Brief preference.');
        return;
      }
      if (nextEnabled) {
        const refreshed = await onRefreshBrief(true);
        if (refreshed) {
          setBrief(refreshed);
        } else {
          setBrief({ ...brief, enabled: true, should_display_now: true, should_display: true });
        }
      } else {
        setBrief({
          ...brief,
          enabled: false,
          should_display_now: false,
          should_display: false,
          sections: [],
        });
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not update preference.');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleRefresh = async () => {
    if (isUpdating) return;
    setIsUpdating(true);
    setErrorMessage(null);
    try {
      const refreshed = await onRefreshBrief(true);
      if (refreshed) {
        setBrief(refreshed);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not refresh Morning Brief.');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDismissToday = async () => {
    setIsDismissedToday(true);
    try {
      await onUpdatePrefs({
        enabled: brief.enabled,
        brief_time: briefTime,
        dismiss_today: true,
      });
    } catch {
      /* non-blocking */
    }
  };

  return (
    <div
      data-testid="zoe-morning-brief-card"
      data-in-app-only="true"
      className="rounded-xl border border-primary/25 bg-primary/5 p-3.5 text-card-foreground shadow-sm sm:p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Sunrise className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-xs font-semibold text-foreground sm:text-sm">
              07:30 Kampala Morning Brief · {brief.enabled ? 'Enabled' : 'Off by default'}
            </h3>
            <p className="text-xs text-muted-foreground">
              {brief.headline ||
                'What changed today vs your 4-week average (in-app only · no email or SMS)'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={isUpdating}
            aria-pressed={brief.enabled}
            data-testid="zoe-morning-brief-toggle"
            onClick={() => void handleToggleEnabled(!brief.enabled)}
            className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
              brief.enabled
                ? 'border-border bg-background text-foreground hover:bg-muted'
                : 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
            } disabled:opacity-50`}
          >
            {isUpdating && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            <span>{brief.enabled ? 'Turn off brief' : 'Turn on 07:30 brief'}</span>
          </button>

          {brief.enabled && (
            <button
              type="button"
              disabled={isUpdating}
              data-testid="zoe-morning-brief-refresh"
              onClick={() => void handleRefresh()}
              className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Refresh</span>
            </button>
          )}

          {brief.enabled && cappedSections.length > 0 && (
            <button
              type="button"
              disabled={isUpdating}
              data-testid="zoe-morning-brief-dismiss"
              onClick={() => void handleDismissToday()}
              aria-label="Dismiss today's morning brief"
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          data-testid="zoe-morning-brief-error"
          className="mt-2.5 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      )}

      {brief.enabled && cappedSections.length > 0 && (
        <div
          data-testid="zoe-morning-brief-sections"
          className="mt-3 grid gap-2 sm:grid-cols-2"
        >
          {cappedSections.map((section) => {
            const key = section.id || section.tool;
            const screenPath =
              typeof section.screen_path === 'string' && section.screen_path.startsWith('/')
                ? section.screen_path
                : '/me';
            const hasPctChange = typeof section.pct_change === 'number' && Number.isFinite(section.pct_change);
            return (
              <div
                key={key}
                data-testid={`zoe-brief-section-${section.tool}`}
                className="rounded-lg border border-border bg-card p-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <p className="font-semibold text-foreground">{section.title}</p>
                  {hasPctChange && (
                    <span
                      data-testid={`zoe-brief-delta-${section.tool}`}
                      className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground"
                    >
                      {section.direction === 'up' ? (
                        <TrendingUp className="h-3 w-3 text-emerald-600" aria-hidden="true" />
                      ) : section.direction === 'down' ? (
                        <TrendingDown className="h-3 w-3 text-amber-600" aria-hidden="true" />
                      ) : null}
                      <span>
                        {section.pct_change! > 0 ? `+${section.pct_change}%` : `${section.pct_change}%`} vs 4-wk avg
                      </span>
                    </span>
                  )}
                </div>
                <p className="mt-1 leading-relaxed text-foreground/90">{section.summary}</p>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-1.5">
                  <p
                    data-testid={`zoe-brief-source-${section.tool}`}
                    className="text-muted-foreground"
                  >
                    Source: {section.source} · {section.period}
                  </p>
                  <Link
                    to={screenPath}
                    data-testid={`zoe-brief-link-${section.tool}`}
                    className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
                  >
                    <span>Open screen</span>
                    <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ZoeMorningBriefCard;
