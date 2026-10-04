import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  PARTNER_OPS_NAV,
  type PartnerOpsViewKey,
} from './partnerOpsNav';

interface Props {
  active: PartnerOpsViewKey;
  onSelect: (view: PartnerOpsViewKey) => void;
  badges?: Partial<Record<PartnerOpsViewKey, number>>;
  className?: string;
}

export function PartnerOpsSidebar({ active, onSelect, badges = {}, className }: Props) {
  const Badge = ({ n }: { n?: number }) =>
    n && n > 0 ? (
      <span className="ml-auto rounded-full bg-destructive/15 px-1.5 py-0.5 text-[9px] font-bold leading-none text-destructive">
        {n}
      </span>
    ) : null;

  return (
    <nav className={cn('flex h-full flex-col', className)} aria-label="Partner Ops sections">
      <ScrollArea className="flex-1">
        <ul className="space-y-1 p-2">
          {PARTNER_OPS_NAV.map((item, index) => {
            const Icon = item.icon;
            const key = String(item.key);
            const isLast = index === PARTNER_OPS_NAV.length - 1;

            return (
              <li key={key} className="pb-2">
                {!item.children?.length ? (
                  <button
                    type="button"
                    onClick={() => onSelect((item.view || key) as PartnerOpsViewKey)}
                    aria-current={active === (item.view || key) ? 'page' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors',
                      active === (item.view || key)
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                    <Badge n={badges[(item.view || key) as PartnerOpsViewKey]} />
                  </button>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 px-2.5 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-primary">
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </div>
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
                                'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors',
                                isActive
                                  ? 'bg-primary/10 font-semibold text-primary'
                                  : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'
                              )}
                            >
                              <ChildIcon className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{child.label}</span>
                              <Badge n={badges[child.key]} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
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