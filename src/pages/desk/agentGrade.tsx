import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { rpc, readableError } from './reviewApi';
import { gradeTrend } from './boardApi';
import { CALM, FOCUS, LABEL, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';
import { DeskPopover, GradeBadge as KitGradeBadge, gradeStyle } from './ui';

/**
 * The agent grade badge (the kit's GradeBadge) with a week-on-week arrow. A
 * press opens the grade's make-up from `agent_grade_of(p_agent)`.
 */

/** The badge style for a grade; the palette lives in the desk UI kit. */
export function badgeFor(grade: string | null | undefined) {
  return gradeStyle(grade);
}

type GradeOf = {
  grade: string | null;
  score: number | null;
  flags: string[] | null;
  day: string | null;
  components: { collection?: number | null; portfolio?: number | null; float?: number | null; quality?: number | null } | null;
  detail: Record<string, unknown> | null;
  week_ago_grade: string | null;
};

function useGradeOf(agentId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['desk-feed', 'agent-grade', agentId],
    enabled: enabled && !!agentId,
    queryFn: async (): Promise<GradeOf> => {
      const { data, error } = await rpc('agent_grade_of', { p_agent: agentId });
      if (error) throw error;
      return data as GradeOf;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

const COMPONENT_LABEL: Record<string, string> = {
  collection: 'Collection',
  portfolio: 'Portfolio',
  float: 'Float',
  quality: 'Request quality',
};

const plain = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const show = (v: unknown) =>
  v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : typeof v === 'object' ? JSON.stringify(v) : String(v);

function GradeDetail({ agentId }: { agentId: string }) {
  const q = useGradeOf(agentId, true);
  if (q.isLoading) return <Skeleton className="h-24 w-full" />;
  if (q.error) return <p className={`text-xs ${statusText.bad}`}>{readableError(q.error)}</p>;
  const g = q.data;
  if (!g) return <p className="text-xs text-muted-foreground">No grade on record.</p>;
  return (
    <span className="block space-y-2 text-xs">
      <span className="flex items-baseline justify-between gap-2">
        <KitGradeBadge grade={g.grade} />
        <span className="text-foreground">Score {show(g.score)}</span>
      </span>
      <span className={`${LABEL} block`}>
        {g.day ? `Graded ${g.day}` : 'Grading day unknown'}
        {g.week_ago_grade ? ` · a week ago: ${badgeFor(g.week_ago_grade).text}` : ''}
      </span>
      {g.components && (
        <span className="block space-y-0.5">
          {Object.entries(g.components).map(([k, v]) => (
            <span key={k} className="flex justify-between gap-2">
              <span className="text-muted-foreground">{COMPONENT_LABEL[k] ?? plain(k)}</span>
              <span className="tabular-nums text-foreground">{show(v)}</span>
            </span>
          ))}
        </span>
      )}
      {(g.flags ?? []).length > 0 && <span className={`block ${statusText.warn}`}>{(g.flags ?? []).join(' · ')}</span>}
      {g.detail && Object.keys(g.detail).length > 0 && (
        <span className="block space-y-0.5 border-t border-[var(--desk-line-color)] pt-1.5">
          {Object.entries(g.detail).map(([k, v]) => (
            <span key={k} className="flex justify-between gap-2">
              <span className="text-muted-foreground">{plain(k)}</span>
              <span className="text-right tabular-nums text-foreground">{show(v)}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** Badge + week-on-week arrow. Pressing the badge shows how the grade was made. */
export function GradeBadge({ agentId, grade, weekAgo }: { agentId: string | null; grade: string | null; weekAgo: string | null }) {
  const b = badgeFor(grade);
  const trend = gradeTrend(grade, weekAgo);
  const badge = <KitGradeBadge grade={grade} />;
  return (
    <span className="inline-flex items-center gap-0.5" style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      {agentId ? (
        <DeskPopover
          label={`Agent ${b.words} — how it was graded`}
          trigger={badge}
          triggerClass={`rounded-full ${CALM} ${FOCUS}`}
        >
          {() => <GradeDetail agentId={agentId} />}
        </DeskPopover>
      ) : (
        badge
      )}
      {trend === 'up' && (
        <ArrowUp className={`h-3.5 w-3.5 ${statusText.ok}`} aria-label={`up from ${weekAgo} a week ago`} />
      )}
      {trend === 'down' && (
        <ArrowDown className={`h-3.5 w-3.5 ${statusText.bad}`} aria-label={`down from ${weekAgo} a week ago`} />
      )}
    </span>
  );
}
