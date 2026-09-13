import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { LANDLORD_OPS_SECTIONS, type LandlordOpsNavItem } from './landlordOpsNav';

interface SidebarProps {
  activePath: string;
  onNavigate: (path: string) => void;
  badges?: Record<string, number>;
  className?: string;
}

export function LandlordOpsSidebar({ activePath, onNavigate, badges = {}, className }: SidebarProps) {
  const cleanActive = activePath.replace(/^\//, '').replace(/^landlord-ops\/?/, '');

  return (
    <nav className={cn('w-full lg:w-60 shrink-0 border-r border-border bg-card flex flex-col h-full text-sm lg:text-xs select-none', className)}>
      <ScrollArea className="flex-1 py-3 px-3 lg:px-2.5">
        <div className="space-y-4">
          {LANDLORD_OPS_SECTIONS.map((section, idx) => (
            <div key={section.title || `section-${idx}`} className="space-y-0.5">
              {section.title && (
                <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
                  {section.title}
                </div>
              )}
              <div className="space-y-0.5">
                {section.items.map((item: LandlordOpsNavItem) => {
                  const Icon = item.icon;
                  const isActive = cleanActive === item.path || (item.path === '' && cleanActive === 'today');
                  const count = item.badgeKey ? badges[item.badgeKey] : undefined;

                  return (
                    <button
                      key={item.key}
                      onClick={() => onNavigate(item.path)}
                      className={cn(
                        'flex min-h-11 w-full items-center justify-between rounded-lg px-3 py-2.5 font-medium transition-all group text-left lg:min-h-0 lg:px-2.5 lg:py-1.5',
                        isActive
                          ? 'bg-[#E8F8EE] text-[#0FA958] dark:bg-emerald-950/50 dark:text-emerald-400 font-bold shadow-xs'
                          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      )}
                    >
                      <div className="flex items-center gap-2.5 truncate">
                        <Icon
                          className={cn(
                            'h-4 w-4 shrink-0 transition-colors',
                            isActive ? 'text-[#0FA958] dark:text-emerald-400' : 'text-muted-foreground group-hover:text-foreground'
                          )}
                        />
                        <span className="truncate">{item.label}</span>
                      </div>

                      {count && count > 0 ? (
                        <span
                          className={cn(
                            'px-1.5 py-0.2 rounded-full text-[9px] font-bold tabular-nums shrink-0',
                            isActive
                              ? 'bg-[#0FA958] text-white'
                              : 'bg-muted text-muted-foreground group-hover:bg-muted-foreground/20'
                          )}
                        >
                          {count > 999 ? `${Math.round(count / 1000)}k` : count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </nav>
  );
}
