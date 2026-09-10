import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, Loader2, MapPin, Pencil, Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useTenantReceivableAccounts,
  useTenantReceivablesByLocation,
  type TenantReceivableAccount,
  type TenantReceivablesLevel,
  type TenantReceivablesLocationRow,
} from '@/hooks/useReceivables';
import { TenantAccountMovementsSheet } from '@/components/cfo/TenantAccountMovementsSheet';
import CorrectTenantLocationDialog from '@/components/location/CorrectTenantLocationDialog';

const UNMAPPED = 'Unmapped';

/** Plain-language reason an account's money could not be placed on the map. */
function unplacedReason(acct: TenantReceivableAccount): string | null {
  const districtKnown = acct.district && acct.district !== UNMAPPED;
  const villageText = acct.village && acct.village !== UNMAPPED ? acct.village : null;
  const townText = acct.town && acct.town !== UNMAPPED ? acct.town : null;
  if (districtKnown) return null;
  const typed = [villageText, townText].filter(Boolean).join(', ');
  if (typed) {
    return `Typed as “${typed}” — not matched to an approved district`;
  }
  return 'No location on record for this tenant';
}

interface Crumb {
  level: TenantReceivablesLevel;
  label: string;
  region: string | null;
  districtId: number | null;
  subcountyId: number | null;
}

const LEVEL_LABEL: Record<TenantReceivablesLevel, string> = {
  region: 'Region',
  district: 'District',
  subcounty: 'Town / sub-county',
  village: 'Village',
};

const NEXT_LEVEL: Record<TenantReceivablesLevel, TenantReceivablesLevel | null> = {
  region: 'district',
  district: 'subcounty',
  subcounty: 'village',
  village: null,
};

/**
 * Where tenant receivables are owed, using the approved Uganda location
 * hierarchy: region -> district -> town/sub-county -> village. At any level you
 * can open the exact tenant accounts, and from an account the bookings and
 * cash-in/cash-out movements behind the balance. Entirely read-only.
 */
export function TenantReceivablesLocationPanel({ productKey = null }: { productKey?: string | null }) {
  const [path, setPath] = useState<Crumb[]>([]);
  const [accountsFor, setAccountsFor] = useState<string | null>(null);
  const [openTenant, setOpenTenant] = useState<{ id: string; name: string | null } | null>(null);
  const [assignTenant, setAssignTenant] = useState<TenantReceivableAccount | null>(null);
  const qc = useQueryClient();


  const current = path[path.length - 1] ?? null;
  const level: TenantReceivablesLevel = current ? (NEXT_LEVEL[current.level] ?? 'village') : 'region';

  const filters = useMemo(
    () => ({
      level,
      region: current?.region ?? null,
      districtId: current?.districtId ?? null,
      subcountyId: current?.subcountyId ?? null,
      productKey,
    }),
    [level, current, productKey]
  );

  const breakdown = useTenantReceivablesByLocation(filters);

  const accounts = useTenantReceivableAccounts(
    { ...filters, groupLabel: accountsFor, limit: 200 },
    !!accountsFor
  );

  const drillInto = (row: TenantReceivablesLocationRow) => {
    const next = NEXT_LEVEL[level];
    if (!next) return;
    setAccountsFor(null);
    setPath((p) => [
      ...p,
      {
        level,
        label: row.label,
        region: level === 'region' ? row.label : (row.region ?? current?.region ?? null),
        districtId: level === 'district' ? row.district_id : (current?.districtId ?? row.district_id ?? null),
        subcountyId:
          level === 'subcounty' ? row.subcounty_id : (current?.subcountyId ?? null),
      },
    ]);
  };

  const locationLabel = path.map((c) => c.label).join(' › ');

  return (
    <Card>
      <CardContent className="space-y-2 p-3 sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground sm:text-xs">
            <MapPin className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
            Where the money is owed — by {LEVEL_LABEL[level].toLowerCase()}
          </p>
          {breakdown.data && (
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground sm:text-xs">
              {formatUGX(breakdown.data.total)}
            </span>
          )}
        </div>

        {/* Unplaced money: why, and how much */}
        {(() => {
          const unmappedRow = breakdown.data?.rows?.find((r) => r.label === UNMAPPED);
          const unplaced = breakdown.data?.unmapped_amount ?? unmappedRow?.outstanding ?? 0;
          if (!unplaced) return null;
          return (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="flex items-start gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {formatUGX(unplaced)} could not be placed on the map — these tenants have no village
                    picked from the approved Uganda list, so their district and region are unknown.
                  </span>
                </p>
                {unmappedRow && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 px-2 text-[10px]"
                    onClick={() => setAccountsFor(accountsFor === UNMAPPED ? null : UNMAPPED)}
                  >
                    {accountsFor === UNMAPPED ? 'Hide' : 'Assign now'}
                  </Button>
                )}
              </div>
            </div>
          );
        })()}

        {/* Breadcrumbs */}
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          <Button
            size="sm"
            variant={path.length === 0 ? 'secondary' : 'ghost'}
            className="h-7 px-2 text-[11px]"
            onClick={() => {
              setPath([]);
              setAccountsFor(null);
            }}
          >
            All Uganda
          </Button>
          {path.map((c, i) => (
            <span key={`${c.level}-${c.label}`} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <Button
                size="sm"
                variant={i === path.length - 1 ? 'secondary' : 'ghost'}
                className="h-7 max-w-[45vw] truncate px-2 text-[11px]"
                onClick={() => {
                  setPath((p) => p.slice(0, i + 1));
                  setAccountsFor(null);
                }}
              >
                {c.label}
              </Button>
            </span>
          ))}
        </div>

        {breakdown.isLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {breakdown.error && (
          <p className="py-4 text-xs text-destructive">Could not load the location breakdown.</p>
        )}

        <div className="space-y-2">
          {breakdown.data?.rows?.map((row) => {
            const share =
              breakdown.data.total > 0 ? (row.outstanding / breakdown.data.total) * 100 : 0;
            const isOpen = accountsFor === row.label;
            const isUnmapped = row.label === UNMAPPED;
            const canDrill = !!NEXT_LEVEL[level] && !isUnmapped;
            return (
              <div
                key={row.label}
                className={
                  isUnmapped
                    ? 'rounded-xl border border-amber-500/40 bg-amber-500/5'
                    : 'rounded-xl border border-border/60 bg-card'
                }
              >
                <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => (canDrill ? drillInto(row) : setAccountsFor(isOpen ? null : row.label))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    {canDrill && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium sm:text-sm">{row.label}</span>
                      <span className="block text-[9px] text-muted-foreground sm:text-[10px]">
                        {row.tenant_count} tenant{row.tenant_count === 1 ? '' : 's'} · {row.item_count} item
                        {row.item_count === 1 ? '' : 's'} · {share.toFixed(1)}%
                        {row.fully_mapped ? '' : ' · partly unmapped'}
                      </span>
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="block font-mono text-xs font-bold tabular-nums sm:text-sm">
                      {formatUGX(row.outstanding)}
                    </span>
                    <Button
                      size="sm"
                      variant={isOpen ? 'secondary' : 'outline'}
                      className="h-7 px-2 text-[10px]"
                      onClick={() => setAccountsFor(isOpen ? null : row.label)}
                    >
                      <Users className="mr-1 h-3 w-3" />
                      Accounts
                    </Button>
                  </div>
                </div>

                {isOpen && (
                  <div className="space-y-1 border-t border-border/50 px-2.5 py-2">
                    {accounts.isLoading && (
                      <div className="flex justify-center py-4">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      </div>
                    )}
                    {accounts.error && (
                      <p className="py-2 text-[11px] text-destructive">Could not load tenant accounts.</p>
                    )}
                    {accounts.data && accounts.data.accounts.length === 0 && (
                      <p className="py-2 text-[11px] text-muted-foreground">No tenant accounts here.</p>
                    )}
                    <div className="max-h-72 overflow-y-auto">
                      {accounts.data?.accounts.map((acct) => (
                        <button
                          key={acct.tenant_id}
                          type="button"
                          onClick={() => setOpenTenant({ id: acct.tenant_id, name: acct.tenant })}
                          className="flex w-full items-center justify-between gap-2 border-b border-border/40 px-1 py-1.5 text-left last:border-0 hover:bg-muted/40"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[11px] font-medium">
                              {acct.tenant || 'Unnamed tenant'}
                            </span>
                            <span className="block text-[10px] text-muted-foreground">
                              {[acct.village, acct.town, acct.district].filter(Boolean).join(' · ') || 'Location not set'}
                              {acct.phone ? ` · ${acct.phone}` : ''}
                            </span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="block font-mono text-[11px] font-semibold tabular-nums">
                              {formatUGX(acct.outstanding)}
                            </span>
                            <span className="block text-[9px] text-muted-foreground">
                              {acct.item_count} item{acct.item_count === 1 ? '' : 's'} · tap for movements
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                    {accounts.data && accounts.data.tenant_count > accounts.data.accounts.length && (
                      <p className="text-[10px] text-muted-foreground">
                        Showing largest {accounts.data.accounts.length} of {accounts.data.tenant_count} accounts.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {breakdown.data?.source && (
          <p className="text-[10px] text-muted-foreground">Source: {breakdown.data.source}</p>
        )}
      </CardContent>

      <TenantAccountMovementsSheet
        tenantId={openTenant?.id ?? null}
        tenantName={openTenant?.name ?? null}
        locationLabel={locationLabel || null}
        onClose={() => setOpenTenant(null)}
      />
    </Card>
  );
}

export default TenantReceivablesLocationPanel;
