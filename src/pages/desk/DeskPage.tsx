import { useEffect, type ReactNode } from 'react';
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Maximize2, Minimize2, Play, RefreshCw, Rows3, Square } from 'lucide-react';
import WelileLogo from '@/components/WelileLogo';
import { useAuth } from '@/hooks/useAuth';
import { DESKS, feedsOf, landingDesk, show, type Desk, type Getter } from './deskConfig';
import { useDeskFeeds, type FeedState } from './useDeskFeed';
import { DeskTable } from './DeskTable';
import { CommandCentre } from './CommandCentre';
import { TileGrid } from './Tiles';
import { SkeletonLead, SkeletonTiles } from './Skeleton';
import { DeskPrefsProvider, KampalaClock, clockTime, useDeskPrefs } from './deskPrefs';
import { CALM, FOCUS, statusText } from './deskTheme';

const ROTATE_MS = 45_000;

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
          : 'border-white/12 bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

function Toolbar({ updated, failed, board }: { updated: number; failed: string[]; board: boolean }) {
  const { setBoard, density, setDensity, rotate, setRotate } = useDeskPrefs();
  const queryClient = useQueryClient();
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="desk-pill inline-flex items-center gap-1.5 border border-[hsl(var(--desk-ok)/0.4)] bg-[hsl(var(--desk-ok)/0.12)] px-2.5 py-1">
        <span className="desk-live-dot h-1.5 w-1.5 rounded-full bg-[hsl(var(--desk-ok))]" aria-hidden />
        <span className="font-semibold tracking-wide text-[hsl(var(--desk-ok))]">LIVE</span>
      </span>

      <KampalaClock className={`${board ? 'text-base' : 'text-sm'} font-medium text-foreground`} />
      <span>Updated {clockTime(updated)}</span>

      <button
        type="button"
        onClick={() => queryClient.invalidateQueries({ queryKey: ['desk-feed'] })}
        className={`desk-pill inline-flex items-center gap-1.5 border border-white/12 bg-white/5 px-3 py-1.5 ${CALM} ${FOCUS} hover:bg-white/10 hover:text-foreground`}
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

function DeskView({ desk, feeds, board }: { desk: Desk; feeds: Record<string, FeedState>; board: boolean }) {
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
    return <CommandCentre feeds={feeds} board={board} tiles={tiles} />;
  }

  return (
    <div className={`space-y-5 ${board ? 'h-full overflow-auto' : ''}`}>
      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">{desk.question}</p>
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

      {desk.tables.map((spec) => (
        <DeskTable
          key={spec.id}
          spec={spec}
          board={board}
          feed={feeds[spec.feed] ?? { rows: [], loading: true, error: null, updatedAt: 0 }}
        />
      ))}
    </div>
  );
}

function DeskShell() {
  const { desk: deskId } = useParams();
  const { roles } = useAuth();
  const { board, rotate } = useDeskPrefs();
  const navigate = useNavigate();

  const mine = (roles ?? []) as unknown as string[];
  const allowed = DESKS.filter((d) => d.roles.some((r) => mine.includes(r)));
  const desk = allowed.find((d) => d.id === deskId);
  const feeds = useDeskFeeds(desk ? feedsOf(desk) : []);

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

  if (allowed.length === 0) {
    return (
      <main className="desk-root min-h-screen px-4 py-16 text-center">
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
    <header className={board ? 'shrink-0 space-y-2' : 'space-y-3'}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-3 min-w-0">
          <WelileLogo size="sm" showText={false} linkToHome={false} variant="light" />
          <div className="min-w-0">
            <h1 className={`${board ? 'text-2xl' : 'text-xl sm:text-2xl'} font-semibold tracking-tight text-foreground`}>
              Ops Command Centre
            </h1>
            <p className={`${board ? 'text-base' : 'text-sm'} text-[hsl(var(--desk-lavender))]`}>{desk.name}</p>
          </div>
        </div>
        <Toolbar updated={updated} failed={failed} board={board} />
      </div>

      {allowed.length > 1 && (
        <nav aria-label="Desks" className="-mx-1 flex gap-1 overflow-x-auto border-b border-white/10 pb-px">
          {allowed.map((d) => (
            <NavLink
              key={d.id}
              to={`/desk/${d.id}${board ? '?board=1' : ''}`}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-t px-3 py-2 ${board ? 'text-base' : 'text-sm'} border-b-2 -mb-px ${CALM} ${FOCUS} ${
                  isActive
                    ? 'border-[hsl(var(--primary))] text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`
              }
            >
              {d.name}
            </NavLink>
          ))}
        </nav>
      )}
    </header>
  );

  if (board) {
    return (
      <div className="desk-root flex h-[100dvh] flex-col gap-4 overflow-hidden p-5">
        {header}
        <div className="min-h-0 flex-1">
          <DeskView key={desk.id} desk={desk} feeds={feeds} board />
        </div>
      </div>
    );
  }

  return (
    <div className="desk-root min-h-screen">
      <main className="mx-auto w-full max-w-[1500px] px-3 sm:px-6 py-5 space-y-5">
        {header}
        <DeskView key={desk.id} desk={desk} feeds={feeds} board={false} />
      </main>
    </div>
  );
}

export default function DeskPage() {
  return (
    <DeskPrefsProvider>
      <DeskShell />
    </DeskPrefsProvider>
  );
}
