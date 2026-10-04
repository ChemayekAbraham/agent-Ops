import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle2, Search, Share2, User, Home, Receipt, FileDown, UserCog } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { LandlordPayoutShareCard, type LandlordPayoutShareData } from './LandlordPayoutShareCard';
import {
  buildBulkPayoutsPdfBlob,
  buildBulkCardsPdfBlob,
  buildFundedSummaryPdfBlob,
  downloadBlob,
  exportPayoutsXlsx,
  PAYOUT_COLUMNS,
  DEFAULT_PAYOUT_COLUMNS,
  type PayoutColumnKey,
} from './landlordPayoutPdf';
import { toast } from 'sonner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { List, LayoutGrid, Columns3, FileSpreadsheet } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Globe2, CalendarDays } from 'lucide-react';

// African countries grouped by sub-region, ordered East → West → South → North.
const AFRICA_REGIONS: { region: string; countries: string[] }[] = [
  {
    region: 'Eastern Africa',
    countries: [
      'Uganda', 'Kenya', 'Tanzania', 'Rwanda', 'Burundi', 'South Sudan',
      'Ethiopia', 'Somalia', 'Djibouti', 'Eritrea', 'Madagascar', 'Mauritius',
      'Seychelles', 'Comoros', 'Malawi', 'Mozambique', 'Zambia', 'Zimbabwe',
    ],
  },
  {
    region: 'Western Africa',
    countries: [
      'Nigeria', 'Ghana', "Côte d'Ivoire", 'Senegal', 'Mali', 'Burkina Faso',
      'Niger', 'Guinea', 'Guinea-Bissau', 'Sierra Leone', 'Liberia', 'Togo',
      'Benin', 'Gambia', 'Cape Verde', 'Mauritania',
    ],
  },
  {
    region: 'Southern Africa',
    countries: [
      'South Africa', 'Namibia', 'Botswana', 'Lesotho', 'Eswatini', 'Angola',
    ],
  },
  {
    region: 'Northern Africa',
    countries: [
      'Egypt', 'Sudan', 'Libya', 'Tunisia', 'Algeria', 'Morocco', 'Western Sahara',
    ],
  },
  {
    region: 'Central Africa',
    countries: [
      'DR Congo', 'Congo', 'Cameroon', 'Central African Republic',
      'Central African Rep.', 'Chad', 'Gabon', 'Equatorial Guinea',
      'São Tomé and Príncipe', 'São Tomé & Príncipe',
    ],
  },
];

const AFRICAN_COUNTRY_SET = new Set(AFRICA_REGIONS.flatMap((r) => r.countries));

type Row = {
  id: string;
  source_type?: 'payout' | 'allocation';
  source_id?: string;
  agent_id: string;
  tenant_id: string | null;
  landlord_id: string | null;
  landlord_name: string;
  landlord_phone: string;
  mobile_money_provider: string;
  amount: number;
  status: string;
  finops_disbursed_at: string | null;
  finops_momo_reference: string | null;
  external_reference: string | null;
  created_at: string;
  rent_request_id: string | null;
  country: string | null;
  agent_profile?: { full_name: string | null; phone: string | null } | null;
  tenant_profile?: { full_name: string | null } | null;
  finops_disbursed_by: string | null;
  allocation_applied_id?: string | null;
  paid_out_amount?: number | null;
  remaining_amount?: number | null;
  funder_profile?: { full_name: string | null } | null;
};
type DateFilter = 'all' | '7d' | '30d' | 'month' | 'custom';

type DateRange = { start: Date; end: Date | null };

const currentMonthValue = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const monthLabel = (value: string) => {
  const [y, m] = value.split('-').map(Number);
  if (!y || !m) return value;
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};

// Rolling list of the last 24 months (newest first) for the month dropdown.
const MONTH_OPTIONS: { value: string; label: string }[] = (() => {
  const out: { value: string; label: string }[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < 24; i++) {
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push({ value, label: monthLabel(value) });
    d.setMonth(d.getMonth() - 1);
  }
  return out;
})();


const FUNDED_STATUSES = [
  'pending_finops_disbursement',
  'pending_merchant_payout',
  'awaiting_agent_receipt',
  'completed',
  'disbursed',
] as const;

// Agent-landlord payouts are often completed by merchant agents just after
// month-end even though the operational funding run belongs to the closing
// month. Include the month-close grace window by default so the June report
// matches Finance's operational total instead of only strict calendar-day rows.
const MONTH_CLOSE_GRACE_DAYS = 7;

const monthRangeForUganda = (value: string): DateRange | null => {
  const [y, m] = value.split('-').map(Number);
  if (!y || !m) return null;
  // Reports are Uganda-first: month boundaries are Kampala time (UTC+3),
  // not the browser/server local timezone.
  return {
    start: new Date(Date.UTC(y, m - 1, 1, -3, 0, 0, 0)),
    end: new Date(Date.UTC(y, m, 1, -3, 0, 0, 0)),
  };
};

const getEffectiveDate = (r: Row) => new Date(r.finops_disbursed_at ?? r.created_at);

const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 24 * 60 * 60 * 1000);

const isMonthLateSettlement = (r: Row, monthValue: string) => {
  const month = monthRangeForUganda(monthValue);
  if (!month?.end) return false;
  const t = getEffectiveDate(r).getTime();
  return t >= month.end.getTime() && t < addDays(month.end, MONTH_CLOSE_GRACE_DAYS).getTime();
};

const inRange = (iso: string | null | undefined, range: DateRange | null) => {
  if (!range || !iso) return true;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  if (t < range.start.getTime()) return false;
  return !range.end || t < range.end.getTime();
};

function formatUGX(n: number) {
  return `UGX ${Number(n).toLocaleString()}`;
}

export function FundedTenantsList() {
  const [q, setQ] = useState('');
  const [countryChipSearch, setCountryChipSearch] = useState('');
  const [share, setShare] = useState<LandlordPayoutShareData | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [exportMode, setExportMode] = useState<'list' | 'cards'>('list');
  const [exportCols, setExportCols] = useState<PayoutColumnKey[]>(DEFAULT_PAYOUT_COLUMNS);
  const [dateFilter, setDateFilter] = useState<DateFilter>('month');
  const [customDays, setCustomDays] = useState<number>(14);
  const [monthValue, setMonthValue] = useState<string>(currentMonthValue());
  const [countryFilter, setCountryFilter] = useState<string>('all');
  const [regionFilter, setRegionFilter] = useState<string | null>(null);
  const [drill, setDrill] = useState<{
    tenantId: string | null;
    agentId: string | null;
    landlordId: string | null;
    tab?: 'tenant' | 'agent' | 'landlord';
  } | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['finops-funded-landlord-payouts', dateFilter, monthValue, customDays],
    queryFn: async () => {
      // Compute the effective server-side date window so totals reflect ALL
      // payouts in the period — not just the 200 most-recent rows. The effective
      // payout date is finops_disbursed_at when present, else created_at.
      let range: DateRange | null = null;
      if (dateFilter === 'month') {
        const month = monthRangeForUganda(monthValue);
        if (month?.end) {
          range = {
            start: month.start,
            end: addDays(month.end, MONTH_CLOSE_GRACE_DAYS),
          };
        }
      } else if (dateFilter !== 'all') {
        const days = dateFilter === '7d' ? 7 : dateFilter === '30d' ? 30 : Math.max(1, customDays || 1);
        range = { start: new Date(Date.now() - days * 24 * 60 * 60 * 1000), end: null };
      }

      const buildQuery = () => {
        let q = supabase
          .from('landlord_payouts')
          .select(
            'id, agent_id, tenant_id, landlord_id, landlord_name, landlord_phone, mobile_money_provider, amount, status, finops_disbursed_at, finops_disbursed_by, finops_momo_reference, external_reference, created_at, rent_request_id',
          )
          .in('status', FUNDED_STATUSES as unknown as string[]);
        if (range) {
          const s = range.start.toISOString();
          if (range.end) {
            const e = range.end.toISOString();
            q = q.or(
              `and(finops_disbursed_at.gte.${s},finops_disbursed_at.lt.${e}),and(finops_disbursed_at.is.null,created_at.gte.${s},created_at.lt.${e})`,
            );
          } else {
            q = q.or(
              `finops_disbursed_at.gte.${s},and(finops_disbursed_at.is.null,created_at.gte.${s})`,
            );
          }
        }
        return q;
      };

      // Paginate through the ENTIRE result set (no 2000-row cap) so PDF/Excel
      // exports capture every payout in the period. Order by creation so payouts
      // an agent made "today/yesterday" (still `pending_merchant_payout` with a
      // null finops_disbursed_at) surface first.
      const PAGE = 1000;
      const list: Row[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await buildQuery()
          .order('created_at', { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const chunk = (data ?? []) as Row[];
        list.push(...chunk);
        if (chunk.length < PAGE) break;
      }

      const ids = Array.from(
        new Set([
          ...list.map((r) => r.agent_id),
          ...list.map((r) => r.tenant_id).filter(Boolean) as string[],
          ...list.map((r) => r.landlord_id).filter(Boolean) as string[],
          ...list.map((r) => r.finops_disbursed_by).filter(Boolean) as string[],
        ]),
      );
      if (ids.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone, country')
          .in('id', ids);
        const map = new Map((profs ?? []).map((p) => [p.id, p]));
        list.forEach((r) => {
          r.agent_profile = (map.get(r.agent_id) as any) ?? null;
          if (r.tenant_id) r.tenant_profile = (map.get(r.tenant_id) as any) ?? null;
          if (r.finops_disbursed_by) r.funder_profile = (map.get(r.finops_disbursed_by) as any) ?? null;
          const ll = r.landlord_id ? (map.get(r.landlord_id) as any) : null;
          r.country = ll?.country ?? null;
        });
      }

      const rrIds = Array.from(new Set(list.map((r) => r.rent_request_id).filter(Boolean) as string[]));
      if (rrIds.length) {
        const { data: rrs } = await supabase
          .from('rent_requests')
          .select('id, request_country')
          .in('id', rrIds);
        const rrMap = new Map((rrs ?? []).map((r: any) => [r.id, r.request_country as string | null]));
        list.forEach((r) => {
          const c = r.rent_request_id ? rrMap.get(r.rent_request_id) ?? null : null;
          if (c) r.country = c;
        });
      }
      // Platform is Uganda-based (UGX). When no country is stored on the
      // landlord profile or rent request, attribute the payout to Uganda so
      // the country breakdown reflects the real amounts instead of all zeros.
      list.forEach((r) => {
        r.country = r.country?.trim() || 'Uganda';
      });
      return list;
    },
    refetchInterval: 60_000,
  });

  const dateFiltered = useMemo(() => {
    if (dateFilter === 'all') return rows;
    if (dateFilter === 'month') {
      const month = monthRangeForUganda(monthValue);
      const range = month?.end
        ? { start: month.start, end: addDays(month.end, MONTH_CLOSE_GRACE_DAYS) }
        : null;
      return rows.filter((r) => inRange((r.finops_disbursed_at ?? r.created_at), range));
    }
    const days = dateFilter === '7d' ? 7 : dateFilter === '30d' ? 30 : Math.max(1, customDays || 1);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return rows.filter((r) => {
      const ts = getEffectiveDate(r).getTime();
      return ts >= cutoff;
    });
  }, [rows, dateFilter, customDays, monthValue]);

  const lateSettlementStats = useMemo(() => {
    if (dateFilter !== 'month') return { count: 0, total: 0 };
    return dateFiltered.reduce(
      (acc, r) => {
        if (isMonthLateSettlement(r, monthValue)) {
          acc.count += 1;
          acc.total += Number(r.amount || 0);
        }
        return acc;
      },
      { count: 0, total: 0 },
    );
  }, [dateFiltered, dateFilter, monthValue]);

  const countryStats = useMemo(() => {
    const m = new Map<string, { count: number; total: number }>();
    dateFiltered.forEach((r) => {
      const key = r.country?.trim() || 'Unknown';
      const cur = m.get(key) ?? { count: 0, total: 0 };
      cur.count += 1;
      cur.total += Number(r.amount || 0);
      m.set(key, cur);
    });
    return Array.from(m.entries())
      .map(([country, v]) => ({ country, ...v }))
      .sort((a, b) => b.total - a.total);
  }, [dateFiltered]);

  const regionStats = useMemo(() => {
    const m = new Map<string, { count: number; total: number; countries: Set<string> }>();
    AFRICA_REGIONS.forEach((group) => {
      m.set(group.region, { count: 0, total: 0, countries: new Set<string>() });
    });
    dateFiltered.forEach((r) => {
      const c = r.country?.trim() || 'Unknown';
      for (const group of AFRICA_REGIONS) {
        if (group.countries.includes(c)) {
          const cur = m.get(group.region)!;
          cur.count += 1;
          cur.total += Number(r.amount || 0);
          cur.countries.add(c);
          break;
        }
      }
    });
    return Array.from(m.entries())
      .map(([region, v]) => ({ region, ...v }))
      .sort((a, b) => b.total - a.total);
  }, [dateFiltered]);

  const drilldown = useMemo(() => {
    if (countryFilter !== 'all') {
      const rows = dateFiltered.filter((r) => (r.country?.trim() || 'Unknown') === countryFilter);
      const landlords = new Map<string, { id: string | null; name: string; tenants: Set<string>; payouts: number; total: number }>();
      const tenants = new Set<string>();
      const tenantMap = new Map<string, { id: string; name: string; phone: string; payouts: number; total: number }>();
      let total = 0;
      rows.forEach((r) => {
        total += Number(r.amount || 0);
        if (r.tenant_id) tenants.add(r.tenant_id);
        if (r.tenant_id) {
          const tk = r.tenant_id;
          const tc = tenantMap.get(tk) ?? { id: tk, name: r.tenant_profile?.full_name ?? 'Unallocated tenant', phone: r.landlord_phone ?? '', payouts: 0, total: 0 };
          tc.payouts += 1;
          tc.total += Number(r.amount || 0);
          tenantMap.set(tk, tc);
        }
        const key = r.landlord_id || r.landlord_name || 'unknown';
        const cur = landlords.get(key) ?? { id: r.landlord_id, name: r.landlord_name, tenants: new Set<string>(), payouts: 0, total: 0 };
        cur.payouts += 1;
        cur.total += Number(r.amount || 0);
        if (r.tenant_id) cur.tenants.add(r.tenant_id);
        landlords.set(key, cur);
      });
      return {
        type: 'country' as const,
        name: countryFilter,
        tenantCount: tenants.size,
        landlordCount: landlords.size,
        payoutCount: rows.length,
        total,
        landlords: Array.from(landlords.values()).sort((a, b) => b.total - a.total),
        tenants: Array.from(tenantMap.values()).sort((a, b) => b.total - a.total),
        countryStats: [] as { country: string; count: number; total: number }[],
      };
    }
    if (regionFilter) {
      const regionCountries = new Set(AFRICA_REGIONS.find((g) => g.region === regionFilter)?.countries || []);
      const rows = dateFiltered.filter((r) => regionCountries.has(r.country?.trim() || ''));
      const landlords = new Map<string, { id: string | null; name: string; tenants: Set<string>; payouts: number; total: number }>();
      const tenants = new Set<string>();
      const countryMap = new Map<string, { count: number; total: number }>();
      let total = 0;
      rows.forEach((r) => {
        total += Number(r.amount || 0);
        if (r.tenant_id) tenants.add(r.tenant_id);
        const c = r.country?.trim() || 'Unknown';
        const cm = countryMap.get(c) ?? { count: 0, total: 0 };
        cm.count += 1; cm.total += Number(r.amount || 0);
        countryMap.set(c, cm);
        const key = r.landlord_id || r.landlord_name || 'unknown';
        const cur = landlords.get(key) ?? { id: r.landlord_id, name: r.landlord_name, tenants: new Set<string>(), payouts: 0, total: 0 };
        cur.payouts += 1;
        cur.total += Number(r.amount || 0);
        if (r.tenant_id) cur.tenants.add(r.tenant_id);
        landlords.set(key, cur);
      });
      return {
        type: 'region' as const,
        name: regionFilter,
        tenantCount: tenants.size,
        landlordCount: landlords.size,
        payoutCount: rows.length,
        total,
        landlords: Array.from(landlords.values()).sort((a, b) => b.total - a.total),
        tenants: [] as { id: string; name: string; phone: string; payouts: number; total: number }[],
        countryStats: Array.from(countryMap.entries()).map(([country, v]) => ({ country, ...v })).sort((a, b) => b.total - a.total),
      };
    }
    return null;
  }, [dateFiltered, countryFilter, regionFilter]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let base = dateFiltered;
    if (countryFilter !== 'all') {
      base = base.filter((r) => (r.country?.trim() || 'Unknown') === countryFilter);
    } else if (regionFilter) {
      const regionCountries = new Set(AFRICA_REGIONS.find((g) => g.region === regionFilter)?.countries || []);
      base = base.filter((r) => regionCountries.has(r.country?.trim() || ''));
    }
    if (!needle) return base;
    return base.filter((r) => {
      const hay = [
        r.landlord_name,
        r.landlord_phone,
        r.tenant_profile?.full_name ?? '',
        r.agent_profile?.full_name ?? '',
        r.funder_profile?.full_name ?? '',
        r.finops_momo_reference ?? '',
        r.external_reference ?? '',
        r.country ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [dateFiltered, countryFilter, regionFilter, q]);

  const totalAmount = useMemo(
    () => filtered.reduce((s, r) => s + Number(r.amount || 0), 0),
    [filtered],
  );

  const rowToShareData = (r: Row): LandlordPayoutShareData => ({
    amount: r.amount,
    landlord_name: r.landlord_name,
    landlord_phone: r.landlord_phone,
    mobile_money_provider: r.mobile_money_provider,
    tenant_name: r.tenant_profile?.full_name ?? null,
    agent_name: r.agent_profile?.full_name ?? null,
    agent_phone: r.agent_profile?.phone ?? null,
    momo_reference: r.finops_momo_reference ?? r.external_reference ?? '—',
    paid_at: r.finops_disbursed_at ?? r.created_at,
    country: r.country ?? null,
  });

  const scopeLabel = useMemo(() => {
    const parts: string[] = [];
    if (dateFilter === '7d') parts.push('last 7 days');
    else if (dateFilter === '30d') parts.push('last 30 days');
    else if (dateFilter === 'month') parts.push(`${monthLabel(monthValue)} + month-close settlements`);
    else if (dateFilter === 'custom') parts.push(`last ${Math.max(1, customDays || 1)} days`);
    if (regionFilter) parts.push(regionFilter);
    else if (countryFilter !== 'all') parts.push(countryFilter);
    return parts.join(' · ');
  }, [dateFilter, customDays, monthValue, countryFilter, regionFilter]);

  // Human-readable time period for the summary sentence.
  const periodLabel = useMemo(() => {
    if (dateFilter === 'month') return `${monthLabel(monthValue)} including month-close settlements`;
    if (dateFilter === '7d') return 'the last 7 days';
    if (dateFilter === '30d') return 'the last 30 days';
    if (dateFilter === 'custom') return `the last ${Math.max(1, customDays || 1)} days`;
    return 'all time';
  }, [dateFilter, monthValue, customDays]);

  const scopeSlug = useMemo(() => {
    const slug = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const parts: string[] = [];
    if (dateFilter === '7d') parts.push('last-7d');
    else if (dateFilter === '30d') parts.push('last-30d');
    else if (dateFilter === 'month') parts.push(monthValue);
    else if (dateFilter === 'custom') parts.push(`last-${Math.max(1, customDays || 1)}d`);
    else parts.push('all-time');
    if (regionFilter) parts.push(slug(regionFilter));
    else if (countryFilter !== 'all') parts.push(slug(countryFilter));
    return parts.join('-');
  }, [dateFilter, customDays, monthValue, countryFilter, regionFilter]);

  const handleBulkPdf = async () => {
    if (!filtered.length) return;
    const scopeText = scopeLabel ? ` (${scopeLabel})` : '';
    if (filtered.length > 50) {
      const ok = window.confirm(
        `You're about to export ${filtered.length} payouts${scopeText} into one PDF. This may take a minute. Continue?`,
      );
      if (!ok) return;
    }
    setBulk({ done: 0, total: filtered.length });
    try {
      const onProgress = (done: number, total: number) => setBulk({ done, total });
      const data = filtered.map(rowToShareData);
      const blob =
        exportMode === 'cards'
          ? await buildBulkCardsPdfBlob(data, onProgress)
          : await buildBulkPayoutsPdfBlob(data, orderedCols, onProgress);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(
        blob,
        `welile-funded-landlord-payouts-${stamp}-${scopeSlug}-${exportMode}-x${filtered.length}.pdf`,
      );
      toast.success(`Exported ${filtered.length} payouts${scopeText} to PDF`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to build bulk PDF');
    } finally {
      setBulk(null);
    }
  };

  const handleExportXlsx = async () => {
    if (!filtered.length) return;
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      await exportPayoutsXlsx(
        filtered.map(rowToShareData),
        `welile-funded-landlord-payouts-${stamp}-${scopeSlug}-x${filtered.length}.xlsx`,
        orderedCols,
      );
      toast.success(`Exported ${filtered.length} payouts to spreadsheet`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to build spreadsheet');
    }
  };

  const handleSummaryPdf = async () => {
    if (!filtered.length) return;
    try {
      // Build region + country breakdown from the currently visible rows.
      const countryMap = new Map<string, { count: number; total: number }>();
      const regionMap = new Map<string, { count: number; total: number }>();
      filtered.forEach((r) => {
        const c = r.country?.trim() || 'Unknown';
        const cm = countryMap.get(c) ?? { count: 0, total: 0 };
        cm.count += 1; cm.total += Number(r.amount || 0);
        countryMap.set(c, cm);
        const group = AFRICA_REGIONS.find((g) => g.countries.includes(c));
        const region = group?.region ?? 'Other';
        const rm = regionMap.get(region) ?? { count: 0, total: 0 };
        rm.count += 1; rm.total += Number(r.amount || 0);
        regionMap.set(region, rm);
      });
      const toSorted = (m: Map<string, { count: number; total: number }>) =>
        Array.from(m.entries())
          .map(([name, v]) => ({ name, ...v }))
          .sort((a, b) => b.total - a.total);
      const blob = await buildFundedSummaryPdfBlob({
        regionStats: toSorted(regionMap),
        countryStats: toSorted(countryMap),
        payoutCount: filtered.length,
        grandTotal: totalAmount,
        scopeLabel: scopeLabel || undefined,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `welile-funded-landlord-summary-${stamp}-${scopeSlug}.pdf`);
      toast.success('Exported funded payouts summary to PDF');
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to build summary PDF');
    }
  };

  const toggleCol = (key: PayoutColumnKey) => {
    setExportCols((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  // Keep export columns in the canonical registry order regardless of the
  // order the user ticked the checkboxes.
  const orderedCols = useMemo(
    () =>
      PAYOUT_COLUMNS.map((c) => c.key).filter((k) =>
        exportCols.includes(k),
      ) as PayoutColumnKey[],
    [exportCols],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading funded payouts…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
          <CheckCircle2 className="h-6 w-6 text-emerald-600" />
          Tenants Whose Landlords Were Funded
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Every landlord payout Financial Ops has settled — most recent first.
        </p>
        <Button
          size="sm" variant="outline" className="mt-2 gap-1.5"
          onClick={() => setDrill({ tenantId: null, agentId: null, landlordId: null })}
        >
          <UserCog className="h-3.5 w-3.5" />
          Drill into any user (search globally)
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tenant, landlord, agent or MoMo TID"
            className="pl-9"
          />
        </div>
        <Badge variant="outline" className="shrink-0">
          {filtered.length} · {formatUGX(totalAmount)}
        </Badge>
        <ToggleGroup
          type="single"
          value={exportMode}
          onValueChange={(v) => v && setExportMode(v as 'list' | 'cards')}
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-label="PDF export view"
        >
          <ToggleGroupItem value="list" className="gap-1.5 px-2.5" aria-label="Compact list view" title="Export as a compact list (many per page)">
            <List className="h-3.5 w-3.5" /> List
          </ToggleGroupItem>
          <ToggleGroupItem value="cards" className="gap-1.5 px-2.5" aria-label="Card view" title="Export as branded receipt cards">
            <LayoutGrid className="h-3.5 w-3.5" /> Cards
          </ToggleGroupItem>
        </ToggleGroup>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              disabled={exportMode === 'cards'}
              title={
                exportMode === 'cards'
                  ? 'Column selection applies to the List & spreadsheet exports'
                  : 'Choose which columns to include in the export'
              }
            >
              <Columns3 className="h-3.5 w-3.5" />
              Columns ({orderedCols.length})
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-2">
            <div className="px-1 pb-1.5 text-xs font-semibold text-muted-foreground">
              Export columns
            </div>
            <div className="space-y-0.5">
              {PAYOUT_COLUMNS.map((c) => (
                <label
                  key={c.key}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-muted cursor-pointer"
                >
                  <Checkbox
                    checked={exportCols.includes(c.key)}
                    onCheckedChange={() => toggleCol(c.key)}
                  />
                  {c.label}
                </label>
              ))}
            </div>
            <div className="mt-1.5 flex items-center justify-between border-t pt-1.5">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground underline"
                onClick={() => setExportCols(DEFAULT_PAYOUT_COLUMNS)}
              >
                Reset
              </button>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground underline"
                onClick={() => setExportCols(PAYOUT_COLUMNS.map((c) => c.key))}
              >
                Select all
              </button>
            </div>
          </PopoverContent>
        </Popover>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 gap-1.5"
          onClick={handleBulkPdf}
          disabled={!filtered.length || !!bulk}
          title={
            scopeLabel
              ? `Download ${filtered.length} payouts (${scopeLabel}) as one PDF — ${exportMode === 'cards' ? 'receipt cards' : 'compact list'}`
              : `Download all ${filtered.length} visible payouts as one PDF — ${exportMode === 'cards' ? 'receipt cards' : 'compact list'}`
          }
        >
          {bulk ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {bulk.done}/{bulk.total}
            </>
          ) : (
            <>
              <FileDown className="h-3.5 w-3.5" />
              Bulk PDF ({filtered.length}{scopeLabel ? ` · ${scopeLabel}` : ''})
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 gap-1.5"
          onClick={handleExportXlsx}
          disabled={!filtered.length || !!bulk || !orderedCols.length}
          title={`Download ${filtered.length} payouts as a spreadsheet (XLSX) with the selected columns`}
        >
          <FileSpreadsheet className="h-3.5 w-3.5" />
          Excel
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 gap-1.5"
          onClick={handleSummaryPdf}
          disabled={!filtered.length || !!bulk}
          title={`Download a country & region breakdown of the ${filtered.length} visible payouts with real amounts and totals`}
        >
          <FileDown className="h-3.5 w-3.5" />
          Summary PDF
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarDays className="h-3.5 w-3.5" /> Funded in:
        </div>
        <Select value={dateFilter} onValueChange={(v) => { setDateFilter(v as DateFilter); setCountryFilter('all'); setRegionFilter(null); }}>
          <SelectTrigger className="h-8 text-xs w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="month">By month</SelectItem>
            <SelectItem value="all">All time</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="custom">Custom…</SelectItem>
          </SelectContent>
        </Select>
        {dateFilter === 'month' && (
          <Select
            value={monthValue}
            onValueChange={(v) => { setMonthValue(v || currentMonthValue()); setCountryFilter('all'); setRegionFilter(null); }}
          >
            <SelectTrigger className="h-8 text-xs w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-[300px]">
              {MONTH_OPTIONS.map((m) => (
                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {dateFilter === 'custom' && (
          <div className="inline-flex items-center gap-1.5">
            <Input
              type="number"
              min={1}
              max={365}
              value={customDays}
              onChange={(e) => { setCustomDays(Number(e.target.value) || 1); setCountryFilter('all'); setRegionFilter(null); }}
              className="h-8 w-20 text-xs"
            />
            <span className="text-xs text-muted-foreground">days</span>
          </div>
        )}
      </div>

      {dateFilter === 'month' && lateSettlementStats.count > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Month report includes {lateSettlementStats.count} month-close settlements worth{' '}
          <span className="font-bold">{formatUGX(lateSettlementStats.total)}</span> that were paid shortly after month end but belong to this operational payout cycle.
        </div>
      )}

      {countryStats.length > 0 && (
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
            <Globe2 className="h-3.5 w-3.5" /> Countries funded
            {dateFilter !== 'all' && (
              <span className="normal-case font-normal text-muted-foreground">
                · {periodLabel}
              </span>
            )}
          </div>
          {(() => {
            const statsMap = new Map(countryStats.map((c) => [c.country, c]));
            const renderChip = (country: string) => {
              const c = statsMap.get(country);
              const active = countryFilter === country;
              const hasData = !!c && c.count > 0;
              return (
                <button
                  key={country}
                  type="button"
                  onClick={() => { setCountryFilter(country); setRegionFilter(null); }}
                  className={`px-2.5 py-1 rounded-full text-xs border transition inline-flex items-center gap-1.5 ${
                    active
                      ? 'bg-primary text-primary-foreground border-primary'
                      : hasData
                      ? 'bg-background hover:bg-muted border-border'
                      : 'bg-background/40 hover:bg-muted border-border/60 text-muted-foreground'
                  }`}
                  title={c ? `${c.count} payouts · ${formatUGX(c.total)}` : 'No payouts in range'}
                >
                  <span className="font-medium">{country}</span>
                  <span className={active ? 'opacity-90' : 'text-muted-foreground'}>
                    {c ? `${c.count} · ${formatUGX(c.total)}` : '0'}
                  </span>
                </button>
              );
            };
            const otherCountries = countryStats
              .map((c) => c.country)
              .filter((name) => !AFRICAN_COUNTRY_SET.has(name));
            const chipNeedle = countryChipSearch.trim().toLowerCase();
            const regionMatches = (group: typeof AFRICA_REGIONS[number]) =>
              !chipNeedle || group.region.toLowerCase().includes(chipNeedle) ||
              group.countries.some((c) => c.toLowerCase().includes(chipNeedle));
            const countryMatches = (country: string) =>
              !chipNeedle || country.toLowerCase().includes(chipNeedle);
            const visibleRegions = AFRICA_REGIONS.filter(regionMatches);
            const visibleOther = otherCountries.filter(countryMatches);
            return (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 min-w-[200px] max-w-sm">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={countryChipSearch}
                      onChange={(e) => setCountryChipSearch(e.target.value)}
                      placeholder="Find a country or region…"
                      className="pl-8 h-8 text-xs"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => { setCountryFilter('all'); setRegionFilter(null); setCountryChipSearch(''); }}
                    className={`px-2.5 py-1 rounded-full text-xs border transition ${
                      countryFilter === 'all' && !regionFilter
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background hover:bg-muted border-border'
                    }`}
                  >
                    All ({dateFiltered.length})
                  </button>
                  {(countryFilter !== 'all' || regionFilter || countryChipSearch) && (
                    <button
                      type="button"
                      onClick={() => { setCountryFilter('all'); setRegionFilter(null); setCountryChipSearch(''); }}
                      className="px-2.5 py-1 rounded-full text-xs text-muted-foreground hover:text-foreground underline"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {visibleRegions.map((group) => {
                  const rs = regionStats.find((r) => r.region === group.region);
                  const regionActive = regionFilter === group.region;
                  const visibleCountries = group.countries.filter(countryMatches);
                  if (!visibleCountries.length && chipNeedle) return null;
                  return (
                    <div key={group.region} className="space-y-1">
                      <button
                        type="button"
                        onClick={() => { setRegionFilter(group.region); setCountryFilter('all'); setCountryChipSearch(''); }}
                        className={`text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full border transition inline-flex items-center gap-1.5 ${
                          regionActive
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-background hover:bg-muted border-border text-muted-foreground/80'
                        }`}
                        title={rs ? `${rs.count} payouts · ${rs.countries.size} countries · ${formatUGX(rs.total)}` : 'No payouts in range'}
                      >
                        {group.region}
                        {rs && rs.count > 0 && (
                          <span className={regionActive ? 'opacity-90' : 'text-muted-foreground font-normal'}>
                            {rs.count} · {formatUGX(rs.total)}
                          </span>
                        )}
                      </button>
                      <div className="flex flex-wrap gap-1.5">
                        {visibleCountries.map((country) => renderChip(country))}
                      </div>
                    </div>
                  );
                })}
                {visibleOther.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 font-semibold">
                      Other
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {visibleOther.map((country) => renderChip(country))}
                    </div>
                  </div>
                )}
                {chipNeedle && visibleRegions.length === 0 && visibleOther.length === 0 && (
                  <p className="text-xs text-muted-foreground py-2">No country or region matches “{countryChipSearch}”.</p>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {drilldown && (
        <Card className="p-3 sm:p-4 border-primary/30 bg-primary/5">
          {drilldown.type === 'country' && (
            <div className="mb-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2.5">
              <p className="text-sm leading-snug">
                In <span className="font-semibold">{periodLabel}</span>, in{' '}
                <span className="font-semibold">{drilldown.name}</span> we paid out{' '}
                <span className="font-bold text-primary">{formatUGX(drilldown.total)}</span> to{' '}
                <span className="font-semibold">{drilldown.tenantCount} tenants</span> across{' '}
                <span className="font-semibold">{drilldown.landlordCount} landlords</span>
                {' '}({drilldown.payoutCount} payouts).
              </p>
            </div>
          )}
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 text-sm font-semibold">
                <Globe2 className="h-4 w-4 text-primary" />
                {drilldown.name}
                <span className="text-xs font-normal text-muted-foreground">
                  · {drilldown.landlordCount} landlords · {drilldown.tenantCount} tenants · {drilldown.payoutCount} payouts · {formatUGX(drilldown.total)}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {drilldown.type === 'region'
                  ? 'Tap any country or landlord to drill deeper.'
                  : 'Tap any landlord to open their profile.'}
              </p>
            </div>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setCountryFilter('all'); setRegionFilter(null); }}>
              Clear filter
            </Button>
          </div>
          {drilldown.type === 'region' && drilldown.countryStats.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {drilldown.countryStats.map((c) => (
                <button
                  key={c.country}
                  type="button"
                  onClick={() => { setCountryFilter(c.country); setRegionFilter(null); }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-border bg-background hover:bg-muted transition"
                >
                  <Globe2 className="h-3 w-3 text-primary" />
                  <span className="font-medium">{c.country}</span>
                  <span className="text-muted-foreground">{c.count} · {formatUGX(c.total)}</span>
                </button>
              ))}
            </div>
          )}
          {drilldown.type === 'country' && drilldown.tenants.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 font-semibold mb-1.5">
                Tenants paid ({drilldown.tenants.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {drilldown.tenants.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setDrill({ tenantId: t.id, agentId: null, landlordId: null, tab: 'tenant' })}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-border bg-background hover:bg-muted transition"
                    title={`${t.payouts} payouts · ${formatUGX(t.total)}`}
                  >
                    <User className="h-3 w-3 text-primary" />
                    <span className="font-medium truncate max-w-[160px]">{t.name}</span>
                    <span className="text-muted-foreground">{formatUGX(t.total)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-3">
            {drilldown.type === 'country' && (
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 font-semibold mb-1.5">
                Landlords paid ({drilldown.landlords.length})
              </div>
            )}
          <div className="flex flex-wrap gap-1.5">
            {drilldown.landlords.map((l) => (
              <button
                key={l.id || l.name}
                type="button"
                onClick={() =>
                  setDrill({
                    tenantId: null,
                    agentId: null,
                    landlordId: l.id ?? null,
                    tab: 'landlord',
                  })
                }
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-border bg-background hover:bg-muted transition"
                title={`${l.tenants.size} tenants · ${l.payouts} payouts · ${formatUGX(l.total)}`}
              >
                <Home className="h-3 w-3 text-primary" />
                <span className="font-medium truncate max-w-[160px]">{l.name}</span>
                <span className="text-muted-foreground">
                  {l.tenants.size}t · {formatUGX(l.total)}
                </span>
              </button>
            ))}
          </div>
          </div>
        </Card>
      )}

      {bulk && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Building combined PDF — {bulk.done} of {bulk.total} cards rendered…
        </div>
      )}

      {filtered.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">
          <p className="text-sm">No funded landlord payouts match your search.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => (
            <Card key={r.id} className="p-3 sm:p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    {r.tenant_id ? (
                      <button
                        type="button"
                        onClick={() =>
                          setDrill({
                            tenantId: r.tenant_id ?? null,
                            agentId: r.agent_id ?? null,
                            landlordId: r.landlord_id ?? null,
                            tab: 'tenant',
                          })
                        }
                        className="inline-flex items-center gap-1 text-sm font-semibold hover:underline truncate"
                        title="Open tenant profile"
                      >
                        <User className="h-3.5 w-3.5 text-muted-foreground" />
                        {r.tenant_profile?.full_name ?? 'Unallocated tenant'}
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-sm font-semibold truncate text-muted-foreground">
                        <User className="h-3.5 w-3.5" />
                        Unallocated tenant
                      </span>
                    )}
                    <span className="text-muted-foreground text-xs">→</span>
                    <button
                      type="button"
                      onClick={() =>
                        setDrill({
                          tenantId: r.tenant_id ?? null,
                          agentId: r.agent_id ?? null,
                          landlordId: r.landlord_id ?? null,
                          tab: 'landlord',
                        })
                      }
                      className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline truncate"
                      title="Open landlord profile"
                    >
                      <Home className="h-3.5 w-3.5" />
                      {r.landlord_name}
                    </button>
                    {r.country && (
                      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                        <Globe2 className="h-2.5 w-2.5" />
                        {r.country}
                      </span>
                    )}
                    {r.status === 'completed' ? (
                      <Badge className="text-[10px] bg-emerald-100 text-emerald-700 border-emerald-200">
                        Completed
                      </Badge>
                    ) : r.status === 'pending_merchant_payout' ? (
                      <Badge className="text-[10px] bg-blue-100 text-blue-700 border-blue-200">
                        Merchant paying out
                      </Badge>
                    ) : r.status === 'pending_finops_disbursement' ? (
                      <Badge className="text-[10px] bg-violet-100 text-violet-700 border-violet-200">
                        Pending Fin Ops
                      </Badge>
                    ) : (
                      <Badge className="text-[10px] bg-amber-100 text-amber-700 border-amber-200">
                        Awaiting receipt
                      </Badge>
                    )}
                    {dateFilter === 'month' && isMonthLateSettlement(r, monthValue) && (
                      <Badge className="text-[10px] bg-amber-100 text-amber-800 border-amber-200">
                        Month-close settlement
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                    <span>
                      Agent:{' '}
                      {r.agent_id ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDrill({
                              tenantId: r.tenant_id ?? null,
                              agentId: r.agent_id ?? null,
                              landlordId: r.landlord_id ?? null,
                              tab: 'agent',
                            });
                          }}
                          className="font-semibold text-primary hover:underline"
                          title="Open agent profile"
                        >
                          {r.agent_profile?.full_name ?? '—'}
                        </button>
                      ) : (
                        <b className="text-foreground">—</b>
                      )}
                    </span>
                    <span>{r.mobile_money_provider}: <span className="font-mono">{r.landlord_phone}</span></span>
                    <span>
                      Funded by:{' '}
                      {r.finops_disbursed_by ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDrill({
                              tenantId: null,
                              agentId: r.finops_disbursed_by,
                              landlordId: null,
                              tab: 'agent',
                            });
                          }}
                          className="font-semibold text-primary hover:underline"
                          title="Open the profile and wallet of the operator who transferred this money"
                        >
                          {r.funder_profile?.full_name ?? 'View operator'}
                        </button>
                      ) : (
                        <b className="text-foreground">—</b>
                      )}
                    </span>
                    {(r.finops_momo_reference || r.external_reference) && (
                      <span className="inline-flex items-center gap-1">
                        <Receipt className="h-3 w-3" />
                        TID: <span className="font-mono">{r.finops_momo_reference ?? r.external_reference}</span>
                      </span>
                    )}
                    <span>
                      {r.finops_disbursed_at
                        ? `Paid ${formatDistanceToNow(new Date(r.finops_disbursed_at), { addSuffix: true })}`
                        : `Submitted ${formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}`}
                    </span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-base sm:text-lg font-bold">{formatUGX(r.amount)}</p>
                  <div className="flex flex-col gap-1 mt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() =>
                      setShare({
                        amount: r.amount,
                        landlord_name: r.landlord_name,
                        landlord_phone: r.landlord_phone,
                        mobile_money_provider: r.mobile_money_provider,
                        tenant_name: r.tenant_profile?.full_name ?? null,
                        agent_name: r.agent_profile?.full_name ?? null,
                        agent_phone: r.agent_profile?.phone ?? null,
                        momo_reference:
                          r.finops_momo_reference ?? r.external_reference ?? '—',
                        paid_at: r.finops_disbursed_at ?? r.created_at,
                      })
                    }
                  >
                    <Share2 className="h-3 w-3 mr-1" /> Share
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 text-xs"
                    onClick={() =>
                      setDrill({
                        tenantId: r.tenant_id ?? null,
                        agentId: r.agent_id ?? null,
                        landlordId: r.landlord_id ?? null,
                      })
                    }
                    title="Open profile, edit location, link agent/landlord/funder"
                  >
                    <UserCog className="h-3 w-3 mr-1" /> Open profile
                  </Button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <LandlordPayoutShareCard
        open={!!share}
        onOpenChange={(o) => !o && setShare(null)}
        data={share}
      />

      <UserDrilldownDrawer
        key={drill ? `${drill.agentId ?? ''}-${drill.tenantId ?? ''}-${drill.landlordId ?? ''}-${drill.tab ?? 'landlord'}` : 'closed'}
        open={!!drill}
        onOpenChange={(o) => !o && setDrill(null)}
        tenantId={drill?.tenantId ?? null}
        agentId={drill?.agentId ?? null}
        landlordId={drill?.landlordId ?? null}
        defaultTab={drill?.tab ?? 'landlord'}
      />
    </div>
  );
}
