/**
 * Agent Collection League — full page.
 *
 * Week: Monday–Sunday, Africa/Kampala. Every figure comes from
 * `get_agent_collection_league_details` / `get_agent_collection_league_leaderboard`.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Trophy, TrendingUp, TrendingDown, Minus, Users, Flame, Medal, Crown, Loader2, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  useAgentCollectionLeagueDetails,
  fetchLeagueLeaderboardPage,
  HEAT_CLASS,
  HEAT_LABEL,
  type LeagueDay,
  type LeagueRow,
} from '@/hooks/useAgentCollectionLeague';

function kampalaWeekStart(offsetWeeks = 0): string {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Kampala' }));
  const dow = (now.getDay() + 6) % 7; // Monday = 0
  now.setDate(now.getDate() - dow + offsetWeeks * 7);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso || typeof iso !== 'string') return '—';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}


function RankChange({ change }: { change: number | null | undefined }) {
  if (change == null) return <span className="text-[11px] text-muted-foreground">new</span>;
  if (change === 0) return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
  const up = change > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={`flex items-center gap-0.5 text-[11px] font-medium ${up ? 'text-emerald-600' : 'text-destructive'}`}>
      <Icon className="h-3.5 w-3.5" />
      {Math.abs(change)}
    </span>
  );
}

function Heatmap({ days }: { days: LeagueDay[] }) {
  // Only days with a usable ISO date are shown.
  const valid = useMemo(
    () => days.filter((d) => typeof d?.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d.date)),
    [days],
  );

  const months = useMemo(() => {
    const set = new Set(valid.map((d) => d.date.slice(0, 7)));
    return Array.from(set).sort();
  }, [valid]);

  const [monthIdx, setMonthIdx] = useState<number | null>(null);
  const activeIdx = monthIdx ?? Math.max(0, months.length - 1);
  const month = months[activeIdx];

  const byDate = useMemo(() => {
    const m = new Map<string, LeagueDay>();
    valid.forEach((d) => m.set(d.date.slice(0, 10), d));
    return m;
  }, [valid]);

  if (!month) return <p className="text-xs text-muted-foreground">No collection days recorded yet.</p>;

  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // Monday-first
  const cells: (LeagueDay | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => {
      const iso = `${month}-${String(i + 1).padStart(2, '0')}`;
      return byDate.get(iso) ?? null;
    }),
  ];

  const monthLabel = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const monthDays = valid.filter((d) => d.date.startsWith(month) && !d.is_future);
  const collected = monthDays.reduce((s, d) => s + (d.collected_amount || 0), 0);
  const expected = monthDays.reduce((s, d) => s + (d.expected_amount || 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={activeIdx <= 0}
          onClick={() => { hapticTap(); setMonthIdx(activeIdx - 1); }}
          aria-label="Previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="text-center">
          <div className="text-sm font-semibold text-foreground">{monthLabel}</div>
          <div className="text-[11px] text-muted-foreground">
            <span className="text-emerald-600 font-medium">{formatUGX(collected)}</span> of {formatUGX(expected)}
          </div>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={activeIdx >= months.length - 1}
          onClick={() => { hapticTap(); setMonthIdx(activeIdx + 1); }}
          aria-label="Next month"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i}>{d}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <div key={i} className="aspect-square rounded bg-muted/30" />;
          const dayNum = Number(d.date.slice(8, 10));
          return (
            <div
              key={d.date}
              className={`aspect-square rounded flex items-center justify-center text-[10px] font-medium ${
                d.is_future ? 'bg-muted/50 text-muted-foreground' : `${HEAT_CLASS[d.heat_level]} text-white/90`
              }`}
              title={`${fmtDate(d.date)} — ${d.is_future ? 'Upcoming' : `${HEAT_LABEL[d.heat_level]} · ${formatUGX(d.collected_amount)} of ${formatUGX(d.expected_amount)}`}`}
            >
              {dayNum}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        {(['dark_red', 'red', 'light_red', 'light_green', 'green', 'dark_green'] as const).map((h) => (
          <span key={h} className="flex items-center gap-1">
            <span className={`h-3 w-3 rounded ${HEAT_CLASS[h]}`} />
            {HEAT_LABEL[h]}
          </span>
        ))}
      </div>
    </div>
  );
}

function LeaderboardRow({ row }: { row: LeagueRow }) {
  const badge =
    row.achievement === 'top_team' ? <Crown className="h-3.5 w-3.5 text-amber-500" />
    : row.achievement === 'full_collection' ? <Medal className="h-3.5 w-3.5 text-emerald-600" />
    : row.achievement === 'green_week' ? <Flame className="h-3.5 w-3.5 text-orange-500" />
    : null;

  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border ${
        row.is_me ? 'border-primary/40 bg-primary/5' : 'border-border bg-card'
      }`}
    >
      <span className="w-8 text-sm font-bold text-foreground shrink-0">#{row.rank}</span>
      <Avatar className="h-8 w-8 shrink-0">
        {row.team_avatar_url && <AvatarImage src={row.team_avatar_url} alt={row.team_name} />}
        <AvatarFallback className="text-[10px]">
          {row.team_name.replace(/^Team\s+/i, '').slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-semibold text-foreground truncate">{row.team_name}</span>
          {badge}
          {row.is_me && <span className="text-[10px] font-medium text-primary shrink-0">You</span>}
        </div>
        {row.is_me && row.collected_amount != null && (
          <div className="text-[11px] text-muted-foreground">
            <span className="text-emerald-600 font-medium">{formatUGX(row.collected_amount)}</span>
            {row.expected_amount != null && <> of {formatUGX(row.expected_amount)}</>}
          </div>
        )}
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-semibold text-foreground">
          {row.performance_percentage != null ? `${row.performance_percentage}%` : '—'}
        </div>
        <RankChange change={row.rank_change} />
      </div>
    </div>
  );
}

export default function CollectionLeaguePage() {
  const navigate = useNavigate();
  const [weekOffset, setWeekOffset] = useState(0);
  const weekStart = weekOffset === 0 ? undefined : kampalaWeekStart(weekOffset);
  const { data, isLoading, isError, error } = useAgentCollectionLeagueDetails(weekStart);

  const [extraRows, setExtraRows] = useState<LeagueRow[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [memberPage, setMemberPage] = useState(0);

  const MEMBERS_PER_PAGE = 10;
  const members = data?.team_members ?? [];
  const memberPageCount = Math.max(1, Math.ceil(members.length / MEMBERS_PER_PAGE));
  const currentMemberPage = Math.min(memberPage, memberPageCount - 1);
  const visibleMembers = members.slice(
    currentMemberPage * MEMBERS_PER_PAGE,
    currentMemberPage * MEMBERS_PER_PAGE + MEMBERS_PER_PAGE,
  );


  const baseRows = data?.leaderboard ?? [];
  const rows = useMemo(() => {
    const seen = new Set<number>();
    return [...baseRows, ...extraRows].filter((r) => (seen.has(r.rank) ? false : (seen.add(r.rank), true)))
      .sort((a, b) => a.rank - b.rank);
  }, [baseRows, extraRows]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await fetchLeagueLeaderboardPage(weekStart ?? null, rows.length, 20);
      setExtraRows((prev) => [...prev, ...page.rows]);
      if (page.rows.length === 0 || rows.length + page.rows.length >= page.total_teams) setExhausted(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const t = data?.my_team_summary;
  const prev = data?.previous_week_summary;

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => { hapticTap(); navigate(-1); }}
            className="p-2 -ml-2 rounded-full hover:bg-muted touch-manipulation"
            aria-label="Go back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-foreground truncate">Collection League</h1>
            {data && (
              <p className="text-[11px] text-muted-foreground">
                {fmtDate(data.week.week_start)} – {fmtDate(data.week.week_end)} · Kampala week
              </p>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-4 space-y-5">
        <div className="flex items-center gap-2">
          <Button
            variant="outline" size="sm"
            onClick={() => { hapticTap(); setWeekOffset((w) => w - 1); setExtraRows([]); setExhausted(false); }}
          >
            Previous week
          </Button>
          <Button
            variant="outline" size="sm" disabled={weekOffset === 0}
            onClick={() => { hapticTap(); setWeekOffset((w) => Math.min(0, w + 1)); setExtraRows([]); setExhausted(false); }}
          >
            This week
          </Button>
        </div>

        {isLoading && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 rounded-2xl border border-border bg-card animate-pulse" />
            ))}
          </div>
        )}

        {isError && (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
            <p className="text-sm text-foreground font-medium mb-1">The league could not be loaded.</p>
            <p className="text-xs text-muted-foreground">{(error as Error)?.message ?? 'Please try again shortly.'}</p>
          </div>
        )}

        {data && !data.has_team && !t?.is_parent && (
          <div className="rounded-2xl border border-border bg-card p-5 text-center">
            <Trophy className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm font-medium text-foreground mb-1">You are not in a team yet</p>
            <p className="text-xs text-muted-foreground">
              Once you are part of a team, your weekly rank, collections and team-mates appear here.
            </p>
          </div>
        )}

        {data && t && (data.has_team || t.is_parent) && (
          <>
            {/* Team summary */}
            <section className="rounded-2xl border border-primary/25 bg-primary/5 p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="text-[11px] text-muted-foreground">Your team</div>
                  <div className="text-base font-semibold text-foreground truncate">{t.team_name}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-3xl font-bold text-foreground leading-none">
                    {t.rank != null ? `#${t.rank}` : '—'}
                  </div>
                  <div className="text-[11px] text-muted-foreground">of {t.total_teams} teams</div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <div className="text-[11px] text-muted-foreground">Collected</div>
                  <div className="text-sm font-semibold text-emerald-600">{formatUGX(t.collected_amount)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Expected</div>
                  <div className="text-sm font-semibold text-foreground">{formatUGX(t.expected_amount)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Performance</div>
                  <div className="text-sm font-semibold text-foreground">
                    {t.performance_percentage != null ? `${t.performance_percentage}%` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Collecting</div>
                  <div className="text-sm font-semibold text-foreground flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" />{t.active_collectors}/{t.total_members}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">Movement <RankChange change={t.rank_change} /></span>
                {t.consistency_days != null && <span>{t.consistency_days} strong day(s) this week</span>}
              </div>
            </section>

            {/* Last week */}
            {prev && (
              <section className="rounded-2xl border border-border bg-card p-4">
                <div className="text-[11px] text-muted-foreground mb-1">
                  Last week ({fmtDate(prev.week_start)} – {fmtDate(prev.week_end)})
                </div>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
                  <span className="font-semibold text-foreground">
                    {prev.rank != null ? `#${prev.rank}` : 'Unranked'}
                  </span>
                  <span className="text-foreground">
                    {prev.performance_percentage != null ? `${prev.performance_percentage}%` : '—'}
                  </span>
                  <span className="text-emerald-600 font-medium">{formatUGX(prev.collected_amount)}</span>
                  <span className="text-muted-foreground">of {formatUGX(prev.expected_amount)}</span>
                </div>
              </section>
            )}

            {/* Heatmap */}
            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground mb-3">Daily collection heat</h2>
              {data.heatmap.length === 0 ? (
                <p className="text-xs text-muted-foreground">No collection days recorded yet.</p>
              ) : (
                <Heatmap days={data.heatmap} />
              )}
            </section>

            {/* Members */}
            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground mb-3">Team performance this week</h2>
              {members.length === 0 ? (
                <p className="text-xs text-muted-foreground">No team members recorded for this week.</p>
              ) : (
                <div className="space-y-2">
                  {visibleMembers.map((m) => (
                    <div key={m.agent_id} className="flex items-center gap-3 py-2 border-b border-border/60 last:border-0">
                      <Avatar className="h-9 w-9 shrink-0">
                        {m.avatar_url && <AvatarImage src={m.avatar_url} alt={m.name} />}
                        <AvatarFallback className="text-[11px]">
                          {m.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-sm font-semibold text-foreground truncate">{m.name}</span>
                          {m.is_parent && <span className="text-[10px] text-primary shrink-0">Lead</span>}
                          {m.is_me && <span className="text-[10px] text-muted-foreground shrink-0">You</span>}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {m.collection_count} collection(s)
                          {m.last_collection_at && (
                            <> · last {new Date(m.last_collection_at).toLocaleString('en-GB', {
                              timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                            })}</>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-semibold text-emerald-600">{formatUGX(m.collected_amount)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {m.performance_percentage != null ? `${m.performance_percentage}%` : '—'} of {formatUGX(m.expected_amount)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {members.length > MEMBERS_PER_PAGE && (
                <div className="mt-3 flex items-center justify-between gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentMemberPage === 0}
                    onClick={() => { hapticTap(); setMemberPage(currentMemberPage - 1); }}
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />Previous
                  </Button>
                  <span className="text-[11px] text-muted-foreground">
                    {currentMemberPage * MEMBERS_PER_PAGE + 1}–
                    {currentMemberPage * MEMBERS_PER_PAGE + visibleMembers.length} of {members.length}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentMemberPage >= memberPageCount - 1}
                    onClick={() => { hapticTap(); setMemberPage(currentMemberPage + 1); }}
                  >
                    Next<ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              )}
            </section>

            {/* Leaderboard */}
            <section className="rounded-2xl border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground mb-1">League table</h2>
              <p className="text-[11px] text-muted-foreground mb-3">
                {data.leaderboard_meta.total_teams} teams ranked this week. Only your own team's amounts are shown.
              </p>
              {rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">No teams have qualified for this week yet.</p>
              ) : (
                <div className="space-y-2">
                  {rows.map((r) => <LeaderboardRow key={r.rank} row={r} />)}
                </div>
              )}
              {rows.length > 0 && !exhausted && rows.length < data.leaderboard_meta.total_teams && (
                <Button variant="outline" size="sm" className="w-full mt-3" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Loading</> : 'Load more teams'}
                </Button>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
