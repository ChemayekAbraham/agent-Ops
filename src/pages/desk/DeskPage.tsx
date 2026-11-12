import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Maximize2, Minimize2, Moon, MoreHorizontal, Play, RefreshCw, Rows3, Square, Sun } from 'lucide-react';
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
import { SelfAppliedCard } from './SelfAppliedQueue';
import { IncompleteSection } from './incomplete';
import { FundersDashboard } from './cfo/FundersDashboard';
import { FundersHeadline } from './cfo/FundersHeadline';
import { FundersBoardCounterCard } from './cfo/FundersBoardCounterCard';
import { DemotedPanel } from './fundersBoard/DemotedPanel';
import type { Period as FundersPeriod } from './cfo/cfoApi';
import { useDeskLive } from './deskLive';
import { PipelineStrip } from './PipelineStrip';
import { DeskSwitcher, DeskTabs } from './DeskTabs';
import { DecisionButton, Sheet, atLeast, useBreakpoint, type Breakpoint } from './ui';
import { DoneTodayFold, FRAMED_DESKS, Fold, READY_TABLE, WaitingOnFold } from './DeskFrame';
import { ReadyBoard, type DrawerContext, type DrawerStart, type OpenDrawer } from './ReadyBoard';
import { AgentRankingFold } from './AgentRanking';
import { ScriptEditor } from './landlordOps';
import { CooBoard, RetiredFundNote } from './CooBoard';
import { PartnerWatch } from './PartnerWatch';
import { PartnerOpsBoard } from './partner/PartnerOpsBoard';
import { desksFor, useMyScScope } from './scScope';
import { accessLanding, desksByAccess, useMyDeskAccess } from './deskAccess';
import { DeskRules } from './DeskRules';
import { AccountabilityFold } from './accountability/AccountabilityFold';
import { EditResponsibilitiesFold } from './ontology/ResponsibilitiesEditor';
import { AgentsLiveFold } from './agents/AgentsLive';
import { AgentsDesk } from './agents/AgentsDesk';
import { FlowPanel } from './flow/FlowPanel';
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

/** A short Kampala clock for the compact bar: "14:05". */
function ShortClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="tabular-nums text-sm font-medium text-foreground" style={{ whiteSpace: 'nowrap' }}>
      {now.toLocaleTimeString('en-GB', { timeZone: 'Africa/Kampala', hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}

function LivePill({ dotOnly }: { dotOnly?: boolean }) {
  return (
    <span
      className="desk-pill desk-live-pill inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0 }}
      aria-label="Live"
    >
      <span className="desk-live-dot h-1.5 w-1.5 rounded-full bg-[hsl(var(--desk-live-fg))]" style={{ width: 6, height: 6, borderRadius: 999 }} aria-hidden />
      {dotOnly ? <span className="sr-only">LIVE</span> : <span className="font-semibold tracking-wide">LIVE</span>}
    </span>
  );
}

/**
 * The "⋯" menu: whatever the header has no room for at this width. Always
 * Refresh-adjacent tools (density, staff ID, updated time); also Refresh and
 * Light/Dark below md, and Board mode only from lg (where it is in the bar).
 */
function HeaderMenu({
  updated,
  failed,
  board,
  bp,
}: {
  updated: number;
  failed: string[];
  board: boolean;
  bp: Breakpoint;
}) {
  const [open, setOpen] = useState(false);
  const { theme, setTheme, density, setDensity, setBoard } = useDeskPrefs();
  const queryClient = useQueryClient();
  const compact = !atLeast(bp, 'md');
  const lg = atLeast(bp, 'lg');
  const next = theme === 'light' ? 'dark' : 'light';
  return (
    <>
      <button
        type="button"
        aria-label="Desk options"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={`desk-pill relative border border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground ${CALM} ${FOCUS} hover:text-foreground`}
        style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44, borderWidth: 1, borderStyle: 'solid', borderRadius: 999, flexShrink: 0 }}
        data-header-menu
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
        {failed.length > 0 && (
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[hsl(var(--desk-warn-dot))]" style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: 999 }} aria-hidden />
        )}
      </button>
      {open && (
        <Sheet title="Desk options" onClose={() => setOpen(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-header-menu-items>
            <p className="text-sm text-muted-foreground" style={{ margin: 0 }}>
              Updated {clockTime(updated)}
            </p>
            {compact && (
              <DecisionButton size="md" align="start" onClick={() => queryClient.invalidateQueries({ queryKey: ['desk-feed'] })}>
                <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
              </DecisionButton>
            )}
            {!lg && !board && (
              <DecisionButton size="md" align="start" onClick={() => setTheme(next)} aria-label={`Switch to the ${next} theme`}>
                {next === 'dark' ? <Moon className="h-4 w-4" aria-hidden /> : <Sun className="h-4 w-4" aria-hidden />}
                {next === 'dark' ? 'Dark theme' : 'Light theme'}
              </DecisionButton>
            )}
            <DecisionButton
              size="md"
              align="start"
              aria-pressed={density === 'compact'}
              onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
            >
              <Rows3 className="h-4 w-4" aria-hidden />
              {density === 'compact' ? 'Rows: compact' : 'Rows: comfortable'}
            </DecisionButton>
            {board && !lg && (
              <DecisionButton size="md" align="start" onClick={() => setBoard(false)}>
                <Minimize2 className="h-4 w-4" aria-hidden /> Leave board mode
              </DecisionButton>
            )}
            <StaffBadge />
            {failed.length > 0 && <p className={`text-sm ${statusText.bad}`} style={{ margin: 0 }}>Some figures could not load ({failed.join(', ')}).</p>}
          </div>
        </Sheet>
      )}
    </>
  );
}

/**
 * The toolbar on the right of the header, staged by width so the header never
 * takes more than two rows (bar, then tabs):
 *   md  LIVE · clock · Refresh · ⋯
 *   lg  + Light/Dark · Board mode
 *   xl  + Updated · Density · Rotate, and no ⋯ (the staff ID sits under the title)
 */
function Toolbar({ updated, failed, board, bp }: { updated: number; failed: string[]; board: boolean; bp: Breakpoint }) {
  const { setBoard, density, setDensity, rotate, setRotate } = useDeskPrefs();
  const queryClient = useQueryClient();
  const lg = atLeast(bp, 'lg');
  const xl = atLeast(bp, 'xl') || (board && lg);
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      style={{ display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 0 }}
      data-toolbar
    >
      <LivePill />

      <KampalaClock className={`${board ? 'text-base' : 'text-sm'} font-medium text-foreground whitespace-nowrap`} />
      {xl && <span style={{ whiteSpace: 'nowrap' }}>Updated {clockTime(updated)}</span>}

      <button
        type="button"
        onClick={() => queryClient.invalidateQueries({ queryKey: ['desk-feed'] })}
        className={`desk-pill inline-flex items-center gap-1.5 border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-1.5 ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)] hover:text-foreground`}
        style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
      </button>

      {xl && (
        <ToolButton
          onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
          active={density === 'compact'}
          label={density === 'compact' ? 'Switch to comfortable rows' : 'Switch to compact rows'}
        >
          <Rows3 className="h-3.5 w-3.5" aria-hidden />
          {density === 'compact' ? 'Compact' : 'Comfortable'}
        </ToolButton>
      )}

      {/* Board mode is always dark, so the toggle is offered everywhere else. */}
      {lg && !board && <ThemeToggle />}

      {lg && (
        <ToolButton onClick={() => setBoard(!board)} active={board} label={board ? 'Leave board mode' : 'Enter board mode'}>
          {board ? <Minimize2 className="h-3.5 w-3.5" aria-hidden /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden />}
          Board mode
        </ToolButton>
      )}

      {board && lg && (
        <ToolButton
          onClick={() => setRotate(!rotate)}
          active={rotate}
          label={rotate ? 'Stop rotating desks' : 'Rotate desks every 45 seconds'}
        >
          {rotate ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
          Rotate
        </ToolButton>
      )}

      {!xl && <HeaderMenu updated={updated} failed={failed} board={board} bp={bp} />}
      {xl && failed.length > 0 && <span className={statusText.bad}>Some figures could not load ({failed.join(', ')}).</span>}
    </div>
  );
}

/**
 * The desk header.
 *   below md  one sticky bar, at most 56px: desk (switcher), LIVE, time, ⋯
 *   md and up the title and toolbar on one row, the desk tabs on the next
 */
export function DeskHeader({
  desk,
  allowed,
  updated,
  failed,
  board,
  bp,
}: {
  desk: { id: string; name: string };
  allowed: { id: string; name: string }[];
  updated: number;
  failed: string[];
  board: boolean;
  bp: Breakpoint;
}) {
  if (!atLeast(bp, 'md')) {
    return (
      <header
        data-desk-header="compact"
        className="sticky top-0 z-30 border-b border-[var(--desk-line-color)] bg-[hsl(var(--background)/0.94)] backdrop-blur"
        style={{ position: 'sticky', top: 0, zIndex: 30, display: 'flex', alignItems: 'center', gap: 8, minHeight: 52, maxHeight: 56, margin: '0 -1rem', padding: '2px 1rem', minWidth: 0 }}
      >
        <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center' }}>
          <DeskSwitcher desks={allowed} activeId={desk.id} board={board} />
        </div>
        <LivePill dotOnly={bp === 'xs'} />
        <ShortClock />
        <HeaderMenu updated={updated} failed={failed} board={board} bp={bp} />
      </header>
    );
  }

  const xl = atLeast(bp, 'xl') || (board && atLeast(bp, 'lg'));
  return (
    <header data-desk-header="full" className={`min-w-0 ${board ? 'shrink-0 space-y-3' : 'space-y-3'}`}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minWidth: 0 }}>
        <div className="flex items-center gap-3 min-w-0" style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <WelileLogo size="sm" showText={false} linkToHome={false} variant="light" />
          <div className="min-w-0" style={{ minWidth: 0 }}>
            <h1 className={`${board ? 'text-2xl' : 'text-xl'} truncate font-semibold tracking-tight text-foreground`} style={{ margin: 0 }} title="Ops Command Centre">
              Ops Command Centre
            </h1>
            <p className={`${board ? 'text-base' : 'text-sm'} truncate text-[hsl(var(--desk-lavender))]`} style={{ margin: 0 }} title={desk.name}>
              {desk.name}
            </p>
            {xl && <StaffBadge />}
          </div>
        </div>
        <Toolbar updated={updated} failed={failed} board={board} bp={bp} />
      </div>

      {allowed.length > 1 && <DeskTabs desks={allowed} activeId={desk.id} board={board} />}
    </header>
  );
}

/**
 * While the "Set up your authenticator app" banner shows, the desk keeps room
 * for it at the bottom so it never covers a desk's main buttons.
 */
function useAuthenticatorBannerInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const banner = Array.from(document.querySelectorAll<HTMLElement>('div.z-40')).find((el) => /authenticator app/i.test(el.textContent ?? ''));
        setInset(banner ? Math.ceil(banner.getBoundingClientRect().height) : 0);
      });
    };
    measure();
    const mo = new MutationObserver(measure);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return inset;
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
  const [fundersPeriod, setFundersPeriod] = useState<FundersPeriod>('today');
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

  // The Agents desk (E61) draws its own list and agent sheet.
  if (desk.id === 'agents') return <AgentsDesk board={board} />;

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
      {/* E73: tenants who applied alone and still need an agent — Agent Ops assigns them from the board. */}
      {checklistOn && desk.id === 'agent-ops' && <SelfAppliedCard board={board} />}
      {/* E82: requests past Agent Ops that still miss something; completed here, in place. */}
      {checklistOn && desk.id === 'agent-ops' && <IncompleteSection board={board} />}
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
        {desk.id === 'cfo' && <FundersHeadline board={board} period={fundersPeriod} onPeriodChange={setFundersPeriod} />}
        {desk.id === 'cfo' && <FundersBoardCounterCard board={board} />}
        {/* E58: everything taken off the funders board waits here for its level. */}
        {desk.id === 'coo' && <DemotedPanel board={board} />}
        {intro}

        <section className="space-y-3" aria-labelledby="desk-ready">
          <h2 id="desk-ready" className={`${board ? 'text-xl' : 'text-lg'} font-semibold text-foreground`}>
            Ready for your push
          </h2>
          {/* IN / OUT first, straight under the heading: above the board's lead, period toggle, tiles and rows (the COO's sketch). */}
          <FlowPanel deskId={desk.id} board={board} />
          {tabs}
          {extraView}
          {desk.id === 'cfo' ? (
            <FundersDashboard board={board} period={fundersPeriod} onPeriodChange={setFundersPeriod} />
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

  // Partner Ops, when live: the sales desk — listings, Welile-due, funder approvals, field officers.
  if (checklistOn && desk.id === 'partner-ops') {
    return (
      <div className={`space-y-5 ${board ? 'h-full overflow-auto' : ''}`}>
        <PipelineStrip deskId={desk.id} board={board} />
        {intro}
        <section className="space-y-3" aria-labelledby="desk-ready">
          <h2 id="desk-ready" className={`${board ? 'text-xl' : 'text-lg'} font-semibold text-foreground`}>
            Ready for your push
          </h2>
          <FlowPanel deskId={desk.id} board={board} />
          <PartnerOpsBoard board={board} />
        </section>
        <AccountabilityFold deskId={desk.id} board={board} />
        <DeskRules deskId={desk.id} board={board} />
        <Fold title="Classic view" board={board} hint="The funder board watch and every table this desk showed before">
          <PartnerWatch board={board} />
          <FunderBoard board={board} />
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
      {checklistOn && <AccountabilityFold deskId={desk.id} board={board} />}
      {checklistOn && <DeskRules deskId={desk.id} board={board} />}
      {/* The COO's settings live on the Ontology desk: the landlord call script. The server lets only the COO save. */}
      {checklistOn && desk.id === 'ontology' && (
        <Fold title="Edit call script — Landlord Ops" board={board} hint="What Landlord Ops reads on every landlord call">
          <ScriptEditor desk="landlord_ops" />
        </Fold>
      )}
      {checklistOn && desk.id === 'ontology' && <EditResponsibilitiesFold board={board} />}
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
  const bp = useBreakpoint();
  const bannerInset = useAuthenticatorBannerInset();
  const navigate = useNavigate();

  const mine = (roles ?? []) as unknown as string[];
  // Desk roles first; with none, ask whether this account is a Service Centre person.
  const hasDeskRole = DESKS.some((d) => d.roles.some((r) => mine.includes(r)));
  const scScope = useMyScScope(!hasDeskRole && roles !== undefined);
  const base = desksFor(DESKS, mine, scScope.data);
  // HR's desk access, once the COO turns it on: only the desks HR gave this person.
  // Re-read every 2 minutes and on focus, so a removal lands without a re-login.
  const access = useMyDeskAccess();
  const accessEnforced = !!access.data?.enforced && !access.data.all;
  const allowed = desksByAccess(base.desks, DESKS, access.data);
  // The board-only view is for a Service Centre person with no other desk.
  const scOnly = base.scOnly && !(accessEnforced && allowed.some((d) => d.id !== 'service-centre'));
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

  // Wait for the access answer before showing any tab, so no one sees a desk they no longer have.
  if (access.isLoading || (allowed.length === 0 && !hasDeskRole && scScope.isLoading)) {
    return (
      <main className="desk-root min-h-screen px-4 py-16 text-center" data-desk-theme={rootTheme} aria-busy>
        <p className="text-sm text-muted-foreground">Opening your desk…</p>
      </main>
    );
  }

  if (allowed.length === 0 && accessEnforced) {
    return (
      <main className="desk-root min-h-screen px-4 py-16 text-center" data-desk-theme={rootTheme}>
        <div className="mx-auto max-w-xl space-y-2">
          <h1 className="text-xl font-semibold text-foreground">No desk assigned — ask HR</h1>
          <p className="text-sm text-muted-foreground">HR gives desks under People → Desks. Reload this page once they have.</p>
        </div>
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
  if (!desk) {
    // A desk that is not allowed (or was just removed) goes to the first allowed one.
    const to = accessEnforced ? accessLanding(allowed, access.data) ?? allowed[0] : landingDesk(mine, allowed);
    return <Navigate to={`/desk/${to.id}${board ? '?board=1' : ''}`} replace />;
  }

  const updated = Math.max(0, ...Object.values(feeds).map((f) => f.updatedAt || 0));
  const failed = Object.entries(feeds)
    .filter(([, f]) => f.error)
    .map(([k]) => k);

  const header = <DeskHeader desk={desk} allowed={allowed} updated={updated} failed={failed} board={board} bp={bp} />;

  if (board) {
    // A wall display: full bleed, one screen, 32px of air all round.
    return (
      <div className="desk-root flex h-[100dvh] min-w-0 flex-col gap-6 overflow-hidden px-4 py-6 sm:px-8" data-desk-theme="dark" data-desk-wall>
        {header}
        <div className="min-h-0 min-w-0 flex-1">
          <DeskView key={desk.id} desk={desk} feeds={feeds} board scOnly={scOnly} />
        </div>
      </div>
    );
  }

  return (
    <div className="desk-root min-h-screen" data-desk-theme={rootTheme} style={bannerInset ? ({ paddingBottom: bannerInset + 16, '--desk-banner-inset': `${bannerInset}px` } as CSSProperties) : undefined}>
      <main className={`mx-auto w-full min-w-0 max-w-[1440px] space-y-6 px-4 sm:px-8 ${atLeast(bp, 'md') ? 'py-6' : 'pb-6 pt-0'}`}>
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
