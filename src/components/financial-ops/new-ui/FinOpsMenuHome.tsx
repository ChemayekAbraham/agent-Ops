import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Landmark, Search, X } from 'lucide-react';
import { FINOPS_MENU_GROUPS, FINOPS_MENU_TOTAL, finopsEntryHref } from './finopsMenu';

/**
 * Financial Ops menu in the mobile app's layout: a purple gradient header with a search box, then the sections grouped
 * in tiles. Each tile is a plain link to a tool the Command Center already opens, so this screen changes how people find
 * tools and nothing about the tools themselves.
 */
export default function FinOpsMenuHome() {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const groups = useMemo(
    () =>
      FINOPS_MENU_GROUPS.map((g) => ({
        ...g,
        entries: g.entries.filter((e) => !q || e.label.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q)),
      })).filter((g) => g.entries.length > 0),
    [q],
  );

  return (
    <div className="font-['DM_Sans',sans-serif]">
      {/* Gradient header: same colours as the mobile app's header */}
      <header
        className="relative overflow-hidden rounded-3xl px-5 pb-5 pt-6 text-white shadow-lg sm:px-8 sm:pb-7 sm:pt-8"
        style={{ background: 'linear-gradient(135deg, #4C158D 0%, #9234EA 100%)' }}
      >
        <div className="pointer-events-none absolute -right-10 -top-12 h-44 w-44 rounded-full bg-white/10" aria-hidden />
        <div className="pointer-events-none absolute -bottom-16 right-24 h-36 w-36 rounded-full bg-white/10" aria-hidden />
        <div className="relative flex items-center gap-3 sm:gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/20 sm:h-14 sm:w-14">
            <Landmark className="h-6 w-6 sm:h-7 sm:w-7" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold leading-tight sm:text-2xl">Financial Ops</h1>
            <p className="mt-0.5 text-xs text-white/80 sm:text-sm">Money in, payouts, merchant agents and the audit trail.</p>
          </div>
        </div>
        <label className="relative mt-4 block sm:mt-5 sm:max-w-xl">
          <span className="sr-only">Search Financial Ops sections</span>
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/80" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${FINOPS_MENU_TOTAL} sections`}
            className="h-11 w-full rounded-2xl border border-white/30 bg-white/15 pl-10 pr-10 text-sm text-white placeholder:text-white/70 focus:border-white/70 focus:outline-none focus:ring-2 focus:ring-white/40 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-white hover:bg-white/20"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </label>
      </header>

      {groups.length === 0 && <p className="mt-6 px-1 text-sm text-muted-foreground">No section matches “{query}”.</p>}

      {groups.map((group) => (
        <section key={group.title} className="mt-6" aria-label={group.title}>
          <div className="mb-2.5 flex items-center gap-2 px-1">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-primary">{group.title}</h2>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">{group.entries.length}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {group.entries.map((e) => {
              const Icon = e.icon;
              return (
                <Link
                  key={`${group.title}-${e.id}`}
                  to={finopsEntryHref(e)}
                  className="group flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-3.5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-bold leading-tight text-foreground">{e.label}</span>
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-muted-foreground">{e.desc}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
                </Link>
              );
            })}
          </div>
        </section>
      ))}

    </div>
  );
}
