import { ArrowLeft, Check, ChevronLeft, ChevronRight, Home, Link2 } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { executiveSidebarConfig } from '@/components/layout/executiveSidebarConfig';

// id -> { group, label, icon } from the CFO sidebar (route items excluded).
const SECTION_LOOKUP = Object.fromEntries(
  (executiveSidebarConfig.cfo ?? []).flatMap((section) =>
    section.items
      .filter((item) => !item.route)
      .map((item) => [item.id, { group: section.title, label: item.label, icon: item.icon }]),
  ),
);

/**
 * Breadcrumb header that always shows where the CFO is while drilling into
 * sections. Renders "Dashboard › Group › Section" — the Dashboard crumb jumps
 * back to the overview. Optimised for phones (sticky, single line, truncating).
 */
export function CFOBreadcrumbHeader({
  activeTab,
  onJump,
  position,
  onPrev,
  onNext,
  actions,
}: {
  activeTab: string;
  onJump: (tab: string) => void;
  /** 1-based index and total of swipeable sections, for the pager + announcer. */
  position?: { index: number; total: number };
  onPrev?: () => void;
  onNext?: () => void;
  /** Optional trailing controls (e.g. swipe sensitivity). */
  actions?: ReactNode;
}) {
  const meta = SECTION_LOOKUP[activeTab];
  const isOverview = !meta || activeTab === 'overview';
  const Icon = meta?.icon;

  const hasPager = !!position && !!onPrev && !!onNext;
  const atFirst = position ? position.index <= 1 : true;
  const atLast = position ? position.index >= position.total : true;
  const sectionLabel = isOverview ? 'Dashboard' : meta?.label ?? 'Dashboard';

  const [copied, setCopied] = useState(false);

  const handleCopyLink = async () => {
    hapticTap();
    const url = new URL(window.location.pathname, getPublicOrigin());
    if (!isOverview) url.searchParams.set('section', activeTab);
    const link = url.toString();
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success('Section link copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy link');
    }
  };

  return (
    <nav
      aria-label="Breadcrumb"
      className="-mx-2 sm:-mx-4 lg:-mx-6 mb-1 bg-card border-b border-border"
    >
      {/* Screen-reader live announcement of the current section + position. */}
      <p aria-live="polite" className="sr-only">
        {position
          ? `${sectionLabel}, section ${position.index} of ${position.total}`
          : sectionLabel}
      </p>
      <div className="flex items-center gap-1 px-2 sm:px-4 lg:px-6 py-2">
        {!isOverview && (
          <button
            type="button"
            onClick={() => {
              hapticTap();
              onJump('overview');
            }}
            aria-label="Back to dashboard overview"
            className="mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <ol className="flex flex-1 items-center gap-1 text-sm overflow-x-auto no-scrollbar">
        <li className="shrink-0">
          <button
            type="button"
            onClick={() => {
              hapticTap();
              onJump('overview');
            }}
            className={cn(
              'flex items-center gap-1 font-medium transition-colors',
              isOverview ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Home className="h-3.5 w-3.5 shrink-0" />
            Dashboard
          </button>
        </li>

        {isOverview && (
          <>
            <li aria-hidden className="shrink-0 text-muted-foreground/60">
              <ChevronRight className="h-3.5 w-3.5" />
            </li>
            <li aria-current="page" className="shrink-0 font-semibold text-foreground">
              Overview
            </li>
          </>
        )}

        {!isOverview && meta && (
          <>
            <li aria-hidden className="shrink-0 text-muted-foreground/60">
              <ChevronRight className="h-3.5 w-3.5" />
            </li>
            <li className="shrink-0 text-muted-foreground whitespace-nowrap hidden sm:inline">
              {meta.group}
            </li>
            <li aria-hidden className="shrink-0 text-muted-foreground/60 hidden sm:inline">
              <ChevronRight className="h-3.5 w-3.5" />
            </li>
            <li
              aria-current="page"
              className="flex items-center gap-1.5 font-semibold text-foreground min-w-0"
            >
              {Icon && <Icon className="h-4 w-4 shrink-0 text-primary" />}
              <span className="truncate">{meta.label}</span>
            </li>
          </>
        )}
        </ol>

        <div className="flex shrink-0 items-center gap-2 pl-2">
            {hasPager && (
              <>
            <button
              type="button"
              onClick={() => {
                hapticTap();
                onPrev?.();
              }}
              disabled={atFirst}
              aria-label="Previous dashboard section"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:pointer-events-none"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                hapticTap();
                onNext?.();
              }}
              disabled={atLast}
              aria-label="Next dashboard section"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:pointer-events-none"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            {position && (
              <span aria-hidden className="hidden sm:inline text-xs text-muted-foreground tabular-nums">
                {position.index} of {position.total}
              </span>
            )}
            <span aria-hidden className="hidden sm:inline h-6 w-px bg-border" />
              </>
            )}
            <button
              type="button"
              onClick={handleCopyLink}
              aria-label="Copy section link"
              title="Copy link to this section"
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {copied ? <Check className="h-4 w-4 text-success" /> : <Link2 className="h-4 w-4" />}
              <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy link'}</span>
            </button>
            {actions}
        </div>
      </div>
    </nav>
  );
}
