/**
 * Combined view of every selected place: tenants grouped under a heading per
 * place, with counts. Uses the full server result (each tenant once, under the
 * most specific selected place) and the page's All / Active / Inactive filter.
 */
import { useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTlbTenantsMulti, type TlbSelectedPlace, type TlbStatus } from '@/hooks/useTenantLocationsBrowser';
import { groupTenantsByPlace } from '@/lib/tenantLocationSelection';
import { TenantLocationTenantRow } from './TenantLocationTenantRow';

const SECTION_PAGE = 100;

interface Props {
  places: readonly TlbSelectedPlace[];
  status: TlbStatus;
  onRemovePlace: (key: string) => void;
  onSelectTenant?: (tenantId: string, tenantName: string) => void;
}

export function TenantLocationsCombinedView({ places, status, onRemovePlace, onSelectTenant }: Props) {
  const { data, isLoading, isFetching, error } = useTlbTenantsMulti(places, status, true);
  const [shown, setShown] = useState<Record<string, number>>({});

  const report = useMemo(() => groupTenantsByPlace(places, data?.rows ?? []), [places, data]);

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (error) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-destructive" role="alert">
          The selected places could not be loaded. Please try again.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="tlb-combined-view">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          Selected places
        </p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          <span>
            {report.grand.total.toLocaleString('en-UG')} tenants · {report.grand.active.toLocaleString('en-UG')} active ·{' '}
            {report.grand.inactive.toLocaleString('en-UG')} inactive
          </span>
        </div>
      </div>

      {report.sections.map((section) => {
        const limit = shown[section.place.key] ?? SECTION_PAGE;
        const visible = section.rows.slice(0, limit);
        return (
          <Card key={section.place.key} data-testid="tlb-combined-section">
            <CardContent className="space-y-2 p-3 sm:p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{section.place.label}</h3>
                  <p className="truncate text-[11px] text-muted-foreground">{section.place.fullPath.join(' › ')}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px]">
                    {section.total} · {section.active} active · {section.inactive} inactive
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    aria-label={`Remove ${section.place.label} from selection`}
                    onClick={() => onRemovePlace(section.place.key)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {section.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tenants here for this filter.</p>
              ) : (
                <ul className="space-y-1.5">
                  {visible.map((t) => (
                    <TenantLocationTenantRow
                      key={t.tenant_id}
                      tenant={t}
                      unmapped={!!section.place.path.unmapped}
                      onSelectTenant={onSelectTenant}
                    />
                  ))}
                </ul>
              )}

              {section.rows.length > limit && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[44px] w-full"
                  onClick={() => setShown((s) => ({ ...s, [section.place.key]: limit + SECTION_PAGE }))}
                >
                  Show more ({section.rows.length - limit} left)
                </Button>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export default TenantLocationsCombinedView;
