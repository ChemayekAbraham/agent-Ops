/**
 * Tenant Locations — parallel, read-only test page sitting next to All Tenants.
 *
 * Region → District → County → Sub-county → Parish → Village → Tenants, driven
 * entirely by the approved Uganda dataset ids already stored on each profile.
 * Nothing on this page writes, edits or infers a location.
 */
import { useMemo, useState } from 'react';
import {
  ArrowLeft, ChevronRight, Home, Loader2, MapPin, Phone, Search, User, Users, AlertTriangle,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  childLevelFor, hitToPath, useTlbChildren, useTlbLocationSearch, useTlbTenants,
  type TlbPath, type TlbStatus,
} from '@/hooks/useTenantLocationsBrowser';

const LEVEL_LABEL: Record<string, string> = {
  region: 'Regions',
  district: 'Districts',
  county: 'Counties',
  subcounty: 'Sub-counties',
  parish: 'Parishes',
  village: 'Villages',
};

const STATUS_TABS: { value: TlbStatus; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

const PAGE_SIZE = 50;

interface TenantLocationsBrowserProps {
  /** Opens the shared Tenant Ops tenant detail experience (same as All Tenants). */
  onSelectTenant?: (tenantId: string, tenantName: string) => void;
}

export function TenantLocationsBrowser({ onSelectTenant }: TenantLocationsBrowserProps = {}) {
  const [path, setPath] = useState<TlbPath>({});
  const [status, setStatus] = useState<TlbStatus>('all');
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput.trim(), 300);
  const [page, setPage] = useState(1);

  const level = childLevelFor(path);
  const jump = (p: TlbPath) => { setPath(p); setPage(1); };

  const { data: children, isLoading: loadingChildren } = useTlbChildren(path, status, search);
  const { data: locationHits } = useTlbLocationSearch(search, status);

  // Tenants: at a village or in Unmapped we list everything; at a district we
  // list only the tenants whose approved location genuinely stops there.
  const tenantsEnabled = !level || !!path.districtId || search.length >= 2;
  const atLevel = level === 'county' ? 'district' as const : null;
  const { data: tenants, isLoading: loadingTenants } = useTlbTenants(
    path, status, search, page, PAGE_SIZE, atLevel, tenantsEnabled,
  );

  const crumbs = useMemo(() => {
    const list: { label: string; path: TlbPath }[] = [{ label: 'All regions', path: {} }];
    if (path.unmapped) list.push({ label: 'Unmapped', path: { unmapped: true } });
    if (path.region) list.push({ label: path.region, path: { region: path.region } });
    if (path.districtId) list.push({
      label: path.districtName ?? 'District',
      path: { region: path.region, districtId: path.districtId, districtName: path.districtName },
    });
    if (path.countyId) list.push({
      label: path.countyName ?? 'County',
      path: { ...path, subcountyId: undefined, subcountyName: undefined, parishId: undefined, parishName: undefined, villageId: undefined, villageName: undefined },
    });
    if (path.subcountyId) list.push({
      label: path.subcountyName ?? 'Sub-county',
      path: { ...path, parishId: undefined, parishName: undefined, villageId: undefined, villageName: undefined },
    });
    if (path.parishId) list.push({
      label: path.parishName ?? 'Parish',
      path: { ...path, villageId: undefined, villageName: undefined },
    });
    if (path.villageId) list.push({ label: path.villageName ?? 'Village', path: { ...path } });
    return list;
  }, [path]);

  const parentPath = crumbs.length > 1 ? crumbs[crumbs.length - 2].path : {};

  const openChild = (nodeId: number | null, label: string, unmapped: boolean) => {
    if (unmapped) return jump({ unmapped: true });
    switch (level) {
      case 'region':    return jump({ region: label });
      case 'district':  return jump({ ...path, districtId: nodeId!, districtName: label });
      case 'county':    return jump({ ...path, countyId: nodeId!, countyName: label });
      case 'subcounty': return jump({ ...path, subcountyId: nodeId!, subcountyName: label });
      case 'parish':    return jump({ ...path, parishId: nodeId!, parishName: label });
      case 'village':   return jump({ ...path, villageId: nodeId!, villageName: label });
      default: return;
    }
  };

  const totalTenants = tenants?.total ?? 0;
  const pages = Math.max(1, Math.ceil(totalTenants / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-3 sm:p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary" />
              <h2 className="text-sm sm:text-base font-bold">Tenant Locations</h2>
              <Badge variant="outline" className="text-[10px]">read-only test page</Badge>
            </div>
            <div className="flex items-center gap-1">
              {STATUS_TABS.map(t => (
                <Button
                  key={t.value}
                  size="sm"
                  variant={status === t.value ? 'default' : 'outline'}
                  className="h-7 px-3 text-xs"
                  onClick={() => { setStatus(t.value); setPage(1); }}
                >
                  {t.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => { setSearchInput(e.target.value); setPage(1); }}
              placeholder="Search tenant, phone, agent or location…"
              className="pl-9 h-9"
            />
          </div>

          {/* Breadcrumbs + back */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => jump(parentPath)}
              disabled={crumbs.length <= 1}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition ${
                crumbs.length > 1
                  ? 'bg-primary/10 text-primary hover:bg-primary/20'
                  : 'bg-muted text-muted-foreground opacity-50 cursor-not-allowed'
              }`}
            >
              <ArrowLeft className="h-3 w-3" /> Back
            </button>
            <nav className="flex items-center gap-1 flex-wrap text-xs">
              {crumbs.map((c, i) => {
                const isLast = i === crumbs.length - 1;
                return (
                  <span key={i} className="flex items-center gap-1">
                    {i === 0 && <Home className="h-3 w-3 text-muted-foreground" />}
                    <button
                      onClick={() => !isLast && jump(c.path)}
                      disabled={isLast}
                      className={isLast ? 'font-semibold text-foreground' : 'text-primary hover:underline'}
                    >
                      {c.label}
                    </button>
                    {!isLast && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                  </span>
                );
              })}
            </nav>
          </div>

          {/* Location jump suggestions */}
          {search.length >= 2 && (locationHits?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-border bg-muted/30 p-2 space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Jump to location
              </p>
              <div className="flex flex-wrap gap-1.5">
                {locationHits!.map((h, i) => (
                  <button
                    key={`${h.kind}-${h.village_id ?? h.subcounty_id ?? h.district_id}-${i}`}
                    onClick={() => jump(hitToPath(h))}
                    className="text-[11px] px-2 py-1 rounded-md border border-border bg-card hover:bg-muted"
                  >
                    <span className="font-medium">{h.label}</span>
                    <span className="text-muted-foreground"> · {h.kind}</span>
                    {h.path_label && <span className="text-muted-foreground"> · {h.path_label}</span>}
                    <span className="ml-1 text-primary font-semibold">{h.tenant_count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Children of the current node */}
      {level && (
        <Card>
          <CardContent className="p-3 sm:p-4 space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {LEVEL_LABEL[level]}
            </p>
            {loadingChildren ? (
              <Skeleton className="h-32 w-full" />
            ) : !children || children.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tenants recorded here for this filter.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {children.map((c) => (
                  <button
                    key={`${c.unmapped ? 'unmapped' : c.node_id ?? c.label}`}
                    onClick={() => openChild(c.node_id, c.label, c.unmapped)}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card p-3 text-left hover:bg-muted/50 transition"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate flex items-center gap-1.5">
                        {c.unmapped
                          ? <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                          : <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                        {c.label}
                      </p>
                      {c.leaf_count > 0 && !c.unmapped && (
                        <p className="text-[10px] text-muted-foreground">
                          {c.leaf_count} recorded at this level only
                        </p>
                      )}
                    </div>
                    <span className="flex items-center gap-1 text-xs font-bold text-primary shrink-0">
                      <Users className="h-3.5 w-3.5" />{c.tenant_count}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Tenants at this node */}
      {tenantsEnabled && (
        <Card>
          <CardContent className="p-3 sm:p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {path.unmapped
                  ? 'Unmapped tenants'
                  : atLevel === 'district'
                    ? 'Tenants recorded at district level only'
                    : 'Tenants'}
              </p>
              <Badge variant="outline" className="text-[10px]">{totalTenants}</Badge>
            </div>

            {loadingTenants ? (
              <Skeleton className="h-40 w-full" />
            ) : !tenants || tenants.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tenants here for this filter.</p>
            ) : (
              <ul className="space-y-1.5">
                {tenants.rows.map((t) => (
                  <li
                    key={t.tenant_id}
                    className={`rounded-lg border border-border bg-card p-3 ${
                      onSelectTenant ? 'cursor-pointer transition-colors hover:bg-accent/50' : ''
                    }`}
                    role={onSelectTenant ? 'button' : undefined}
                    tabIndex={onSelectTenant ? 0 : undefined}
                    onClick={onSelectTenant ? () => onSelectTenant(t.tenant_id, t.tenant_name) : undefined}
                    onKeyDown={onSelectTenant ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectTenant(t.tenant_id, t.tenant_name);
                      }
                    } : undefined}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate flex items-center gap-1.5">
                          <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          {t.tenant_name}
                        </p>
                        <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                          <Phone className="h-3 w-3" />{t.tenant_phone || '—'}
                          {t.agent_name && <span className="truncate"> · Agent: {t.agent_name}</span>}
                        </p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {path.unmapped
                            ? `Recorded location: ${t.legacy_location || '— none recorded —'}`
                            : [t.village_name, t.parish_name, t.subcounty_name, t.county_name, t.district_name, t.region]
                                .filter(Boolean).join(', ')}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <Badge
                          className={t.is_active
                            ? 'bg-emerald-100 text-emerald-700 text-[10px]'
                            : 'bg-muted text-muted-foreground text-[10px]'}
                        >
                          {t.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                        {t.latest_status && (
                          <span className="text-[10px] text-muted-foreground">
                            {t.latest_status.replace(/_/g, ' ')}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {pages > 1 && (
              <div className="flex items-center justify-between pt-1">
                <Button size="sm" variant="outline" className="h-7 text-xs"
                  disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">Page {page} of {pages}</span>
                <Button size="sm" variant="outline" className="h-7 text-xs"
                  disabled={page >= pages} onClick={() => setPage(p => p + 1)}>
                  Next
                </Button>
              </div>
            )}
            {loadingTenants && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default TenantLocationsBrowser;
