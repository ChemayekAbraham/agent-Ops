import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Loader2, ArrowLeft, Phone, MapPin, CalendarDays, ShieldAlert } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useTenantOpsAgent360 } from '@/hooks/useTenantOpsAnalytics';
import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'good' | 'bad' | 'warn' }) {
  const toneCls =
    tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-destructive' : tone === 'warn' ? 'text-amber-600' : 'text-foreground';
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold mt-1 ${toneCls}`}>{value}</p>
    </div>
  );
}

const n = (v: any) => Number(v ?? 0);
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '0.0%');

interface Props {
  agentId: string;
  agentName?: string;
  onBack?: () => void;
}

/**
 * Level 5 of the Tenant Operations drill-down: a single agent's complete
 * operational + financial dashboard, sourced entirely from
 * get_tenant_ops_agent_360.
 */
export function TenantOpsAgent360Panel({ agentId, agentName, onBack }: Props) {
  const { data, isLoading } = useTenantOpsAgent360(agentId);
  const [tenantPage, setTenantPage] = useState(0);

  const trend = useMemo(
    () => (data?.collection_trend ?? []).map((d: any) => ({ day: String(d.day).slice(5), collected: n(d.collected) })),
    [data],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }
  if (!data) return <p className="text-sm text-muted-foreground py-8 text-center">No data for this agent.</p>;

  const p = data.profile ?? {};
  const t = data.tenants ?? {};
  const f = data.financials ?? {};
  const pr = data.properties ?? {};
  const ll = data.landlords ?? {};
  const col = data.collections ?? {};
  const cm = data.commissions ?? {};
  const w = data.wallet ?? {};
  const wd = data.withdrawals ?? {};

  const tenants = data.tenant_list ?? [];
  const pageSize = 15;
  const pages = Math.max(1, Math.ceil(tenants.length / pageSize));
  const pageRows = tenants.slice(tenantPage * pageSize, tenantPage * pageSize + pageSize);

  const totalInflow = n(col.year) + n(f.collected_to_date);
  const totalOutflow = n(cm.earned) + n(wd.completed);

  return (
    <div className="space-y-4">
      {onBack && (
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" /> Back to agents
        </Button>
      )}

      {/* Overview */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-center gap-4">
          <Avatar className="h-14 w-14">
            <AvatarImage src={p.avatar_url ?? undefined} />
            <AvatarFallback>{(p.full_name ?? agentName ?? 'A').slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <h3 className="text-base font-black truncate">{p.full_name ?? agentName ?? 'Unnamed agent'}</h3>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground mt-1">
              {p.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{p.phone}</span>}
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {[p.district, p.region, p.country].filter(Boolean).join(' · ') || 'Location not set'}
              </span>
              {p.created_at && (
                <span className="flex items-center gap-1">
                  <CalendarDays className="h-3 w-3" />Joined {new Date(p.created_at).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
          <div className="ml-auto flex gap-2">
            <Badge variant="outline">{n(t.active)} active tenants</Badge>
            <Badge variant="outline">{n(pr.total)} properties</Badge>
            <Badge variant="outline">{n(ll.total)} landlords</Badge>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="financial">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="financial">Financial</TabsTrigger>
          <TabsTrigger value="tenants">Tenants</TabsTrigger>
          <TabsTrigger value="landlords">Landlords</TabsTrigger>
          <TabsTrigger value="properties">Properties</TabsTrigger>
          <TabsTrigger value="wallet">Commission &amp; Wallet</TabsTrigger>
          <TabsTrigger value="risk">Risk</TabsTrigger>
        </TabsList>

        <TabsContent value="financial" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Portfolio</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat label="Portfolio value managed" value={formatUGX(n(f.portfolio_value))} />
              <Stat label="Monthly rent expected" value={formatUGX(n(f.rent_expected_monthly))} />
              <Stat label="Expected today" value={formatUGX(n(f.expected_today))} />
              <Stat label="Collected today" value={formatUGX(n(f.paid_today))} tone={n(f.paid_today) >= n(f.expected_today) ? 'good' : 'warn'} />
              <Stat label="Collected this month" value={formatUGX(n(f.paid_month))} tone="good" />
              <Stat label="Collection %" value={pct(n(f.collected_to_date), n(f.expected_to_date))} />
              <Stat label="Outstanding balance" value={formatUGX(n(f.outstanding))} tone="warn" />
              <Stat label="Overdue (arrears)" value={formatUGX(n(f.arrears))} tone="bad" />
              <Stat label="Advance payments" value={formatUGX(n(f.advances))} tone="good" />
              <Stat label="Average rent" value={formatUGX(Math.round(n(f.avg_rent)))} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Cash inflows (field collections)</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <Stat label="Today" value={formatUGX(n(col.today))} />
              <Stat label="This week" value={formatUGX(n(col.week))} />
              <Stat label="This month" value={formatUGX(n(col.month))} />
              <Stat label="This quarter" value={formatUGX(n(col.quarter))} />
              <Stat label="This year" value={formatUGX(n(col.year))} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Financial performance</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat label="Total inflows (recorded)" value={formatUGX(totalInflow)} />
              <Stat label="Total outflows (commission + payouts)" value={formatUGX(totalOutflow)} />
              <Stat label="Net position" value={formatUGX(totalInflow - totalOutflow)} />
              <Stat label="Cost-to-revenue" value={pct(totalOutflow, totalInflow)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Collections — last 30 days</CardTitle></CardHeader>
            <CardContent className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={60} />
                  <Tooltip formatter={(v: any) => formatUGX(Number(v))} />
                  <Area type="monotone" dataKey="collected" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.2)" />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tenants" className="space-y-4 mt-4">
          {/*
            Rent on this platform is repaid DAILY, so every active plan with a
            balance is billable every single day. The funnel below — not a
            calendar due-date match — is the correct operational picture, and it
            uses the same definitions as the district / agent list views.
          */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <Stat label="Total" value={n(t.total)} />
            <Stat label="Active" value={n(t.active)} tone="good" />
            <Stat label="Inactive" value={n(t.inactive)} />
            <Stat label="New this month" value={n(t.new_month)} />
            <Stat label="Expiring leases (30d)" value={n(t.expiring_leases)} tone="warn" />
            <Stat label="Ended leases" value={n(t.ended_leases)} />
            <Stat label="Billable today" value={n(t.billable_today)} />
            <Stat label="Settled today" value={n(t.settled_today)} tone="good" />
            <Stat label="Part-paid today" value={n(t.partial_today)} tone="warn" />
            <Stat label="Covered by advance" value={n(t.covered_by_advance)} tone="good" />
            <Stat label="Not collected yet" value={n(t.uncollected_today)} tone="bad" />
            <Stat label="Today's collection rate" value={pct(n(f.paid_today), n(f.expected_today))} />
            <Stat label="Behind schedule" value={n(t.overdue)} tone="bad" />
            <Stat label="In arrears" value={n(t.arrears)} tone="bad" />
            <Stat label="Paid early" value={n(t.paid_early)} tone="good" />
            <Stat label="Paid on time" value={n(t.paid_on_time)} tone="good" />
            <Stat label="Paid late" value={n(t.paid_late)} tone="warn" />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Arrears ageing (days behind the daily schedule)</CardTitle>
              <p className="text-[11px] text-muted-foreground">
                Portfolio at risk. Days behind = arrears ÷ daily installment. Avg {n(t.avg_days_behind).toFixed(1)}d behind.
              </p>
            </CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-6 gap-2">
              <Stat label="On schedule" value={n(t.par_current)} tone="good" />
              <Stat label="1–7 days" value={n(t.par_1_7)} tone="warn" />
              <Stat label="8–30 days" value={n(t.par_8_30)} tone="warn" />
              <Stat label="31–60 days" value={n(t.par_31_60)} tone="bad" />
              <Stat label="60+ days" value={n(t.par_60_plus)} tone="bad" />
              <Stat label="At risk 30d+ value" value={formatUGX(n(t.par_amount_30_plus))} tone="bad" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Tenant list ({tenants.length})</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      {['Tenant', 'District', 'Rent plan', 'Repaid', 'Outstanding', 'Arrears', 'Paid today', 'Days behind', 'Schedule', 'Status'].map((h) => (
                        <th key={h} className="text-left px-3 py-2 font-semibold whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r: any) => (
                      <tr key={r.tenant_id} className="border-t border-border">
                        <td className="px-3 py-2">{r.tenant_name}</td>
                        <td className="px-3 py-2">{r.district}</td>
                        <td className="px-3 py-2">{formatUGX(n(r.total_repayment))}</td>
                        <td className="px-3 py-2">{formatUGX(n(r.amount_repaid))}</td>
                        <td className="px-3 py-2">{formatUGX(n(r.outstanding))}</td>
                        <td className={`px-3 py-2 ${n(r.arrears) > 0 ? 'text-destructive font-semibold' : ''}`}>{formatUGX(n(r.arrears))}</td>
                        <td className={`px-3 py-2 whitespace-nowrap ${n(r.paid_today) > 0 ? 'text-emerald-600' : r.billable_today ? 'text-destructive' : 'text-muted-foreground'}`}>
                          {r.billable_today === false ? '—' : formatUGX(n(r.paid_today))}
                        </td>
                        <td className={`px-3 py-2 ${n(r.days_behind) > 7 ? 'text-destructive font-semibold' : n(r.days_behind) > 0 ? 'text-amber-600' : 'text-muted-foreground'}`}>
                          {n(r.days_behind) > 0 ? `${n(r.days_behind)}d` : '—'}
                        </td>
                        <td className="px-3 py-2">
                          {r.schedule_delta_days == null ? '—'
                            : r.schedule_delta_days > 0 ? <span className="text-emerald-600">+{r.schedule_delta_days}d ahead</span>
                            : r.schedule_delta_days < 0 ? <span className="text-destructive">{Math.abs(r.schedule_delta_days)}d behind</span>
                            : <span className="text-muted-foreground">on time</span>}
                        </td>
                        <td className="px-3 py-2"><Badge variant="outline" className="text-[10px]">{r.status ?? '—'}</Badge></td>
                      </tr>
                    ))}
                    {pageRows.length === 0 && (
                      <tr><td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">No tenants on file.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {pages > 1 && (
                <div className="flex items-center justify-between p-3 border-t border-border">
                  <span className="text-xs text-muted-foreground">Page {tenantPage + 1} of {pages}</span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={tenantPage === 0} onClick={() => setTenantPage((x) => x - 1)}>Previous</Button>
                    <Button size="sm" variant="outline" disabled={tenantPage >= pages - 1} onClick={() => setTenantPage((x) => x + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="landlords" className="space-y-4 mt-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <Stat label="Total landlords" value={n(ll.total)} />
            <Stat label="Verified (active)" value={n(ll.verified)} tone="good" />
            <Stat label="New this month" value={n(ll.new_month)} />
            <Stat label="Avg properties / landlord" value={n(ll.total) > 0 ? (n(pr.total) / n(ll.total)).toFixed(1) : '0.0'} />
            <Stat label="Revenue per landlord" value={formatUGX(n(ll.total) > 0 ? Math.round(n(f.collected_to_date) / n(ll.total)) : 0)} />
          </div>
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/50"><tr>{['Landlord', 'Phone', 'District', 'Monthly rent', 'Verified'].map((h) => <th key={h} className="text-left px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                <tbody>
                  {(data.landlord_list ?? []).map((r: any) => (
                    <tr key={r.landlord_id} className="border-t border-border">
                      <td className="px-3 py-2">{r.name}</td>
                      <td className="px-3 py-2">{r.phone ?? '—'}</td>
                      <td className="px-3 py-2">{r.district}</td>
                      <td className="px-3 py-2">{formatUGX(n(r.monthly_rent))}</td>
                      <td className="px-3 py-2">{r.verified ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                  {(data.landlord_list ?? []).length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No landlords linked.</td></tr>}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="properties" className="space-y-4 mt-4">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <Stat label="Total properties" value={n(pr.total)} />
            <Stat label="Occupied units" value={n(pr.occupied)} tone="good" />
            <Stat label="Vacant units" value={n(pr.vacant)} tone="warn" />
            <Stat label="Occupancy rate" value={pct(n(pr.occupied), n(pr.total))} />
            <Stat label="Portfolio rent value" value={formatUGX(n(pr.portfolio_rent))} />
            <Stat label="Average property rent" value={formatUGX(Math.round(n(pr.avg_rent)))} />
          </div>
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/50"><tr>{['District', 'Region', 'Monthly rent', 'Occupancy', 'Verified', 'Status'].map((h) => <th key={h} className="text-left px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                <tbody>
                  {(data.property_list ?? []).map((r: any) => (
                    <tr key={r.listing_id} className="border-t border-border">
                      <td className="px-3 py-2">{r.district}</td>
                      <td className="px-3 py-2">{r.region}</td>
                      <td className="px-3 py-2">{formatUGX(n(r.monthly_rent))}</td>
                      <td className="px-3 py-2">{r.occupied ? 'Occupied' : 'Vacant'}</td>
                      <td className="px-3 py-2">{r.verified ? 'Yes' : 'No'}</td>
                      <td className="px-3 py-2">{r.status}</td>
                    </tr>
                  ))}
                  {(data.property_list ?? []).length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No listings on file.</td></tr>}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="wallet" className="space-y-4 mt-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat label="Total commission earned" value={formatUGX(n(cm.earned))} />
            <Stat label="Commission paid" value={formatUGX(n(cm.paid))} tone="good" />
            <Stat label="Commission pending" value={formatUGX(n(cm.pending))} tone="warn" />
            <Stat label="Commission events" value={n(cm.count)} />
            <Stat label="Wallet balance" value={formatUGX(n(w?.balance))} />
            <Stat label="Withdrawable" value={formatUGX(n(w?.withdrawable))} tone="good" />
            <Stat label="Float (company money)" value={formatUGX(n(w?.float))} />
            <Stat label="Advance (liability)" value={formatUGX(n(w?.advance))} tone="bad" />
            <Stat label="Withdrawals requested" value={formatUGX(n(wd.total))} />
            <Stat label="Withdrawals completed" value={formatUGX(n(wd.completed))} tone="good" />
            <Stat label="Withdrawals pending" value={formatUGX(n(wd.pending))} tone="warn" />
            <Stat label="Failed / rejected" value={formatUGX(n(wd.failed))} tone="bad" />
            <Stat label="Avg commission per property" value={formatUGX(n(pr.total) > 0 ? Math.round(n(cm.earned) / n(pr.total)) : 0)} />
            <Stat label="Avg commission per tenant" value={formatUGX(n(t.total) > 0 ? Math.round(n(cm.earned) / n(t.total)) : 0)} />
          </div>
        </TabsContent>

        <TabsContent value="risk" className="space-y-4 mt-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat label="High risk tenants (14d+ behind)" value={n(t.high_risk)} tone="bad" />
            <Stat label="Medium risk (5–13d behind)" value={n(t.medium_risk)} tone="warn" />
            <Stat label="Low risk (<5d behind)" value={n(t.low_risk)} tone="good" />
            <Stat label="Exposure at risk" value={formatUGX(n(t.exposure_at_risk))} tone="bad" />
            <Stat label="Arrears rate" value={pct(n(t.arrears), n(t.active))} />
            <Stat label="Recovery rate" value={pct(n(f.collected_to_date), n(f.portfolio_value))} />
            <Stat label="Portfolio risk score" value={`${Math.min(100, Math.round(((n(t.high_risk) * 2 + n(t.medium_risk)) / Math.max(n(t.active), 1)) * 50))} / 100`} />
            <Stat label="Defaulted / ended with balance" value={n(t.ended_leases)} />
          </div>
          <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            Risk bands are computed from how many daily instalments a tenant is behind on their own rent plan
            (arrears ÷ daily repayment). No external credit data is used.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
