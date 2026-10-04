import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { ChevronRight, Loader2, MapPin, Receipt, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import {
  usePaymentsAtLocation,
  usePaymentsByLocation,
  type PaymentsLocationLevel,
  type PaymentsLocationRow,
} from '@/hooks/usePaymentsByLocation';

const LEVEL_LABEL: Record<PaymentsLocationLevel, string> = {
  country: 'Country',
  region: 'Region',
  district: 'District',
  subcounty: 'Town / sub-county',
  village: 'Village',
};

const NEXT_LEVEL: Record<PaymentsLocationLevel, PaymentsLocationLevel | null> = {
  country: 'region',
  region: 'district',
  district: 'subcounty',
  subcounty: 'village',
  village: null,
};

const METHOD_LABEL: Record<string, string> = {
  mobile_money: 'Mobile money',
  cash: 'Cash',
  in_app_wallet: 'In-app wallet',
  unknown: 'Not recorded',
};

const ALL_METHODS = '__all__';

interface Crumb {
  level: PaymentsLocationLevel;
  label: string;
  country: string | null;
  region: string | null;
  districtId: number | null;
  subcountyId: number | null;
}

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Where payments are actually coming from, using the approved Uganda location
 * hierarchy: Country -> Region -> District -> Town/sub-county -> Village, then
 * the individual receipts. Read-only reporting over money already recorded.
 */
export function PaymentsByLocationPanel() {
  const [path, setPath] = useState<Crumb[]>([]);
  const [receiptsFor, setReceiptsFor] = useState<string | null>(null);
  const [from, setFrom] = useState<string>(isoDaysAgo(30));
  const [to, setTo] = useState<string>(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<string>(ALL_METHODS);

  const current = path[path.length - 1] ?? null;
  const level: PaymentsLocationLevel = current ? (NEXT_LEVEL[current.level] ?? 'village') : 'country';

  const filters = useMemo(
    () => ({
      level,
      country: current?.country ?? null,
      region: current?.region ?? null,
      districtId: current?.districtId ?? null,
      subcountyId: current?.subcountyId ?? null,
      from: from || null,
      to: to || null,
      method: method === ALL_METHODS ? null : method,
    }),
    [level, current, from, to, method]
  );

  const breakdown = usePaymentsByLocation(filters);
  const receipts = usePaymentsAtLocation(
    { ...filters, groupLabel: receiptsFor, limit: 200 },
    !!receiptsFor
  );

  const drillInto = (row: PaymentsLocationRow) => {
    if (!NEXT_LEVEL[level]) return;
    setReceiptsFor(null);
    // Carry only the keys for the levels actually drilled through. Group rows
    // also echo one arbitrary member's deeper fields (e.g. a country row may
    // carry region/district_id of a single payment); inheriting those would
    // over-filter the next level and show an empty result.
    setPath((p) => [
      ...p,
      {
        level,
        label: row.label,
        country: level === 'country' ? row.label : (current?.country ?? null),
        region: level === 'region' ? row.label : (current?.region ?? null),
        districtId: level === 'district' ? row.district_id : (current?.districtId ?? null),
        subcountyId: level === 'subcounty' ? row.subcounty_id : (current?.subcountyId ?? null),
      },
    ]);
  };

  const jumpTo = (index: number) => {
    setReceiptsFor(null);
    setPath((p) => p.slice(0, index));
  };

  const data = breakdown.data;
  const canDrill = !!NEXT_LEVEL[level];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm sm:text-base">
          <MapPin className="h-4 w-4 text-primary" />
          Payments by location
        </CardTitle>
        <p className="text-[11px] sm:text-xs text-muted-foreground">
          Money received from tenants, placed on the approved location hierarchy. Tap a row to go
          deeper: country, region, district, town/sub-county, village — then the individual receipts.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Filters */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="block text-[10px] uppercase tracking-wide text-muted-foreground">From</label>
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-9 w-[150px]" />
          </div>
          <div className="space-y-1">
            <label className="block text-[10px] uppercase tracking-wide text-muted-foreground">To</label>
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-9 w-[150px]" />
          </div>
          <div className="space-y-1">
            <label className="block text-[10px] uppercase tracking-wide text-muted-foreground">Method</label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="h-9 w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_METHODS}>All methods</SelectItem>
                {(data?.methods ?? []).map((m) => (
                  <SelectItem key={m.method} value={m.method}>
                    {METHOD_LABEL[m.method] ?? m.method}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-1.5 pb-0.5">
            {[
              { label: 'Today', days: 0 },
              { label: '7 days', days: 7 },
              { label: '30 days', days: 30 },
              { label: '90 days', days: 90 },
            ].map((p) => (
              <Button
                key={p.label}
                size="sm"
                variant="outline"
                className="h-9"
                onClick={() => {
                  setFrom(isoDaysAgo(p.days));
                  setTo(new Date().toISOString().slice(0, 10));
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Breadcrumbs */}
        <div className="flex flex-wrap items-center gap-1 text-[11px] sm:text-xs">
          <button type="button" onClick={() => jumpTo(0)} className="underline-offset-2 hover:underline">
            All locations
          </button>
          {path.map((c, i) => (
            <span key={`${c.label}-${i}`} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <button
                type="button"
                onClick={() => jumpTo(i + 1)}
                className="underline-offset-2 hover:underline"
              >
                {c.label}
              </button>
            </span>
          ))}
          <Badge variant="outline" className="ml-1 px-1.5 py-0 text-[9px]">
            Showing {LEVEL_LABEL[level]}
          </Badge>
        </div>

        {/* Totals */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-lg bg-muted/40 p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Collected</p>
              <p className="text-sm font-semibold font-mono tabular-nums">{formatUGX(data.total)}</p>
            </div>
            <div className="rounded-lg bg-muted/40 p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Payments</p>
              <p className="text-sm font-semibold font-mono tabular-nums">{data.payment_count}</p>
            </div>
            <div className="rounded-lg bg-muted/40 p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Tenants paying</p>
              <p className="text-sm font-semibold font-mono tabular-nums">{data.tenant_count}</p>
            </div>
            <div className="rounded-lg bg-muted/40 p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Not placed</p>
              <p className="text-sm font-semibold font-mono tabular-nums">{formatUGX(data.unmapped_amount)}</p>
            </div>
          </div>
        )}

        {/* Rows */}
        {breakdown.isLoading && (
          <div className="flex items-center gap-2 py-6 justify-center text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading payment activity…
          </div>
        )}
        {breakdown.isError && (
          <p className="py-6 text-center text-xs text-destructive">
            Could not load payment activity. Please try again.
          </p>
        )}
        {data && data.rows.length === 0 && !breakdown.isLoading && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            No payments recorded for this location and period.
          </p>
        )}

        <div className="space-y-1.5">
          {(data?.rows ?? []).map((row) => {
            const open = receiptsFor === row.label;
            return (
              <div key={row.label} className="rounded-lg bg-muted/30">
                <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                  <button
                    type="button"
                    onClick={() => (canDrill ? drillInto(row) : setReceiptsFor(open ? null : row.label))}
                    className="flex min-w-0 items-center gap-1.5 text-left"
                  >
                    {canDrill && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0">
                      <span className="block truncate text-xs sm:text-sm font-medium">{row.label}</span>
                      <span className="block text-[9px] sm:text-[10px] text-muted-foreground">
                        {row.payment_count} payment{row.payment_count === 1 ? '' : 's'} ·{' '}
                        {row.tenant_count} tenant{row.tenant_count === 1 ? '' : 's'}
                        {row.last_payment_at
                          ? ` · last ${format(new Date(row.last_payment_at), 'dd MMM')}`
                          : ''}
                      </span>
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-xs sm:text-sm font-semibold tabular-nums">
                      {formatUGX(row.amount)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[10px]"
                      onClick={() => setReceiptsFor(open ? null : row.label)}
                    >
                      <Receipt className="mr-1 h-3 w-3" />
                      {open ? 'Hide' : 'Payments'}
                    </Button>
                  </div>
                </div>

                {open && (
                  <div className="px-2.5 pb-2.5">
                    {receipts.isLoading && (
                      <div className="flex items-center gap-2 py-3 justify-center text-[11px] text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading payments…
                      </div>
                    )}
                    {receipts.data && (
                      <>
                        <div className="mb-1.5 flex flex-wrap gap-1.5 text-[9px] sm:text-[10px]">
                          <Badge variant="outline" className="px-1.5 py-0">
                            {formatUGX(receipts.data.total)} total
                          </Badge>
                          <Badge variant="outline" className="px-1.5 py-0">
                            <Users className="mr-1 h-2.5 w-2.5" />
                            {receipts.data.tenant_count} tenants
                          </Badge>
                        </div>
                        <div className="max-h-72 overflow-y-auto rounded-lg bg-background/70">
                          {receipts.data.payments.map((p) => (
                            <div
                              key={p.payment_id}
                              className="flex items-center justify-between gap-2 border-b border-border/40 px-2.5 py-1.5 last:border-0"
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-[10px] sm:text-xs">
                                  {p.tenant || 'Unnamed tenant'}
                                </span>
                                <span className="block text-[9px] sm:text-[10px] text-muted-foreground">
                                  {format(new Date(p.paid_at), 'dd MMM yyyy HH:mm')} ·{' '}
                                  {METHOD_LABEL[p.method ?? 'unknown'] ?? p.method}
                                  {p.agent ? ` · ${p.agent}` : ''}
                                  {p.village && p.village !== 'Unmapped' ? ` · ${p.village}` : ''}
                                </span>
                              </span>
                              <span className="shrink-0 font-mono text-[10px] sm:text-xs tabular-nums">
                                {formatUGX(p.amount)}
                              </span>
                            </div>
                          ))}
                          {receipts.data.payment_count > receipts.data.returned && (
                            <p className="px-2.5 py-1.5 text-[9px] sm:text-[10px] text-muted-foreground">
                              Showing latest {receipts.data.returned} of {receipts.data.payment_count} payments.
                            </p>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {data && (
          <p className="pt-1 text-[9px] sm:text-[10px] text-muted-foreground">
            {data.source}. Payments whose tenant has no approved location appear under “Unmapped”.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default PaymentsByLocationPanel;
