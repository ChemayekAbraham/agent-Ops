/**
 * Presentation only. The administrative chain itself (region -> village) is
 * read straight from tops_area_book / tops_agent_area_coverage, which in
 * turn read only the EXISTING v_tlb_tenant_base resolver — no location
 * logic is re-derived here. Arrears/money-at-risk figures come from
 * tops_plan_instalments via the same internal helper every other arrears
 * reading in this workspace already shares.
 */
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatUGX } from '@/lib/rentCalculations';
import { useAreaBook, type AreaLevel } from '@/hooks/tenantOpsWorkspace/useAreaBook';
import { useAgentAreaCoverage } from '@/hooks/tenantOpsWorkspace/useAgentAreaCoverage';
import { useUnmappedTenantsWorklist } from '@/hooks/tenantOpsWorkspace/useUnmappedTenantsWorklist';

const LEVELS: { key: AreaLevel; label: string }[] = [
  { key: 'region', label: 'Region' },
  { key: 'district', label: 'District' },
  { key: 'subcounty', label: 'Subcounty' },
  { key: 'village', label: 'Village' },
];

const CORRECTION_HUB_URL = '/executive-hub?tab=tenant-ops&mode=classic&view=location-corrections';
const COVERAGE_PAGE_SIZE = 50;

export default function PlacesSection() {
  const [level, setLevel] = useState<AreaLevel>('district');
  const [coveragePage, setCoveragePage] = useState(0);
  const areaBook = useAreaBook(level, null);
  const coverage = useAgentAreaCoverage(level, COVERAGE_PAGE_SIZE, coveragePage * COVERAGE_PAGE_SIZE);
  const unmapped = useUnmappedTenantsWorklist(200);

  const changeLevel = (next: AreaLevel) => {
    setLevel(next);
    setCoveragePage(0);
  };

  const coverageTotal = coverage.data?.total_row_count ?? 0;
  const coveragePageCount = Math.max(1, Math.ceil(coverageTotal / COVERAGE_PAGE_SIZE));

  return (
    <div className="space-y-4">
      <Tabs value={level} onValueChange={(v) => changeLevel(v as AreaLevel)}>
        <TabsList>
          {LEVELS.map((l) => (
            <TabsTrigger key={l.key} value={l.key}>{l.label}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Arrears rate and money at risk by {level}</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            The administrative chain and area resolution reuse the existing location breakdown as-is — a tenant it
            cannot resolve at this level appears under "Unmapped".
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Area</TableHead>
                  <TableHead className="text-xs">Region</TableHead>
                  <TableHead className="text-xs">Plans</TableHead>
                  <TableHead className="text-xs">In arrears</TableHead>
                  <TableHead className="text-xs">Arrears rate</TableHead>
                  <TableHead className="text-xs">Money at risk</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(areaBook.data ?? []).map((row, i) => (
                  <TableRow key={row.area_key ?? `unmapped-${i}`}>
                    <TableCell className="text-xs">{row.area_name}</TableCell>
                    <TableCell className="text-xs">{row.region ?? '—'}</TableCell>
                    <TableCell className="text-xs">{row.plan_count}</TableCell>
                    <TableCell className="text-xs">{row.arrears_plan_count}</TableCell>
                    <TableCell className="text-xs">
                      {row.arrears_rate == null ? '—' : `${Math.round(row.arrears_rate * 1000) / 10}%`}
                    </TableCell>
                    <TableCell className="text-xs font-medium">{formatUGX(row.money_at_risk_ugx)}</TableCell>
                  </TableRow>
                ))}
                {(areaBook.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-xs text-muted-foreground">
                      {areaBook.isLoading ? 'Loading…' : 'No areas found.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Agent coverage by {level}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Area</TableHead>
                  <TableHead className="text-xs">Agent</TableHead>
                  <TableHead className="text-xs">Plans</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(coverage.data?.rows ?? []).map((row, i) => (
                  <TableRow key={`${row.area_key ?? 'unmapped'}-${row.agent_id}-${i}`}>
                    <TableCell className="text-xs">{row.area_name}</TableCell>
                    <TableCell className="text-xs">{row.agent_name ?? 'Unnamed'}</TableCell>
                    <TableCell className="text-xs">{row.plan_count}</TableCell>
                  </TableRow>
                ))}
                {(coverage.data?.rows ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-xs text-muted-foreground">
                      {coverage.isLoading ? 'Loading…' : 'No coverage rows.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {coverageTotal > 0 && (
            <div className="flex items-center justify-between pt-2">
              <Button
                variant="outline"
                size="sm"
                disabled={coveragePage === 0}
                onClick={() => setCoveragePage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <p className="text-xs text-muted-foreground">
                Page {coveragePage + 1} of {coveragePageCount} ({coverageTotal} total)
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={coveragePage >= coveragePageCount - 1}
                onClick={() => setCoveragePage((p) => Math.min(coveragePageCount - 1, p + 1))}
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            Unmapped tenants
            <Badge variant="outline" className="text-[10px]">{unmapped.data?.length ?? 0}</Badge>
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            A finite worklist — every tenant on a live plan with no resolvable district. Corrections happen on the
            existing surface, opened in a new tab.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button asChild variant="outline" size="sm">
            <a href={CORRECTION_HUB_URL} target="_blank" rel="noopener noreferrer">
              Open Tenant Location Corrections
            </a>
          </Button>
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Tenant</TableHead>
                  <TableHead className="text-xs">Agent</TableHead>
                  <TableHead className="text-xs">Legacy location text</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(unmapped.data ?? []).map((row) => (
                  <TableRow key={row.rent_request_id}>
                    <TableCell className="text-xs">{row.tenant_name ?? 'Unnamed'}</TableCell>
                    <TableCell className="text-xs">{row.agent_name ?? '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.legacy_location ?? '—'}</TableCell>
                  </TableRow>
                ))}
                {(unmapped.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-xs text-muted-foreground">
                      {unmapped.isLoading ? 'Loading…' : 'None — every live tenant resolves to a district.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
