import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { rpc, readableError } from './reviewApi';
import { gradeTrend } from './boardApi';
import { CALM, FOCUS, LABEL, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';
import { Pop } from './Pop';

/**
 * The agent grade badge: A green, B teal, C amber, D red, N grey "New",
 * X black "Blocked", none grey "Not graded". A press opens the grade's
 * make-up from `agent_grade_of(p_agent)`.
 */

const BADGE: Record<string, { cls: string; text: string; words: string }> = {
  A: { cls: 'bg-emerald-600 text-white border-emerald-600', text: 'A', words: 'grade A' },
  B: { cls: 'bg-teal-600 text-white border-teal-600', text: 'B', words: 'grade B' },
  C: { cls: 'bg-amber-500 text-black border-amber-500', text: 'C', words: 'grade C' },
  D: { cls: 'bg-red-600 text-white border-red-600', text: 'D', words: 'grade D' },
  N: { cls: 'bg-slate-500/25 text-foreground border-slate-500/50', text: 'New', words: 'new agent, not yet graded' },
  X: { cls: 'bg-black text-white border-white/30', text: 'Blocked', words: 'blocked' },
};
const NONE = { cls: 'bg-slate-500/20 text-muted-foreground border-slate-500/40', text: 'Not graded', words: 'not graded' };

export function badgeFor(grade: string | null | undefined) {
  return (grade && BADGE[grade]) || NONE;
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
  const b = badgeFor(g.grade);
  return (
    <span className="block space-y-2 text-xs">
      <span className="flex items-baseline justify-between gap-2">
        <span className={`desk-pill border px-2 py-0.5 font-semibold ${b.cls}`}>{b.text}</span>
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
  const badge = <span className={`desk-pill inline-block border px-1.5 py-0 text-[11px] font-semibold leading-5 ${b.cls}`}>{b.text}</span>;
  return (
    <span className="inline-flex items-center gap-0.5">
      {agentId ? (
        <Pop
          label={`Agent ${b.words} — how it was graded`}
          trigger={badge}
          triggerClass={`rounded-full ${CALM} ${FOCUS}`}
        >
          {() => <GradeDetail agentId={agentId} />}
        </Pop>
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
