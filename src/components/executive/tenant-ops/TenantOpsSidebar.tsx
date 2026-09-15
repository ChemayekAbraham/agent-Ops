import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  TENANT_OPS_NAV,
  tenantOpsGroupForView,
  type TenantOpsActionKey,
  type TenantOpsViewKey,
} from './tenantOpsNav';

interface Props {
  active: TenantOpsViewKey | TenantOpsActionKey;
  onSelect: (key: TenantOpsViewKey | TenantOpsActionKey) => void;
  badges?: Partial<Record<string, number>>;
  className?: string;
}

/**
 * Tenant Ops sidebar — same structure, spacing and active treatment as the
 * Partner Ops sidebar, with expandable groups (Tenant Ops Tools, Workspaces…).
 */
export function TenantOpsSidebar({ active, onSelect, badges = {}, className }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({
    verification: true,
    tools: true,
    workspaces: true,
    reports: false,
  }));

  // Keep the group holding the active view expanded (e.g. after a deep link).
  useEffect(() => {
    const group = tenantOpsGroupForView(String(active));
    if (group) setOpen((prev) => (prev[group] ? prev : { ...prev, [group]: true }));
  }, [active]);

  const Badge = ({ n }: { n?: number }) =>
    n && n > 0 ? (
      <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-bold leading-none text-destructive lg:px-1.5 lg:py-0.5 lg:text-[9px]">
        {n}
      </span>
    ) : null;

  return (
    <nav className={cn('flex h-full flex-col', className)} aria-label="Tenant Ops sections">
      <ScrollArea className="flex-1">
        <ul className="space-y-1 p-2">
          {TENANT_OPS_NAV.map((item, index) => {
            const Icon = item.icon;
            const key = String(item.key);
            const isLast = index === TENANT_OPS_NAV.length - 1;
            const expanded = !!open[key];

            return (
              <li key={key} className="pb-2">
                {!item.children?.length ? (
                  <button
                    type="button"
                    onClick={() => onSelect((item.view || key) as TenantOpsViewKey)}
                    aria-current={active === (item.view || key) ? 'page' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-3 py-3 text-sm font-medium transition-colors lg:px-2.5 lg:py-2 lg:text-xs',
                      active === (item.view || key)
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'
                    )}
                  >
                    <Icon className="h-5 w-5 shrink-0 lg:h-4 lg:w-4" />
                    <span className="truncate">{item.label}</span>
                    <Badge n={badges[item.view || key]} />
                  </button>
                ) : (
                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() => setOpen((prev) => ({ ...prev, [key]: !prev[key] }))}
                      aria-expanded={expanded}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-primary/5 hover:text-primary lg:px-2.5 lg:py-2 lg:text-xs"
                    >
                      <Icon className="h-5 w-5 shrink-0 lg:h-4 lg:w-4" />
                      <span className="truncate">{item.label}</span>
                      {expanded ? (
                        <ChevronDown className="ml-auto h-4 w-4 shrink-0 lg:h-3.5 lg:w-3.5" />
                      ) : (
                        <ChevronRight className="ml-auto h-4 w-4 shrink-0 lg:h-3.5 lg:w-3.5" />
                      )}
                    </button>
                    {expanded && (
                      <ul className="space-y-0.5">
                        {item.children.map((child) => {
                          const ChildIcon = child.icon;
                          const isActive = active === child.key;
                          return (
                            <li key={child.key}>
                              <button
                                type="button"
                                onClick={() => onSelect(child.key)}
                                aria-current={isActive ? 'page' : undefined}
                                className={cn(
                                  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-colors lg:px-2.5 lg:py-1.5 lg:text-xs',
                                  isActive
                                    ? 'bg-primary/10 font-semibold text-primary'
                                    : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'
                                )}
                              >
                                <ChildIcon className="h-4 w-4 shrink-0 lg:h-3.5 lg:w-3.5" />
                                <span className="truncate">{child.label}</span>
                                <Badge n={badges[child.key]} />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
                {!isLast && <div className="mt-2 h-px bg-border/60" />}
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </nav>
  );
}
