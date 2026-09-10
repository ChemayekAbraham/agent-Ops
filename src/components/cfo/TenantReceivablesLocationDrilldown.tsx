import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, MapPin, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useTenantReceivablesByLocation,
  type TenantReceivablesLevel,
  type TenantReceivablesLocationRow,
} from '@/hooks/useReceivables';

interface Crumb {
  level: TenantReceivablesLevel;
  label: string;
  region: string | null;
  districtId: number | null;
  subcountyId: number | null;
}

const LEVEL_TITLE: Record<TenantReceivablesLevel, string> = {
  region: 'By region',
  district: 'By district',
  subcounty: 'By town / subcounty',
  village: 'By village',
};

const NEXT_LEVEL: Record<TenantReceivablesLevel, TenantReceivablesLevel | null> = {
  region: 'district',
  district: 'subcounty',
  subcounty: 'village',
  village: null,
};

/**
 * Where the tenant book actually sits on the ground. Region -> district ->
 * town/subcounty -> village, every figure read straight from the authoritative
 * receivables source, so it always reconciles with the category total above.
 */
export function TenantReceivablesLocationDrilldown() {
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [productKey, setProductKey] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const current = trail[trail.length - 1];
  const level: TenantReceivablesLevel = current ? (NEXT_LEVEL[current.level] ?? 'village') : 'region';

  const query = useTenantReceivablesByLocation({
    level,
    region: current?.region ?? null,
    districtId: current?.districtId ?? null,
    subcountyId: current?.subcountyId ?? null,
    productKey,
  });

  const data = query.data;
  const rows = data?.rows ?? [];
  const maxAmount = useMemo(() => Math.max(1, ...rows.map((r) => r.outstanding)), [rows]);

  const drillInto = (row: TenantReceivablesLocationRow) => {
    const next = NEXT_LEVEL[level];
    if (!next) return;
    setOpenRow(null);
    setTrail((t) => [
      ...t,
      {
        level,
        label: row.label,
        region: level === 'region' ? row.label : (current?.region ?? row.region ?? null),
        districtId: level === 'district' ? row.district_id : (current?.districtId ?? null),
        subcountyId: level === 'subcounty' ? row.subcounty_id : (current?.subcountyId ?? null),
      },
    ]);
  };

  const canDrill = (row: TenantReceivablesLocationRow) => {
    if (!NEXT_LEVEL[level]) return false;
    if (level === 'district' && row.district_id == null) return false;
    if (level === 'subcounty' && row.subcounty_id == null) return false;
    return true;
  };

  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-2.5 sm:p-3 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <MapPin className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
          Where this money is — {LEVEL_TITLE[level]}
        </p>
        {data && (
          <span className="text-[10px] sm:text-xs font-mono tabular-nums font-semibold shrink-0">
            {formatUGX(data.total)}
          </span>
        )}
      </div>

      {/* Breadcrumbs */}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => { setTrail([]); setOpenRow(null); }}
          className="text-[10px] sm:text-xs px-2 py-1 rounded-md bg-background border border-border/60 hover:bg-muted min-h-8"
        >
          Uganda
        </button>
        {trail.map((c, i) => (
          <span key={`${c.level}-${c.label}`} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <button
              type="button"
              onClick={() => { setTrail((t) => t.slice(0, i + 1)); setOpenRow(null); }}
              className="text-[10px] sm:text-xs px-2 py-1 rounded-md bg-background border border-border/60 hover:bg-muted min-h-8 max-w-[10rem] truncate"
            >
              {c.label}
            </button>
          </span>
        ))}
      </div>

      {/* Product filter inside the current place */}
      {(data?.products?.length ?? 0) > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="sm"
            variant={productKey === null ? 'default' : 'outline'}
            className="h-7 px-2 text-[10px] sm:text-xs"
            onClick={() => setProductKey(null)}
          >
            All tenant products
          </Button>
          {data?.products.map((p) => (
            <Button
              key={p.key}
              type="button"
              size="sm"
              variant={productKey === p.key ? 'default' : 'outline'}
              className="h-7 px-2 text-[10px] sm:text-xs"
              onClick={() => setProductKey(productKey === p.key ? null : p.key)}
            >
              {p.label} · {formatUGX(p.outstanding)}
            </Button>
          ))}
        </div>
      )}

      {/* Scope summary */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          <SummaryTile label="Owed here" value={formatUGX(data.total)} />
          <SummaryTile label="Tenants" value={`${data.tenant_count}`} />
          <SummaryTile label="Open items" value={`${data.item_count}`} />
          <SummaryTile
            label="Location confirmed"
            value={formatUGX(data.located_amount)}
            hint={data.unmapped_amount > 0 ? `${formatUGX(data.unmapped_amount)} not yet placed` : undefined}
          />
        </div>
      )}

      {query.isLoading && (
        <div className="flex justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}

      {query.error && (
        <p className="py-3 text-[10px] sm:text-xs text-destructive">
          Could not load the location breakdown.
        </p>
      )}

      {!query.isLoading && rows.length === 0 && !query.error && (
        <p className="py-3 text-[10px] sm:text-xs text-muted-foreground">
          Nothing owed in this place.
        </p>
      )}

      <div className="space-y-1.5">
        {rows.map((row) => {
          const rowOpen = openRow === row.key;
          const share = data && data.total > 0 ? (row.outstanding / data.total) * 100 : 0;
          return (
            <div key={row.key} className="rounded-lg bg-background border border-border/50">
              <div className="flex items-stretch">
                <button
                  type="button"
                  onClick={() => setOpenRow(rowOpen ? null : row.key)}
                  aria-expanded={rowOpen}
                  className="flex-1 min-w-0 flex items-center justify-between gap-2 px-2.5 py-2 min-h-11 text-left hover:bg-muted/40 rounded-l-lg transition-colors"
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    {rowOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="min-w-0">
                      <span className="block text-[11px] sm:text-xs font-medium truncate">
                        {row.label}
                        {!row.fully_mapped && (
                          <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[8px] align-middle">
                            partly unplaced
                          </Badge>
                        )}
                      </span>
                      <span className="block text-[9px] sm:text-[10px] text-muted-foreground">
                        {row.tenant_count} tenant{row.tenant_count === 1 ? '' : 's'} · {row.item_count} item
                        {row.item_count === 1 ? '' : 's'} · {share.toFixed(1)}%
                      </span>
                    </span>
                  </span>
                  <span className="text-right shrink-0">
                    <span className="block text-[11px] sm:text-xs font-bold font-mono tabular-nums">
                      {formatUGX(row.outstanding)}
                    </span>
                    <Progress
                      value={(row.outstanding / maxAmount) * 100}
                      className="h-1 w-14 sm:w-20 mt-1"
                    />
                  </span>
                </button>

                {canDrill(row) && (
                  <button
                    type="button"
                    onClick={() => drillInto(row)}
                    className="px-2 border-l border-border/50 text-[9px] sm:text-[10px] text-primary hover:bg-muted/50 rounded-r-lg shrink-0"
                    aria-label={`Open ${row.label}`}
                  >
                    Open
                  </button>
                )}
              </div>

              {rowOpen && (
                <div className="px-2.5 pb-2.5 space-y-2">
                  <div className="flex flex-wrap gap-1.5 text-[9px] sm:text-[10px]">
                    <Badge variant="outline" className="px-1.5 py-0">
                      Scheduled {formatUGX(row.scheduled_amount)}
                    </Badge>
                    <Badge variant="outline" className="px-1.5 py-0">
                      Projected {formatUGX(row.projected_amount)}
                    </Badge>
                    {row.district && row.district !== row.label && (
                      <Badge variant="outline" className="px-1.5 py-0">
                        {row.district}
                      </Badge>
                    )}
                    {row.region && row.region !== row.label && (
                      <Badge variant="outline" className="px-1.5 py-0">
                        {row.region} region
                      </Badge>
                    )}
                  </div>

                  <div className="space-y-1">
                    {row.products.map((p) => (
                      <div
                        key={`${row.key}-${p.key}`}
                        className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5"
                      >
                        <span className="text-[10px] sm:text-xs truncate">{p.label}</span>
                        <span className="text-[10px] sm:text-xs font-mono tabular-nums font-semibold shrink-0">
                          {formatUGX(p.outstanding)}{' '}
                          <span className="text-muted-foreground font-normal">({p.item_count})</span>
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="rounded-lg bg-muted/30 max-h-56 overflow-y-auto">
                    <p className="px-2 pt-1.5 pb-1 text-[9px] sm:text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                      <Users className="h-3 w-3" /> Largest balances here
                    </p>
                    {row.top_items.map((item) => (
                      <div
                        key={item.item_id}
                        className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border/40 last:border-0"
                      >
                        <span className="min-w-0">
                          <span className="block text-[10px] sm:text-xs truncate">
                            {item.tenant || 'Unnamed tenant'}
                          </span>
                          <span className="block text-[9px] sm:text-[10px] text-muted-foreground truncate">
                            {item.product}
                            {item.village && item.village !== 'Unmapped' ? ` · ${item.village}` : ''}
                            {item.town ? ` · ${item.town}` : ''}
                            {item.status ? ` · ${item.status}` : ''}
                          </span>
                        </span>
                        <span className="text-[10px] sm:text-xs font-mono tabular-nums shrink-0">
                          {formatUGX(item.amount)}
                        </span>
                      </div>
                    ))}
                    {row.item_count > row.top_items.length && (
                      <p className="px-2 py-1.5 text-[9px] sm:text-[10px] text-muted-foreground">
                        Showing largest {row.top_items.length} of {row.item_count}.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SummaryTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-background border border-border/50 px-2 py-1.5">
      <p className="text-[9px] sm:text-[10px] text-muted-foreground truncate">{label}</p>
      <p className="text-[11px] sm:text-xs font-semibold font-mono tabular-nums truncate">{value}</p>
      {hint && <p className="text-[9px] text-amber-600 truncate">{hint}</p>}
    </div>
  );
}
