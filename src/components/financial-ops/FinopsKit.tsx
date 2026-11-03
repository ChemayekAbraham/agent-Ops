import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';

/**
 * Shared building blocks for the Financial Ops tool pages, so every page has
 * the same header, stat tiles and pager. Presentation only.
 */

export type FinopsTone = 'primary' | 'amber' | 'rose' | 'emerald' | 'sky' | 'muted';

const ICON_BOX: Record<FinopsTone, string> = {
  primary: 'bg-primary/10 text-primary border-primary/20',
  amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25',
  rose: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/25',
  emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25',
  sky: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/25',
  muted: 'bg-muted text-muted-foreground border-border',
};

export function PageHeader({
  icon: Icon, tone = 'primary', title, description, actions, titleId,
}: {
  icon: LucideIcon;
  tone?: FinopsTone;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  titleId?: string;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3 min-w-0">
        <span className={`h-11 w-11 rounded-xl border flex items-center justify-center shrink-0 ${ICON_BOX[tone]}`}>
          <Icon className="h-6 w-6" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 id={titleId} className="text-xl sm:text-2xl font-black tracking-tight text-foreground">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground max-w-3xl">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}

export function StatTile({
  icon: Icon, tone = 'primary', label, value, note, active, onClick,
}: {
  icon: LucideIcon;
  tone?: FinopsTone;
  label: string;
  value: ReactNode;
  note?: string;
  /** Marks a tile that is currently acting as the selected filter. */
  active?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className={`h-11 w-11 rounded-xl border flex items-center justify-center shrink-0 ${ICON_BOX[tone]}`}>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 text-left">
        <span className="block text-xs font-medium text-muted-foreground">{label}</span>
        <span className="block text-2xl font-black tabular-nums leading-tight text-foreground">{value}</span>
        {note && <span className="block text-xs text-muted-foreground">{note}</span>}
      </span>
    </>
  );
  const cls = `flex items-center gap-3 rounded-2xl border bg-card p-3.5 shadow-2xs min-w-0 ${
    active ? 'border-primary ring-1 ring-primary/40' : 'border-border'
  }`;
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${cls} transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
    >
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** The set of page numbers to show: first, last, and a window around the current one. */
function pageWindow(current: number, count: number): Array<number | 'gap'> {
  const wanted = new Set<number>([1, count, current - 1, current, current + 1]);
  if (current <= 3) { wanted.add(2); wanted.add(3); wanted.add(4); wanted.add(5); }
  const sorted = [...wanted].filter((n) => n >= 1 && n <= count).sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) out.push('gap');
    out.push(n);
  });
  return out;
}

/** "Showing 1–20 of 32 results" with numbered pages. `page` is zero-based. */
export function Pager({
  page, pageSize, total, onPage, noun = 'results',
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  noun?: string;
}) {
  const count = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  const btn = 'h-10 min-w-10 px-2 rounded-lg border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 text-sm" aria-label="Pages">
      <p className="text-muted-foreground" role="status">
        Showing {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()} {noun}
      </p>
      {count > 1 && (
        <div className="flex items-center gap-1.5">
          <button
            type="button" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page"
            className={`${btn} bg-background hover:bg-muted disabled:opacity-40`}
          >
            <ChevronLeft className="h-4 w-4 mx-auto" aria-hidden="true" />
          </button>
          {pageWindow(page + 1, count).map((n, i) =>
            n === 'gap' ? (
              <span key={`g${i}`} className="px-1 text-muted-foreground" aria-hidden="true">…</span>
            ) : (
              <button
                key={n} type="button" onClick={() => onPage(n - 1)}
                aria-current={n === page + 1 ? 'page' : undefined}
                className={`${btn} ${n === page + 1 ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'}`}
              >
                {n}
              </button>
            ),
          )}
          <button
            type="button" disabled={page >= count - 1} onClick={() => onPage(page + 1)} aria-label="Next page"
            className={`${btn} bg-background hover:bg-muted disabled:opacity-40`}
          >
            <ChevronRight className="h-4 w-4 mx-auto" aria-hidden="true" />
          </button>
        </div>
      )}
    </nav>
  );
}
