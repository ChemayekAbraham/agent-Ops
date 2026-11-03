import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Maximize2, Minimize2, Play, RefreshCw, Rows3, Square } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { DESKS, feedsOf, landingDesk, show, type Desk, type Getter } from './deskConfig';
import { useDeskFeeds, type FeedState } from './useDeskFeed';
import { DeskTable } from './DeskTable';
import { CommandCentre } from './CommandCentre';
import { TileGrid } from './Tiles';
import { SkeletonLead, SkeletonTiles } from './Skeleton';
import { DeskPrefsProvider, KampalaClock, clockTime, useDeskPrefs } from './deskPrefs';
import { BOARD_TOKENS, CALM, FOCUS, statusText } from './deskTheme';

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
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium ${CALM} ${FOCUS} ${
        active
          ? 'border-primary/50 bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
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
      {board && <KampalaClock className="text-sm font-medium text-foreground" />}
      <span>Updated {clockTime(updated)}. Refreshes every minute.</span>

      <button
        type="button"
        onClick={() => queryClient.invalidateQueries({ queryKey: ['desk-feed'] })}
        className={`inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 ${CALM} ${FOCUS} hover:bg-muted hover:text-foreground`}
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh now
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

      {failed.length > 0 && (
        <span className={statusText(board).bad}>Some figures could not load ({failed.join(', ')}).</span>
      )}
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

  // Board mode's command centre owns the whole screen so nothing has to scroll.
  if (desk.id === 'command' && board) {
    return <CommandCentre feeds={feeds} board tiles={tiles} g={g} />;
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

      {desk.id === 'command' && <CommandCentre feeds={feeds} board={false} tiles={tiles} g={g} />}

      {anyLoading && tiles.length > 0 ? (
        <SkeletonTiles count={tiles.length} board={board} />
      ) : (
        <TileGrid tiles={tiles} g={g} board={board} />
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
      <main className="mx-auto max-w-xl px-4 py-16 text-center space-y-2">
        <h1 className="text-xl font-semibold text-foreground">No desk for your account yet</h1>
        <p className="text-sm text-muted-foreground">
          Desks open for operations staff. Ask the COO office to confirm your role, then reload this page.
        </p>
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
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="space-y-0.5 min-w-0">
          <h1 className={`${board ? 'text-xl' : 'text-2xl'} font-semibold tracking-tight text-foreground`}>
            Welile ops desks
          </h1>
          <p className={`${board ? 'text-base' : 'text-sm'} text-muted-foreground`}>{desk.name}</p>
        </div>
        <Toolbar updated={updated} failed={failed} board={board} />
      </div>

      {allowed.length > 1 && (
        <nav aria-label="Desks" className="-mx-1 flex gap-1 overflow-x-auto border-b border-border pb-px">
          {allowed.map((d) => (
            <NavLink
              key={d.id}
              to={`/desk/${d.id}${board ? '?board=1' : ''}`}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-t px-3 py-2 ${board ? 'text-base' : 'text-sm'} border-b-2 -mb-px ${CALM} ${FOCUS} ${
                  isActive
                    ? 'border-primary text-foreground font-medium'
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
      <div
        style={BOARD_TOKENS as CSSProperties}
        className="flex h-[100dvh] flex-col gap-3 overflow-hidden bg-background p-5 text-foreground"
      >
        {header}
        <div className="min-h-0 flex-1">
          <DeskView key={desk.id} desk={desk} feeds={feeds} board />
        </div>
      </div>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1400px] px-3 sm:px-6 py-5 space-y-5">
      {header}
      <DeskView key={desk.id} desk={desk} feeds={feeds} board={false} />
    </main>
  );
}

export default function DeskPage() {
  return (
    <DeskPrefsProvider>
      <DeskShell />
    </DeskPrefsProvider>
  );
}
