import { Link } from 'react-router-dom';
import { RefreshCw, Search, SlidersHorizontal, X, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Presentation-only page header for the Email Transactions "Table" layout:
 * breadcrumb + title + sync pill, four summary tiles, the search card (search,
 * date window, more filters) and the saved-views chip row.
 *
 * It owns no data. Every number, handler and filter comes from
 * useEmailTransactionsPanel through EmailTransactionsPanel, so nothing here can
 * move money or recompute a figure.
 */

export type MockupLayout = 'table' | 'gmail' | 'ops';

export interface MockupView {
  key: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}

export interface EmailTransactionsMockupHeaderProps {
  tiles: { all: number; credited: number; routing: number; unparsed: number };
  periodLabel: string;
  syncedLabel: string | null;
  syncFailed: boolean;
  loading: boolean;
  onRefresh: () => void;

  searchQuery: string;
  setSearchQuery: (v: string) => void;
  activeDays: number | null;
  onWindow: (days: number) => void;
  moreFiltersOpen: boolean;
  onToggleMoreFilters: () => void;

  views: MockupView[];
  presets: Array<{ id: string; name: string; active: boolean }>;
  onApplyPreset: (id: string) => void;
  onDeletePreset: (id: string) => void;
  presetSaveOpen: boolean;
  onTogglePresetSave: () => void;
  presetNameDraft: string;
  setPresetNameDraft: (v: string) => void;
  onSavePreset: () => void;

  layout: MockupLayout;
  onLayout: (l: MockupLayout) => void;
  onAnalytics: () => void;
  onDiagnostics: () => void;
}

const WINDOWS: Array<{ label: string; short: string; days: number }> = [
  { label: 'Today', short: 'Today', days: 1 },
  { label: 'Last 7 days', short: '7 days', days: 7 },
  { label: 'Last 30 days', short: '30 days', days: 30 },
];

function Tile({ value, label, hint, className = '' }: { value: number; label: string; hint: string; className?: string }) {
  return (
    <div className={`rounded-2xl border bg-card px-4 py-3.5 sm:px-5 sm:py-4 ${className}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold tracking-tight tabular-nums sm:text-3xl">{value.toLocaleString()}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

export function EmailTransactionsMockupHeader(p: EmailTransactionsMockupHeaderProps) {
  return (
    <div className="space-y-4">
      {/* Title row */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
            <Link to="/admin/financial-ops?hub=1" className="hover:underline">Financial Ops</Link>
            <span aria-hidden="true"> / </span>
            <span>Email Transactions</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Email Transactions</h1>
          <p className="hidden text-sm text-muted-foreground sm:block">Live transactions extracted from connected Gmail</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {(p.syncedLabel || p.syncFailed) && (
            <span
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ${p.syncFailed
                  ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300'
                  : 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
                }`}
            >
              <span aria-hidden="true" className={`h-2 w-2 rounded-full ${p.syncFailed ? 'bg-amber-500' : 'bg-emerald-500'}`} />
              {p.syncFailed ? 'Could not sync' : `Synced ${p.syncedLabel}`}
            </span>
          )}
          <Button variant="outline" onClick={p.onRefresh} disabled={p.loading} className="hidden h-10 rounded-xl sm:inline-flex">
            <RefreshCw className={`mr-2 h-4 w-4 ${p.loading ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={p.onRefresh}
            disabled={p.loading}
            aria-label="Refresh"
            className="h-10 w-10 rounded-xl sm:hidden"
          >
            <RefreshCw className={`h-4 w-4 ${p.loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          </Button>
        </div>
      </header>

      {/* Summary tiles: three on a phone, four from sm up */}
      <section aria-label="Summary" className="grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4">
        <Tile value={p.tiles.all} label={`Emails ${p.periodLabel}`} hint="Read from connected Gmail" />
        <Tile value={p.tiles.credited} label="Credited" hint="Matched and paid in" className="hidden sm:block" />
        <Tile value={p.tiles.routing} label="Awaiting routing" hint="Need a wallet match" />
        <Tile value={p.tiles.unparsed} label="Could not read" hint="A person needs to look" />
      </section>

      {/* Search card */}
      <section aria-label="Search and filters" className="space-y-3 rounded-2xl border bg-card p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-60">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={p.searchQuery}
              onChange={(e) => p.setSearchQuery(e.target.value)}
              placeholder="Search mail — amount, name, phone, transaction id…"
              aria-label="Search mail"
              className="h-11 w-full rounded-xl border bg-muted/40 pl-10 pr-10 text-sm placeholder:text-muted-foreground/70 focus:bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {p.searchQuery && (
              <button
                type="button"
                onClick={() => p.setSearchQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div role="group" aria-label="Date range" className="hidden items-center gap-0.5 rounded-xl bg-muted/60 p-1 sm:flex">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                type="button"
                aria-pressed={p.activeDays === w.days}
                onClick={() => p.onWindow(w.days)}
                className={`h-9 rounded-lg px-3.5 text-sm transition-colors ${p.activeDays === w.days ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
              >
                {w.label}
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            onClick={p.onToggleMoreFilters}
            aria-expanded={p.moreFiltersOpen}
            className="hidden h-11 rounded-xl sm:inline-flex"
          >
            <SlidersHorizontal className="mr-2 h-4 w-4" aria-hidden="true" /> More filters
          </Button>
        </div>

        {/* Phone: one scrolling chip row — date windows, then saved views */}
        <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-0.5 sm:hidden">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              aria-pressed={p.activeDays === w.days}
              onClick={() => p.onWindow(w.days)}
              className={`shrink-0 rounded-full border px-4 py-2 text-sm ${p.activeDays === w.days ? 'border-primary bg-primary font-medium text-primary-foreground' : 'bg-background text-foreground'
                }`}
            >
              {w.short}
            </button>
          ))}
          <button
            type="button"
            onClick={p.onToggleMoreFilters}
            aria-expanded={p.moreFiltersOpen}
            className="shrink-0 rounded-full border bg-background px-4 py-2 text-sm"
          >
            More filters
          </button>
        </div>

        {/* Saved views */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div role="group" aria-label="Saved views" className="flex min-w-0 items-center gap-2 overflow-x-auto pb-0.5">
            <span className="shrink-0 text-xs text-muted-foreground">Saved views</span>
            {p.views.map((v) => (
              <button
                key={v.key}
                type="button"
                aria-pressed={v.active}
                onClick={v.onSelect}
                className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm transition-colors ${v.active ? 'border-primary bg-primary font-medium text-primary-foreground' : 'bg-background hover:bg-muted'
                  }`}
              >
                {v.label}
              </button>
            ))}
            {p.presets.map((s) => (
              <span
                key={s.id}
                className={`inline-flex shrink-0 items-center gap-1 rounded-full border py-1.5 pl-3.5 pr-2 text-sm ${s.active ? 'border-primary bg-primary text-primary-foreground' : 'bg-background'
                  }`}
              >
                <button type="button" aria-pressed={s.active} onClick={() => p.onApplyPreset(s.id)} className="max-w-[140px] truncate">
                  {s.name}
                </button>
                <button
                  type="button"
                  onClick={() => p.onDeletePreset(s.id)}
                  aria-label={`Delete saved view ${s.name}`}
                  className="rounded-full p-0.5 opacity-70 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={p.onTogglePresetSave}
              aria-expanded={p.presetSaveOpen}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed px-3.5 py-1.5 text-sm text-muted-foreground hover:bg-muted"
            >
              <Star className="h-3.5 w-3.5" aria-hidden="true" /> Save this view
            </button>
          </div>

          {/* Layout + the two other workspaces. Quiet, so the table stays the focus. */}
          <div className="flex shrink-0 items-center gap-2 overflow-x-auto">
            <div role="group" aria-label="Layout" className="flex items-center gap-0.5 rounded-full bg-muted/60 p-0.5">
              {([
                { key: 'table', label: 'Table' },
                { key: 'gmail', label: 'Inbox' },
                { key: 'ops', label: 'Ops' },
              ] as const).map((l) => (
                <button
                  key={l.key}
                  type="button"
                  aria-pressed={p.layout === l.key}
                  onClick={() => p.onLayout(l.key)}
                  className={`h-8 rounded-full px-3 text-xs font-medium transition-colors ${p.layout === l.key ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground" onClick={p.onAnalytics}>Analytics</Button>
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground" onClick={p.onDiagnostics}>Diagnostics</Button>
          </div>
        </div>

        {p.presetSaveOpen && (
          <div className="flex items-center gap-2">
            <Input
              value={p.presetNameDraft}
              onChange={(e) => p.setPresetNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') p.onSavePreset(); }}
              placeholder="Name this view (e.g. Needs routing)"
              aria-label="Saved view name"
              className="h-9 max-w-xs text-sm"
            />
            <Button size="sm" className="h-9" onClick={p.onSavePreset} disabled={!p.presetNameDraft.trim()}>Save</Button>
          </div>
        )}
      </section>
    </div>
  );
}
