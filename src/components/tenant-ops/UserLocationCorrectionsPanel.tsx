/**
 * User Location Corrections — monitoring only.
 *
 * Read-only view of every authenticated system user (any profile with an enabled
 * role): what location is on record, whether it is matched to the approved
 * Uganda dataset, the approved place selected, and when it was corrected.
 * Users who are also tenants are flagged, because they share ONE location record
 * with the tenant corrections tab — the same correction covers both.
 */
import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { KPICard } from '@/components/executive/KPICard';
import {
  Users,
  Search,
  Loader2,
  MapPin,
  CheckCircle2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  UserCheck,
} from 'lucide-react';
import {
  useUserLocationCorrections,
  useUserLocationProgress,
  userLegacyLabel,
  type UserCorrectionStatus,
  type UserLocationCorrectionRow,
} from '@/hooks/useUserLocationCorrections';

const PAGE_SIZE = 25;

const STATUS_TABS: { id: UserCorrectionStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unmapped', label: 'Unmapped' },
  { id: 'pending', label: 'Pending' },
  { id: 'corrected', label: 'Corrected' },
];

function StatusBadge({ status }: { status: UserCorrectionStatus }) {
  if (status === 'corrected') {
    return (
      <Badge className="gap-1 bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15 text-[10px]">
        <CheckCircle2 className="h-3 w-3" /> Corrected
      </Badge>
    );
  }
  if (status === 'pending') {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-600 text-[10px]">
        <Clock className="h-3 w-3" /> Pending
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 border-destructive/40 text-destructive text-[10px]">
      <AlertCircle className="h-3 w-3" /> Unmapped
    </Badge>
  );
}

const roleLabel = (r: string) => r.replace(/_/g, ' ');
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export function UserLocationCorrectionsPanel() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<UserCorrectionStatus | 'all'>('all');
  const [page, setPage] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const progressQ = useUserLocationProgress();
  const p = progressQ.data;
  const list = useUserLocationCorrections({ search: debounced, status, page, pageSize: PAGE_SIZE });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const correctedPct = useMemo(() => {
    if (!p?.total_users) return 0;
    return Math.round((p.corrected / p.total_users) * 1000) / 10;
  }, [p]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard
          title="System users"
          value={(p?.total_users ?? 0).toLocaleString()}
          subtitle="Everyone with an active role"
          icon={Users}
          loading={progressQ.isLoading}
        />
        <KPICard
          title="On approved list"
          value={(p?.corrected ?? 0).toLocaleString()}
          subtitle={`${correctedPct}% of all users`}
          icon={CheckCircle2}
          loading={progressQ.isLoading}
        />
        <KPICard
          title="Still to correct"
          value={(p?.outstanding ?? 0).toLocaleString()}
          subtitle={`${(p?.unmapped ?? 0).toLocaleString()} unmapped · ${(p?.pending ?? 0).toLocaleString()} pending`}
          icon={AlertCircle}
          loading={progressQ.isLoading}
        />
        <KPICard
          title="Also tenants"
          value={(p?.also_tenants ?? 0).toLocaleString()}
          subtitle={`${(p?.also_tenants_outstanding ?? 0).toLocaleString()} of them still to correct`}
          icon={UserCheck}
          loading={progressQ.isLoading}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MapPin className="h-4 w-4 text-primary" /> User location corrections
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Users are asked to pick their place from the approved list when they sign in. Someone who is also a tenant
            shares one location record with the tenant list — correcting it once covers both.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, phone, role or place"
                className="pl-8 h-9 text-sm"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_TABS.map((t) => (
                <Button
                  key={t.id}
                  size="sm"
                  variant={status === t.id ? 'default' : 'outline'}
                  className="h-8 text-xs"
                  onClick={() => {
                    setStatus(t.id);
                    setPage(0);
                  }}
                >
                  {t.label}
                </Button>
              ))}
            </div>
          </div>

          {list.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading users…
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              <p className="text-sm font-semibold">Nothing to show</p>
              <p className="text-xs text-muted-foreground">No user matches this filter.</p>
            </div>
          ) : (
            <>
              {/* Mobile */}
              <div className="space-y-2 md:hidden">
                {rows.map((row: UserLocationCorrectionRow) => (
                  <div key={row.user_id} className="rounded-xl border bg-card p-3 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">{row.full_name || 'Unnamed user'}</p>
                        <p className="text-[11px] text-muted-foreground">{row.phone || '—'}</p>
                      </div>
                      <StatusBadge status={row.correction_status} />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {(row.roles ?? []).map((r) => (
                        <Badge key={r} variant="secondary" className="text-[10px]">
                          {roleLabel(r)}
                        </Badge>
                      ))}
                      {row.is_tenant && (
                        <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">
                          Also a tenant
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground break-words">
                      <span className="font-medium text-foreground">On record: </span>
                      {userLegacyLabel(row)}
                    </p>
                    <p className="text-xs text-muted-foreground break-words">
                      <span className="font-medium text-foreground">Approved place: </span>
                      {row.approved_path || '—'}
                    </p>
                    <p className="text-[11px] text-muted-foreground">Corrected: {when(row.corrected_at)}</p>
                  </div>
                ))}
              </div>

              {/* Desktop */}
              <div className="hidden md:block overflow-x-auto rounded-xl border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs">
                    <tr>
                      <th className="p-2.5 font-semibold">User</th>
                      <th className="p-2.5 font-semibold">Type / role</th>
                      <th className="p-2.5 font-semibold">Location on record</th>
                      <th className="p-2.5 font-semibold">Status</th>
                      <th className="p-2.5 font-semibold">Approved place selected</th>
                      <th className="p-2.5 font-semibold">Corrected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row: UserLocationCorrectionRow) => (
                      <tr key={row.user_id} className="border-t hover:bg-accent/30 align-top">
                        <td className="p-2.5">
                          <p className="font-medium">{row.full_name || 'Unnamed user'}</p>
                          <p className="text-[11px] text-muted-foreground">{row.phone || '—'}</p>
                        </td>
                        <td className="p-2.5">
                          <div className="flex flex-wrap gap-1">
                            {(row.roles ?? []).map((r) => (
                              <Badge key={r} variant="secondary" className="text-[10px]">
                                {roleLabel(r)}
                              </Badge>
                            ))}
                            {row.is_tenant && (
                              <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">
                                Also a tenant
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="p-2.5 max-w-[18rem] text-muted-foreground">{userLegacyLabel(row)}</td>
                        <td className="p-2.5">
                          <StatusBadge status={row.correction_status} />
                        </td>
                        <td className="p-2.5 max-w-[18rem] text-muted-foreground">{row.approved_path || '—'}</td>
                        <td className="p-2.5 whitespace-nowrap text-xs text-muted-foreground">
                          {when(row.corrected_at)}
                          {row.corrected_by_name && (
                            <span className="block text-[11px]">by {row.corrected_by_name}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-1">
                <p className="text-xs text-muted-foreground">
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    disabled={page === 0 || list.isFetching}
                    onClick={() => setPage((x) => Math.max(0, x - 1))}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Page {page + 1} of {pageCount}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    disabled={page + 1 >= pageCount || list.isFetching}
                    onClick={() => setPage((x) => x + 1)}
                  >
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default UserLocationCorrectionsPanel;
