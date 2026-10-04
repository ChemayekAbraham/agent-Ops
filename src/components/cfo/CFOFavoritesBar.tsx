import { Star, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';
import { executiveSidebarConfig } from '@/components/layout/executiveSidebarConfig';
import { useFavoriteSections } from '@/hooks/useFavoriteSections';

// Lookup of section id -> { label, icon } from the CFO sidebar (route items excluded).
const SECTION_LOOKUP = Object.fromEntries(
  (executiveSidebarConfig.cfo ?? [])
    .flatMap((section) => section.items)
    .filter((item) => !item.route)
    .map((item) => [item.id, { label: item.label, icon: item.icon }]),
);

/**
 * Mobile-only favorites/shortcuts bar. Users pin the sections they use most
 * (star toggle for the current section) and jump to them with one tap from the
 * top of the dashboard. Favorites persist per-device.
 */
export function CFOFavoritesBar({
  activeTab,
  onJump,
}: {
  activeTab: string;
  onJump: (tab: string) => void;
}) {
  const { favorites, isFavorite, toggleFavorite, removeFavorite } = useFavoriteSections('cfo');
  const activeMeta = SECTION_LOOKUP[activeTab];
  const activePinned = isFavorite(activeTab);
  const pinned = favorites.filter((id) => SECTION_LOOKUP[id]);

  return (
    <div className="sm:hidden -mx-2 mb-3 border-b border-border bg-amber-50/60 dark:bg-amber-950/20">
      <div className="flex items-center gap-2 px-2 py-2">
        {/* Pin / unpin the current section */}
        {activeMeta && (
          <button
            type="button"
            onClick={() => {
              hapticTap();
              toggleFavorite(activeTab);
            }}
            aria-pressed={activePinned}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap shrink-0 border transition-colors active:scale-95 touch-manipulation',
              activePinned
                ? 'bg-amber-500 text-white border-amber-500'
                : 'bg-background text-foreground border-amber-400/60',
            )}
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <Star className={cn('h-3.5 w-3.5 shrink-0', activePinned && 'fill-current')} />
            {activePinned ? 'Pinned' : 'Pin this'}
          </button>
        )}

        <span className="h-6 w-px bg-amber-400/40 shrink-0" aria-hidden />

        {/* Favorite shortcuts */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
          {pinned.length === 0 ? (
            <span className="text-[11px] text-muted-foreground whitespace-nowrap">
              Tap “Pin this” to save shortcuts here
            </span>
          ) : (
            pinned.map((id) => {
              const meta = SECTION_LOOKUP[id];
              const Icon = meta.icon;
              const isActive = activeTab === id;
              return (
                <span
                  key={id}
                  className={cn(
                    'flex items-center rounded-full text-xs font-semibold whitespace-nowrap shrink-0 border transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-foreground border-border',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      hapticTap();
                      onJump(id);
                    }}
                    className="flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 active:scale-95 touch-manipulation"
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    {meta.label}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      hapticTap();
                      removeFavorite(id);
                    }}
                    aria-label={`Remove ${meta.label} shortcut`}
                    className="pr-2 pl-0.5 py-1.5 opacity-70 hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
