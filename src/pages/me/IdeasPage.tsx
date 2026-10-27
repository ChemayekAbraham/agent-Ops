import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Lightbulb,
  Loader2,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { useAuth } from '@/hooks/useAuth';
import { useZoeAccess } from '@/components/zoe/useZoeAssistant';
import {
  canManageZoeIdeas,
  fetchZoeIdeas,
  updateZoeIdeaStatus,
  type ConfirmZoeActionResult,
  type ZoeIdeaCategory,
  type ZoeIdeaRecord,
  type ZoeIdeasListResponse,
  type ZoeIdeaStatus,
} from '@/lib/zoe';

export interface IdeasPageProps {
  initialData?: ZoeIdeasListResponse | null;
  onFetchIdeas?: (status: ZoeIdeaStatus | 'all' | null) => Promise<ZoeIdeasListResponse>;
  onUpdateStatus?: (input: {
    idea_id: string;
    status: ZoeIdeaStatus;
    status_note?: string | null;
  }) => Promise<ConfirmZoeActionResult>;
  forceAccessGranted?: boolean;
  overrideRoles?: readonly string[];
}

const STATUS_LABELS: Record<ZoeIdeaStatus, string> = {
  new: 'New',
  being_looked_at: 'Being looked at',
  done: 'Done',
  not_now: 'Not now',
};

const CATEGORY_LABELS: Record<ZoeIdeaCategory, string> = {
  desk_wait: 'Desk Wait Times',
  collections: 'Collection Coverage',
  calling: 'Calling Center',
  payouts: 'Payout Delays',
  zoe_quality: 'Zoe Feedback',
  general: 'General Improvement',
};

function formatIdeaDate(iso: string): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().slice(0, 10);
}

const IdeasPage: React.FC<IdeasPageProps> = ({
  initialData = null,
  onFetchIdeas = (status) => fetchZoeIdeas(status),
  onUpdateStatus = updateZoeIdeaStatus,
  forceAccessGranted,
  overrideRoles,
}) => {
  const { roles: authRoles } = useAuth();
  const roles = overrideRoles ?? authRoles;
  const { data: zoeAccess, isLoading: accessLoading } = useZoeAccess();
  const hasAccess = forceAccessGranted ?? zoeAccess === true;

  const [statusFilter, setStatusFilter] = useState<ZoeIdeaStatus | 'all'>('all');
  const [data, setData] = useState<ZoeIdeasListResponse>(
    initialData ?? {
      can_manage_ideas: canManageZoeIdeas(roles),
      counts: { total: 0, new: 0, being_looked_at: 0, done: 0, not_now: 0 },
      ideas: [],
    },
  );
  const [isLoading, setIsLoading] = useState(!initialData);
  const [updatingIdeaId, setUpdatingIdeaId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const loadIdeas = useCallback(
    async (filter: ZoeIdeaStatus | 'all') => {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const res = await onFetchIdeas(filter === 'all' ? null : filter);
        setData(res);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Could not load saved ideas.');
      } finally {
        setIsLoading(false);
      }
    },
    [onFetchIdeas],
  );

  useEffect(() => {
    if (initialData && statusFilter === 'all') {
      setData(initialData);
      setIsLoading(false);
      return;
    }
    if (hasAccess) {
      void loadIdeas(statusFilter);
    }
  }, [hasAccess, initialData, loadIdeas, statusFilter]);

  const canManage = data.can_manage_ideas || canManageZoeIdeas(roles);

  const handleStatusChange = async (idea: ZoeIdeaRecord, nextStatus: ZoeIdeaStatus) => {
    if (!canManage || updatingIdeaId) return;
    setUpdatingIdeaId(idea.id);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const res = await onUpdateStatus({
        idea_id: idea.id,
        status: nextStatus,
      });
      if (!res.ok) {
        setErrorMessage(res.error || 'Could not update idea status.');
      } else {
        setData((prev) => ({
          ...prev,
          ideas: prev.ideas.map((item) =>
            item.id === idea.id ? { ...item, status: nextStatus } : item,
          ),
        }));
        setSuccessMessage(
          `Updated "${idea.title}" to "${STATUS_LABELS[nextStatus]}".`,
        );
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not update idea status.');
    } finally {
      setUpdatingIdeaId(null);
    }
  };

  const visibleIdeas =
    statusFilter === 'all'
      ? data.ideas
      : data.ideas.filter((item) => item.status === statusFilter);

  return (
    <PersonalLayout title="Ideas for Welile">
      {accessLoading && forceAccessGranted === undefined ? (
        <div
          data-testid="zoe-ideas-loading-access"
          className="flex min-h-[200px] items-center justify-center gap-2 rounded-xl border border-border bg-card p-6 text-xs text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
          <span>Verifying My Space access...</span>
        </div>
      ) : !hasAccess ? (
        <div
          data-testid="zoe-ideas-access-denied"
          className="space-y-3 rounded-xl border border-border bg-card p-5 text-card-foreground"
        >
          <div className="flex items-center gap-2.5 text-sm font-semibold text-foreground">
            <ShieldAlert className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <span>Ideas for Welile is available only to enabled Welile staff roles</span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Your account does not currently have Zoe staff assistant access enabled in My Space.
          </p>
          <Link
            to="/me"
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-background px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span>Back to My Space</span>
          </Link>
        </div>
      ) : (
        <div data-testid="zoe-ideas-page" className="space-y-4">
          {/* Header summary banner */}
          <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Lightbulb className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold text-foreground sm:text-base">
                    Evidence-Based Improvement Ideas
                  </h2>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Suggestions saved from Zoe with their official report figures, source, person, and
                    date. Visible to managers, the COO, and the CEO. Changing an idea&apos;s status is a
                    manager screen action — Zoe never changes any setting or business record.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Link
                  to="/me/zoe"
                  data-testid="zoe-ideas-ask-zoe-link"
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <MessageSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Ask Zoe for ideas</span>
                </Link>

                <button
                  type="button"
                  onClick={() => void loadIdeas(statusFilter)}
                  disabled={isLoading}
                  data-testid="zoe-ideas-refresh-button"
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Refresh</span>
                </button>
              </div>
            </div>

            {/* Status filter pills */}
            <div
              role="tablist"
              aria-label="Filter ideas by status"
              className="mt-3.5 flex flex-wrap gap-1.5 border-t border-border/70 pt-3"
            >
              {(
                [
                  { id: 'all', label: 'All ideas', count: data.counts.total },
                  { id: 'new', label: 'New', count: data.counts.new },
                  {
                    id: 'being_looked_at',
                    label: 'Being looked at',
                    count: data.counts.being_looked_at,
                  },
                  { id: 'done', label: 'Done', count: data.counts.done },
                  { id: 'not_now', label: 'Not now', count: data.counts.not_now },
                ] as const
              ).map((tab) => {
                const active = statusFilter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid={`zoe-ideas-filter-${tab.id}`}
                    onClick={() => setStatusFilter(tab.id)}
                    className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background text-foreground hover:bg-muted'
                    }`}
                  >
                    <span>{tab.label}</span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-xs ${
                        active
                          ? 'bg-primary-foreground/20 text-primary-foreground'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {tab.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {errorMessage && (
            <div
              role="alert"
              data-testid="zoe-ideas-error"
              className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
            >
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{errorMessage}</span>
            </div>
          )}

          {successMessage && (
            <div
              role="status"
              data-testid="zoe-ideas-success"
              className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3 text-xs text-foreground"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span>{successMessage}</span>
            </div>
          )}

          {isLoading ? (
            <div
              data-testid="zoe-ideas-loading"
              className="flex min-h-[160px] items-center justify-center gap-2 rounded-xl border border-border bg-card p-6 text-xs text-muted-foreground"
            >
              <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
              <span>Loading saved ideas...</span>
            </div>
          ) : visibleIdeas.length === 0 ? (
            <div
              data-testid="zoe-ideas-empty"
              className="rounded-xl border border-border bg-card p-6 text-center text-xs text-muted-foreground"
            >
              <p className="font-semibold text-foreground">No saved ideas match this filter yet.</p>
              <p className="mt-1">
                Ask Zoe &quot;How could we improve desk wait times?&quot; or &quot;Which areas dropped in
                collection coverage?&quot; and click Save Idea on a suggestion you like.
              </p>
            </div>
          ) : (
            <div data-testid="zoe-ideas-list" className="space-y-3">
              {visibleIdeas.map((idea) => {
                const figureEntries = Object.entries(idea.figures ?? {}).slice(0, 6);
                return (
                  <article
                    key={idea.id}
                    data-testid={`zoe-idea-card-${idea.id}`}
                    className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2.5 border-b border-border/70 pb-3">
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                            {CATEGORY_LABELS[idea.category] ?? 'Improvement Idea'}
                          </span>
                          <span
                            data-testid={`zoe-idea-status-badge-${idea.id}`}
                            className="rounded-md border border-border bg-muted/60 px-2 py-0.5 text-xs font-semibold text-foreground"
                          >
                            {STATUS_LABELS[idea.status] ?? idea.status}
                          </span>
                        </div>
                        <h3 className="text-sm font-semibold text-foreground sm:text-base">
                          {idea.title}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          Saved by <span className="font-medium text-foreground">{idea.created_by_name}</span>{' '}
                          on <span className="font-mono">{formatIdeaDate(idea.created_at)}</span>
                        </p>
                      </div>

                      {/* Manager-only status update control (ordinary screen action) */}
                      {canManage ? (
                        <div className="flex items-center gap-2">
                          <label
                            htmlFor={`zoe-idea-status-select-${idea.id}`}
                            className="text-xs font-medium text-muted-foreground"
                          >
                            Status
                          </label>
                          <select
                            id={`zoe-idea-status-select-${idea.id}`}
                            data-testid={`zoe-idea-status-select-${idea.id}`}
                            value={idea.status}
                            disabled={updatingIdeaId === idea.id}
                            onChange={(e) =>
                              void handleStatusChange(idea, e.target.value as ZoeIdeaStatus)
                            }
                            className="min-h-[44px] rounded-lg border border-input bg-background px-3 py-1.5 text-xs font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                          >
                            <option value="new">New</option>
                            <option value="being_looked_at">Being looked at</option>
                            <option value="done">Done</option>
                            <option value="not_now">Not now</option>
                          </select>
                        </div>
                      ) : (
                        <span
                          data-testid={`zoe-idea-status-readonly-${idea.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          Status updated by managers only
                        </span>
                      )}
                    </div>

                    <div className="mt-3 space-y-2.5 text-xs">
                      <div>
                        <p className="font-semibold text-foreground">Suggested Improvement</p>
                        <p className="mt-0.5 whitespace-pre-wrap leading-relaxed text-foreground">
                          {idea.suggestion}
                        </p>
                      </div>

                      <div className="rounded-lg border border-border/80 bg-muted/30 p-3">
                        <p className="font-semibold text-foreground">Evidence & Official Figures</p>
                        <p className="mt-0.5 whitespace-pre-wrap leading-relaxed text-muted-foreground">
                          {idea.evidence_summary}
                        </p>
                        {figureEntries.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {figureEntries.map(([key, val]) => (
                              <span
                                key={key}
                                className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-xs text-foreground"
                              >
                                {key}: {String(val)}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
                        <span className="font-mono">
                          Source: {idea.source_label}
                          {idea.period_label ? ` · ${idea.period_label}` : ''}
                        </span>
                        {idea.screen_path && (
                          <Link
                            to={idea.screen_path}
                            data-testid={`zoe-idea-screen-link-${idea.id}`}
                            className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-muted"
                          >
                            <span>Open screen</span>
                            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          </Link>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </PersonalLayout>
  );
};

export default IdeasPage;
