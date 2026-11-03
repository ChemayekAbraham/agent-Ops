import { Navigate, NavLink, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { DESKS, feedsOf, landingDesk, show, type Desk, type Getter } from './deskConfig';
import { useDeskFeeds } from './useDeskFeed';
import { DeskTable } from './DeskTable';

function DeskView({ desk }: { desk: Desk }) {
  const feeds = useDeskFeeds(feedsOf(desk));
  const queryClient = useQueryClient();
  const g: Getter = (ref) => (feeds[ref.feed]?.loading ? '…' : show(feeds[ref.feed]?.rows ?? [], ref));
  const updated = Math.max(0, ...Object.values(feeds).map((f) => f.updatedAt || 0));
  const failed = Object.entries(feeds).filter(([, f]) => f.error);
  const tiles = desk.tiles.filter((t) => !(t.feed === 'coo_kpis' && (feeds.coo_kpis?.rows ?? []).length > 0 && !(feeds.coo_kpis.rows).some((r) => r.metric === t.where?.[1])));

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{desk.question}</p>
        <p className="text-lg sm:text-xl leading-snug text-foreground max-w-4xl">{desk.lead(g)}</p>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>{updated ? `Updated ${new Date(updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Refreshes every minute.` : 'Loading live data.'}</span>
          <button type="button" onClick={() => queryClient.invalidateQueries({ queryKey: ['desk-feed'] })}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh now
          </button>
          {failed.length > 0 && <span className="text-red-700 dark:text-red-400">Some figures could not load ({failed.map(([k]) => k).join(', ')}).</span>}
        </div>
      </div>

      {tiles.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-lg border border-border bg-card p-4 space-y-1 min-w-0">
              <div className="text-xs text-muted-foreground">{t.label}</div>
              <div className="text-2xl font-semibold tabular-nums text-foreground">{g(t)}</div>
              {t.sub && <div className="text-xs text-muted-foreground">{t.sub.label}: <span className="tabular-nums text-foreground">{g(t.sub)}</span></div>}
            </div>
          ))}
        </div>
      )}

      {desk.tables.map((spec) => (
        <DeskTable key={spec.id} spec={spec} feed={feeds[spec.feed] ?? { rows: [], loading: true, error: null, updatedAt: 0 }} />
      ))}
    </div>
  );
}

export default function DeskPage() {
  const { desk: deskId } = useParams();
  const { roles } = useAuth();
  const mine = (roles ?? []) as unknown as string[];
  const allowed = DESKS.filter((d) => d.roles.some((r) => mine.includes(r)));

  if (allowed.length === 0) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center space-y-2">
        <h1 className="text-xl font-semibold">No desk for your account yet</h1>
        <p className="text-sm text-muted-foreground">Desks open for operations staff. Ask the COO office to confirm your role.</p>
      </main>
    );
  }
  const desk = allowed.find((d) => d.id === deskId);
  if (!desk) return <Navigate to={`/desk/${landingDesk(mine, allowed).id}`} replace />;

  return (
    <main className="mx-auto w-full max-w-[1400px] px-3 sm:px-6 py-5 space-y-5">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{desk.name} desk</h1>
        {allowed.length > 1 && (
          <nav aria-label="Desks" className="-mx-1 flex gap-1 overflow-x-auto border-b border-border pb-px">
            {allowed.map((d) => (
              <NavLink key={d.id} to={`/desk/${d.id}`}
                className={({ isActive }) => `whitespace-nowrap px-3 py-2 text-sm border-b-2 -mb-px focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-t ${isActive ? 'border-foreground text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                {d.name}
              </NavLink>
            ))}
          </nav>
        )}
      </header>
      <DeskView key={desk.id} desk={desk} />
    </main>
  );
}
