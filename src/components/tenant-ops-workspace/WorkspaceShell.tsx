import { lazy, Suspense, useState, type ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import { formatUGX } from '@/lib/rentCalculations';
import { WORKSPACE_NAV_SECTIONS, type WorkspaceSectionId } from './workspaceNav';

const SECTION_COMPONENTS: Record<WorkspaceSectionId, ComponentType> = {
  today: lazy(() => import('./sections/TodaySection')),
  collections: lazy(() => import('./sections/CollectionsSection')),
  calling: lazy(() => import('./sections/CallingSection')),
  tenants: lazy(() => import('./sections/TenantsSection')),
  agents: lazy(() => import('./sections/AgentsSection')),
  places: lazy(() => import('./sections/PlacesSection')),
  pipeline: lazy(() => import('./sections/PipelineSection')),
  weekly: lazy(() => import('./sections/WeeklySection')),
};

const DEFAULT_SECTION: WorkspaceSectionId = 'today';
const SECTION_IDS = new Set(WORKSPACE_NAV_SECTIONS.map((s) => s.id));

export interface WorkspaceShellProps {
  /** Money at risk per section, in UGX. A section with no entry shows no badge — filled in by later prompts. */
  moneyAtRiskBySection?: Partial<Record<WorkspaceSectionId, number>>;
  /**
   * True when mounted inside an existing page shell (e.g. the Tenant Ops
   * Hub's "Workspace" mode) that already owns the viewport, scroll and
   * padding. Drops `min-h-screen` so this component doesn't force its own
   * full-viewport height inside someone else's page. The standalone
   * /tenant-ops/workspace route omits this prop and renders exactly as
   * before.
   */
  embedded?: boolean;
}

export default function WorkspaceShell({ moneyAtRiskBySection, embedded = false }: WorkspaceShellProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const rawSection = searchParams.get('section');
  const activeSection: WorkspaceSectionId = SECTION_IDS.has(rawSection as WorkspaceSectionId)
    ? (rawSection as WorkspaceSectionId)
    : DEFAULT_SECTION;

  const selectSection = (id: WorkspaceSectionId) => {
    const next = new URLSearchParams(searchParams);
    next.set('section', id);
    setSearchParams(next);
  };

  const activeMeta = WORKSPACE_NAV_SECTIONS.find((s) => s.id === activeSection);
  const ActiveSection = SECTION_COMPONENTS[activeSection];

  const renderNavList = (onSelect?: () => void) => (
    <nav className="flex flex-col gap-1">
      {WORKSPACE_NAV_SECTIONS.map((section) => {
        const Icon = section.icon;
        const isActive = section.id === activeSection;
        const risk = moneyAtRiskBySection?.[section.id];
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => {
              selectSection(section.id);
              onSelect?.();
            }}
            aria-current={isActive ? 'page' : undefined}
            className={`flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
              isActive
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{section.label}</span>
            {risk !== undefined && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${
                  isActive ? 'bg-primary/15 text-primary' : 'bg-destructive/10 text-destructive'
                }`}
              >
                {formatUGX(risk)}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );

  return (
    <div className={`flex w-full flex-col md:flex-row ${embedded ? '' : 'min-h-screen'}`}>
      <aside className="hidden shrink-0 border-r bg-card px-3 py-4 md:block md:w-60">
        {renderNavList()}
      </aside>

      <div className="flex items-center justify-between gap-3 border-b bg-card px-3 py-2 md:hidden">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{activeMeta?.label}</p>
          <p className="truncate text-xs text-muted-foreground">{activeMeta?.description}</p>
        </div>
        <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-11 w-11 shrink-0"
            aria-label="Open workspace navigation"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <DrawerContent>
            <div className="px-4 pb-6 pt-2">{renderNavList(() => setDrawerOpen(false))}</div>
          </DrawerContent>
        </Drawer>
      </div>

      <main className="min-w-0 flex-1 p-3 sm:p-4">
        <Suspense
          key={activeSection}
          fallback={<div className="animate-pulse text-sm text-muted-foreground">Loading…</div>}
        >
          <ActiveSection />
        </Suspense>
      </main>
    </div>
  );
}
