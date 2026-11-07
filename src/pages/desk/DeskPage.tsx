import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Maximize2, Minimize2, Moon, Play, RefreshCw, Rows3, Square, Sun } from 'lucide-react';
import WelileLogo from '@/components/WelileLogo';
import { useAuth } from '@/hooks/useAuth';
import { DESKS, DESK_ALIASES, feedsOf, landingDesk, show, type Desk, type Getter } from './deskConfig';
import { useDeskFeeds, type FeedState, type Row } from './useDeskFeed';
import { DeskTable, type ReviewHook } from './DeskTable';
import { CommandCentre } from './CommandCentre';
import { TileGrid } from './Tiles';
import { SkeletonLead, SkeletonTiles } from './Skeleton';
import { DeskPrefsProvider, KampalaClock, clockTime, useDeskPrefs } from './deskPrefs';
import { CALM, FOCUS, statusText } from './deskTheme';
import { deskChecklistOn } from './deskFlag';
import { DESK_STAGE } from './reviewTypes';
import { AMBIGUOUS_MSG, NOT_FOUND_MSG, NO_STAFF_ID, resolveShortId, useMyStaffRef } from './reviewApi';
import { ReviewStatusProvider } from './reviewStatus';
import { ReviewDrawer } from './ReviewDrawer';
import { FunderBoard } from './FunderBoard';
import { PushQueueCards } from './PushQueueCards';
import { FundersDashboard } from './cfo/FundersDashboard';
import { useDeskLive } from './deskLive';
import { PipelineStrip } from './PipelineStrip';
import { DeskTabs } from './DeskTabs';
import { DoneTodayFold, FRAMED_DESKS, Fold, READY_TABLE, WaitingOnFold } from './DeskFrame';
import { ReadyBoard, type DrawerContext, type DrawerStart, type OpenDrawer } from './ReadyBoard';
import { AgentRankingFold } from './AgentRanking';
import { ScriptEditor } from './landlordOps';
import { CooBoard, RetiredFundNote } from './CooBoard';
import { PartnerWatch } from './PartnerWatch';
import { desksFor, useMyScScope } from './scScope';
import { DeskRules } from './DeskRules';
import { AgentsLiveFold } from './agents/AgentsLive';
import { OntologyTab } from './ontology/OntologyTab';

const ROTATE_MS = 45_000;

/** Desks whose "Ready for your push" is the board (pipeline_desk_board). Their queue table stays in Classic view. */
const BOARD_DESKS = new Set(['service-centre', 'agent-ops', 'tenant-ops', 'landlord-ops']);

/** The one table on each desk whose rows are reviewable requests. */
const QUEUE_TABLE: Record<string, string> = {
  'service-centre': 'sc-queue',
  'agent-ops': 'agent-ops-queue',
  'tenant-ops': 'tenant-ops-queue',
  'landlord-ops': 'landlord-ops-queue',
  'partner-ops': 'partner-queue',
  coo: 'coo-queue',
};

/** The desks that carry a second tab beside their queue. */
// The COO's "Fund by score" tab was the budget path, retired 5 Nov; Classic view says so.
const EXTRA_TAB: Record<string, string> = {
  'partner-ops': 'Funder board — preview',
  ontology: 'Ontology',
};

function ToolButton({
  onClick,
  active,
  children,
  label,
}: {
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={`desk-pill inline-flex items-center gap-1.5 border px-3 py-1.5 text-xs font-medium ${CALM} ${FOCUS} ${
        active
          ? 'border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.18)] text-foreground'
          : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:bg-[var(--desk-surface-hover)] hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Sun or moon, whichever the next press would give you.
 *
 * Pressing it always lands on an explicit light or dark — once someone has
 * chosen, the device setting stops overriding them. Board mode is always dark,
 * so the toggle is hidden there rather than shown doing nothing.
 */
function ThemeToggle() {
  const { theme, setTheme } = useDeskPrefs();
  const next = theme === 'light' ? 'dark' : 'light';
  const Icon = next === 'dark' ? Moon : Sun;
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to the ${next} theme`}
      title={`Switch to the ${next} theme`}
      className={`desk-pill inline-flex items-center gap-1.5 border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-1.5 text-xs font-medium ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)] hover:text-foreground`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {next === 'dark' ? 'Dark' : 'Light'}
    </button>
  );
}

function Toolbar({ updated, failed, board }: { updated: number; failed: string[]; board: boolean }) {
  const { setBoard, density, setDensity, rotate, setRotate } = useDeskPrefs();
  const queryClient = useQueryClient();
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="desk-pill desk-live-pill inline-flex items-center gap-1.5 border px-2.5 py-1">
        <span className="desk-live-dot h-1.5 w-1.5 rounded-full bg-[hsl(var(--desk-live-fg))]" aria-hidden />
        <span className="font-semibold tracking-wide">LIVE</span>
      </span>

      <KampalaClock className={`${board ? 'text-base' : 'text-sm'} font-medium text-foreground`} />
      <span>Updated {clockTime(updated)}</span>

      <button
        type="button"
        onClick={() => queryClient.invalidateQueries({ queryKey: ['desk-feed'] })}
        className={`desk-pill inline-flex items-center gap-1.5 border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-1.5 ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)] hover:text-foreground`}
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
      </button>

      <ToolButton
        onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
        active={density === 'compact'}
        label={density === 'compact' ? 'Switch to comfortable rows' : 'Switch to compact rows'}
      >
        <Rows3 className="h-3.5 w-3.5" aria-hidden />
        {density === 'compact' ? 'Compact' : 'Comfortable'}
      </ToolButton>

      {/* Board mode is always dark, so the toggle is offered everywhere else. */}
      {!board && <ThemeToggle />}

      <ToolButton onClick={() => setBoard(!board)} active={board} label={board ? 'Leave board mode' : 'Enter board mode'}>
        {board ? <Minimize2 className="h-3.5 w-3.5" aria-hidden /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden />}
        Board mode
      </ToolButton>

      {board && (
        <ToolButton
          onClick={() => setRotate(!rotate)}
          active={rotate}
          label={rotate ? 'Stop rotating desks' : 'Rotate desks every 45 seconds'}
        >
          {rotate ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
          Rotate
        </ToolButton>
      )}

      {failed.length > 0 && <span className={statusText.bad}>Some figures could not load ({failed.join(', ')}).</span>}
    </div>
  );
}

/** Ontology only: choose which mapped day every onto_ feed shows. Stored as ?day=YYYY-MM-DD. */
function DayPicker({ rows }: { rows: Record<string, unknown>[] }) {
  const [params, setParams] = useSearchParams();
  const chosen = params.get('day') ?? '';
  const latest = rows.find((r) => r.latest === true || r.latest === 'true');
  const latestIso = latest ? String(latest.day_iso) : '';
  const value = chosen || latestIso;
  const past = !!chosen && !!latestIso && chosen !== latestIso;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor="onto-day" className="text-muted-foreground">Day</label>
      <select
        id="onto-day"
        value={value}
        onChange={(e) => {
          const next = new URLSearchParams(params);
          if (!e.target.value || e.target.value === latestIso) next.delete('day');
          else next.set('day', e.target.value);
          setParams(next, { replace: true });
        }}
        className="rounded border border-border bg-background px-2 py-1 text-foreground"
      >
        {!value && <option value="">Latest</option>}
        {rows.map((r) => {
          const iso = String(r.day_iso);
          return (
            <option key={iso} value={iso}>
              {iso === latestIso ? `Latest — ${String(r.day_label)}` : String(r.day_label)}
            </option>
          );
        })}
      </select>
      {past && <span className="text-xs text-[hsl(var(--desk-lavender))]">Viewing a past day.</span>}
    </div>
  );
}

/**
 * The reviewer's staff ID. Every pipeline RPC refuses a review without one, so
 * the desk says so here rather than letting the drawer fail on submit.
 */
function StaffBadge() {
  const { data, isLoading } = useMyStaffRef();
  if (!deskChecklistOn() || isLoading) return null;
  if (data) {
    return (
      <p className="text-xs text-muted-foreground">
        Staff ID <span className="font-mono text-foreground">{data}</span>
      </p>
    );
  }
  return <p className={`text-xs ${statusText.warn}`}>{NO_STAFF_ID}</p>;
}

function DeskView({
  desk,
  feeds,
  board,
  scOnly = false,
}: {
  desk: Desk;
  feeds: Record<string, FeedState>;
  board: boolean;
  /** A Service Centre person with no desk role: their own requests on the board, nothing else. */
  scOnly?: boolean;
}) {
  // The review drawer (E26), the frame and the strip. The stage is null on desks
  // with no checklist, and the whole thing is off unless this desk is live:
  // its `desk_live:<id>` switch is not off and VITE_DESK_CHECKLIST is not false.
  const deskLive = useDeskLive();
  const checklistOn = deskLive(desk.id);
  const stage = checklistOn ? (DESK_STAGE[desk.id] ?? null) : null;
  const [openRequest, setOpenRequest] = useState<string | null>(null);
  // The board's ⋯ menu opens the drawer on a chosen decision or on "Wait on…".
  const [openInitial, setOpenInitial] = useState<DrawerStart | undefined>(undefined);
  const [openCtx, setOpenCtx] = useState<DrawerContext | undefined>(undefined);
  const [opening, setOpening] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  // `?tab=` opens the second tab straight away, so the budget-room card can
  // link to "Fund by score" rather than ask someone to find it.
  const [deskParams] = useSearchParams();
  const [tab, setTab] = useState<'queue' | 'extra'>(() =>
    deskParams.get('tab') && deskParams.get('tab') !== 'queue' ? 'extra' : 'queue',
  );

  /**
   * The row carries an 8-character code, so the id is looked up on the press.
   * An ambiguous code opens nothing: recording a review against the wrong
   * tenant is worse than making someone find the request another way.
   */
  const openByShort = async (short: string) => {
    if (!stage) return;
    setOpening(short);
    setNotes((n) => {
      if (!(short in n)) return n;
      const next = { ...n };
      delete next[short];
      return next;
    });
    const found = await resolveShortId(short, stage);
    setOpening(null);
    if (found.status === 'ok') {
      setOpenInitial(undefined);
      setOpenCtx(undefined);
      setOpenRequest(found.id);
      return;
    }
    const why =
      found.status === 'ambiguous'
        ? AMBIGUOUS_MSG
        : found.status === 'not_found'
          ? NOT_FOUND_MSG
          : found.message;
    setNotes((n) => ({ ...n, [short]: why }));
  };

  const g: Getter = (ref) => (feeds[ref.feed]?.loading ? '—' : show(feeds[ref.feed]?.rows ?? [], ref));
  const anyLoading = Object.values(feeds).some((f) => f.loading);
  const tiles = desk.tiles.filter(
    (t) =>
      !(
        t.feed === 'coo_kpis' &&
        (feeds.coo_kpis?.rows ?? []).length > 0 &&
        !feeds.coo_kpis.rows.some((r) => r.metric === t.where?.[1])
      ),
  );

  // The command centre owns its own strip, river and panels.
  if (desk.id === 'command') {
    return <CommandCentre feeds={feeds} board={board} tiles={tiles} pipelineCards={checklistOn} />;
  }

  const queueTable = QUEUE_TABLE[desk.id];
  const review: ReviewHook | undefined = stage
    ? {
        shortFor: (row: Row) => (typeof row.req === 'string' && row.req ? row.req : null),
        onOpen: openByShort,
        opening,
        notes,
      }
    : undefined;

  const extraTab = checklistOn ? EXTRA_TAB[desk.id] : undefined;
  const showQueue = !extraTab || tab === 'queue';

  const intro = (
    <>
      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">{desk.question}</p>
        {desk.id === 'ontology' && <DayPicker rows={feeds.onto_days?.rows ?? []} />}
        {anyLoading ? (
          <SkeletonLead />
        ) : (
          <p className={`${board ? 'text-2xl' : 'text-lg sm:text-xl'} leading-snug text-foreground max-w-4xl`}>
            {desk.lead(g)}
          </p>
        )}
      </div>

      {anyLoading && tiles.length > 0 ? (
        <SkeletonTiles count={tiles.length} board={board} />
      ) : (
        <TileGrid tiles={tiles} feeds={feeds} board={board} />
      )}

      {/* The COO reads the push queue and the funders' board before opening the queue (budgets retired 5 Nov). */}
      {checklistOn && desk.id === 'coo' && <PushQueueCards board={board} enabled onCooDesk />}
    </>
  );

  const tabs = extraTab && (
    <div role="tablist" aria-label={`${desk.name} views`} className="flex flex-wrap gap-1.5">
      {(['queue', 'extra'] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          onClick={() => setTab(t)}
          className={`desk-pill border px-3.5 py-1.5 text-sm ${CALM} ${FOCUS} ${
            tab === t
              ? 'border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.18)] text-foreground'
              : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:bg-[var(--desk-surface-hover)] hover:text-foreground'
          }`}
        >
          {t === 'queue' ? (desk.id === 'ontology' ? 'Day map' : 'Queue') : extraTab}
        </button>
      ))}
    </div>
  );

  const extraView = (
    <>
      {extraTab && tab === 'extra' && desk.id === 'partner-ops' && <FunderBoard board={board} />}
      {extraTab && tab === 'extra' && desk.id === 'ontology' && <OntologyTab board={board} />}
    </>
  );

  const table = (spec: Desk['tables'][number]) => (
    <DeskTable
      key={spec.id}
      spec={spec}
      board={board}
      feed={feeds[spec.feed] ?? { rows: [], loading: true, error: null, updatedAt: 0 }}
      review={review && spec.id === queueTable ? review : undefined}
    />
  );

  /* Keyed on the request: opening a second row never carries the first
     request's ticks, note or logged call across to another tenant. */
  const drawer = stage && openRequest && (
    <ReviewDrawer
      key={`${openRequest}:${openInitial ?? ''}`}
      stage={stage}
      requestId={openRequest}
      initial={openInitial}
      ctx={openCtx}
      onClose={() => setOpenRequest(null)}
    />
  );

  const openFromBoard: OpenDrawer = (id, initial, ctx) => {
    setOpenInitial(initial);
    setOpenCtx(ctx);
    setOpenRequest(id);
  };

  // A Service Centre person: the board scoped to their own requests, and nothing
  // that reads staff-only feeds.
  if (scOnly) {
    return (
      <div className={`space-y-5 ${board ? 'h-full overflow-auto' : ''}`}>
        <p className="text-sm text-muted-foreground">{desk.question}</p>
        {checklistOn && stage ? (
          <section className="space-y-3" aria-labelledby="desk-ready">
            <h2 id="desk-ready" className={`${board ? 'text-xl' : 'text-lg'} font-semibold text-foreground`}>
              Ready for your push
            </h2>
            <ReadyBoard stage={stage} board={board} onOpen={openFromBoard} />
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">The Service Centre desk is switched off right now. Try again later.</p>
        )}
        {drawer}
      </div>
    );
  }

  // The stage desks, when live: strip → Ready for your push → Waiting on… →
  // Done today → Classic view. Classic view keeps every table the desk had.
  if (checklistOn && FRAMED_DESKS.has(desk.id)) {
    const ready = desk.tables.find((t) => t.id === READY_TABLE[desk.id]);
    return (
      <div className={`space-y-5 ${board ? 'h-full overflow-auto' : ''}`}>
        <PipelineStrip deskId={desk.id} board={board} />
        {intro}

        <section className="space-y-3" aria-labelledby="desk-ready">
          <h2 id="desk-ready" className={`${board ? 'text-xl' : 'text-lg'} font-semibold text-foreground`}>
            Ready for your push
          </h2>
          {tabs}
          {extraView}
          {desk.id === 'cfo' ? (
            <FundersDashboard board={board} />
          ) : desk.id === 'coo' ? (
            <CooBoard board={board} onOpen={openFromBoard} />
          ) : showQueue && stage && BOARD_DESKS.has(desk.id) ? (
            <ReadyBoard stage={stage} board={board} onOpen={openFromBoard} />
          ) : (
            showQueue && ready && table(ready)
          )}
        </section>

        {desk.id === 'agent-ops' && <AgentRankingFold board={board} />}
        <AgentsLiveFold deskId={desk.id} board={board} />
        <WaitingOnFold deskId={desk.id} board={board} />
        <DoneTodayFold deskId={desk.id} board={board} />
        <Fold title="Classic view" board={board} hint="Every table this desk showed before, unchanged">
          {desk.id === 'coo' && <RetiredFundNote />}
          {desk.tables.map(table)}
        </Fold>

        {drawer}
      </div>
    );
  }

  // Partner Ops, when live: it no longer attaches funders; it watches the funders' board.
  if (checklistOn && desk.id === 'partner-ops') {
    return (
      <div className={`space-y-5 ${board ? 'h-full overflow-auto' : ''}`}>
        <PipelineStrip deskId={desk.id} board={board} />
        {intro}
        <section className="space-y-3" aria-labelledby="desk-watch">
          <h2 id="desk-watch" className={`${board ? 'text-xl' : 'text-lg'} font-semibold text-foreground`}>
            Funder board watch
          </h2>
          <PartnerWatch board={board} />
        </section>
        <Fold title="Funder board — preview" board={board} hint="What the funders would see">
          <FunderBoard board={board} />
        </Fold>
        <DeskRules deskId={desk.id} board={board} />
        <Fold title="Classic view" board={board} hint="Every table this desk showed before, unchanged">
          {desk.tables.map(table)}
        </Fold>
        {drawer}
      </div>
    );
  }

  return (
    <div className={`space-y-5 ${board ? 'h-full overflow-auto' : ''}`}>
      {checklistOn && <PipelineStrip deskId={desk.id} board={board} />}
      {!(desk.id === 'ontology' && !showQueue) && intro}
      {tabs}
      {extraView}
      {showQueue && desk.tables.map(table)}
      {/* Partner Ops and Customer Care have no frame, so their rules sit at the foot. */}
      {checklistOn && <DeskRules deskId={desk.id} board={board} />}
      {/* The COO's settings live on the Ontology desk: the landlord call script. The server lets only the COO save. */}
      {checklistOn && desk.id === 'ontology' && (
        <Fold title="Edit call script — Landlord Ops" board={board} hint="What Landlord Ops reads on every landlord call">
          <ScriptEditor desk="landlord_ops" />
        </Fold>
      )}
      {drawer}
    </div>
  );
}

function DeskShell() {
  const { desk: rawDeskId } = useParams();
  // `/desk/funders` is the same desk as `/desk/cfo`.
  const deskId = rawDeskId ? (DESK_ALIASES[rawDeskId] ?? rawDeskId) : rawDeskId;
  const { roles } = useAuth();
  // Light unless the viewer chose dark; Board mode is always dark (deskPrefs.resolveDeskTheme).
  const { board, rotate, rootTheme } = useDeskPrefs();
  const navigate = useNavigate();

  const mine = (roles ?? []) as unknown as string[];
  // Desk roles first; with none, ask whether this account is a Service Centre person.
  const hasDeskRole = DESKS.some((d) => d.roles.some((r) => mine.includes(r)));
  const scScope = useMyScScope(!hasDeskRole && roles !== undefined);
  const { desks: allowed, scOnly } = desksFor(DESKS, mine, scScope.data);
  const desk = allowed.find((d) => d.id === deskId);
  const [search] = useSearchParams();
  const rawDay = search.get('day');
  const day = desk?.id === 'ontology' && rawDay && /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : null;
  // A Service Centre person reads only the board, never the staff feeds.
  const feeds = useDeskFeeds(desk && !scOnly ? feedsOf(desk) : [], day);

  // Board mode can walk itself through the desks for a wall display. Off unless asked for.
  const deskKey = desk?.id;
  const allowedKey = allowed.map((d) => d.id).join(',');
  useEffect(() => {
    if (!board || !rotate || !deskKey) return;
    const ids = allowedKey.split(',').filter(Boolean);
    if (ids.length < 2) return;
    const id = window.setInterval(() => {
      const next = ids[(ids.indexOf(deskKey) + 1) % ids.length];
      navigate(`/desk/${next}?board=1`, { replace: true });
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [board, rotate, deskKey, allowedKey, navigate]);

  if (allowed.length === 0 && !hasDeskRole && scScope.isLoading) {
    return (
      <main className="desk-root min-h-screen px-4 py-16 text-center" data-desk-theme={rootTheme} aria-busy>
        <p className="text-sm text-muted-foreground">Opening your desk…</p>
      </main>
    );
  }

  if (allowed.length === 0) {
    return (
      <main className="desk-root min-h-screen px-4 py-16 text-center" data-desk-theme={rootTheme}>
        <div className="mx-auto max-w-xl space-y-2">
          <h1 className="text-xl font-semibold text-foreground">No desk for your account yet</h1>
          <p className="text-sm text-muted-foreground">
            Desks open for operations staff. Ask the COO office to confirm your role, then reload this page.
          </p>
        </div>
      </main>
    );
  }
  if (!desk) return <Navigate to={`/desk/${landingDesk(mine, allowed).id}${board ? '?board=1' : ''}`} replace />;

  const updated = Math.max(0, ...Object.values(feeds).map((f) => f.updatedAt || 0));
  const failed = Object.entries(feeds)
    .filter(([, f]) => f.error)
    .map(([k]) => k);

  const header = (
    <header className={`min-w-0 ${board ? 'shrink-0 space-y-3' : 'space-y-4'}`}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-3 min-w-0">
          <WelileLogo size="sm" showText={false} linkToHome={false} variant="light" />
          <div className="min-w-0">
            <h1 className={`${board ? 'text-2xl' : 'text-xl sm:text-2xl'} font-semibold tracking-tight text-foreground`}>
              Ops Command Centre
            </h1>
            <p className={`${board ? 'text-base' : 'text-sm'} text-[hsl(var(--desk-lavender))]`}>{desk.name}</p>
            <StaffBadge />
          </div>
        </div>
        <Toolbar updated={updated} failed={failed} board={board} />
      </div>

      {allowed.length > 1 && (
        <DeskTabs desks={allowed} activeId={desk.id} board={board} />
      )}
    </header>
  );

  if (board) {
    // A wall display: full bleed, one screen, 32px of air all round.
    return (
      <div className="desk-root flex h-[100dvh] min-w-0 flex-col gap-6 overflow-hidden px-4 py-6 sm:px-8" data-desk-theme="dark">
        {header}
        <div className="min-h-0 min-w-0 flex-1">
          <DeskView key={desk.id} desk={desk} feeds={feeds} board scOnly={scOnly} />
        </div>
      </div>
    );
  }

  return (
    <div className="desk-root min-h-screen" data-desk-theme={rootTheme}>
      <main className="mx-auto w-full min-w-0 max-w-[1440px] space-y-6 px-4 py-6 sm:px-8">
        {header}
        <DeskView key={desk.id} desk={desk} feeds={feeds} board={false} scOnly={scOnly} />
      </main>
    </div>
  );
}

export default function DeskPage() {
  return (
    <DeskPrefsProvider>
      <ReviewStatusProvider>
        <DeskShell />
      </ReviewStatusProvider>
    </DeskPrefsProvider>
  );
}
