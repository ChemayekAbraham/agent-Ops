/**
 * Presentation only — every figure comes from a tops_ RPC. This tab is about
 * the agent's own liquidity and conduct, not the tenant's willingness to pay:
 * a tenant who would not pay is a credit event; an agent who could not
 * collect is a liquidity event. Nothing here computes an incentive figure or
 * a league-table rank for an agent.
 */
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatUGX } from '@/lib/rentCalculations';
import { useAgentFloatAdequacy } from '@/hooks/tenantOpsWorkspace/useAgentFloatAdequacy';
import { useAgentAttainment } from '@/hooks/tenantOpsWorkspace/useAgentAttainment';
import { useAgentCapacityEligibility } from '@/hooks/tenantOpsWorkspace/useAgentCapacityEligibility';
import { useAgentArrearsBook, type ArrearsBucketKey } from '@/hooks/tenantOpsWorkspace/useAgentArrearsBook';
import { useAgentIntegritySignals } from '@/hooks/tenantOpsWorkspace/useAgentIntegritySignals';

const BUCKETS: ArrearsBucketKey[] = ['1-7', '8-14', '15-30', '30+'];

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 1000) / 10}%`);

export default function AgentsSection() {
  const [floatAsAt, setFloatAsAt] = useState(todayIso());
  const [attainFrom, setAttainFrom] = useState(daysAgoIso(7));
  const [attainTo, setAttainTo] = useState(todayIso());
  const [bookAsAt, setBookAsAt] = useState(todayIso());
  const [integrityFrom, setIntegrityFrom] = useState(daysAgoIso(30));
  const [integrityTo, setIntegrityTo] = useState(todayIso());

  const floatAdequacy = useAgentFloatAdequacy(floatAsAt);
  const attainment = useAgentAttainment(attainFrom, attainTo);
  const capacity = useAgentCapacityEligibility();
  const arrearsBook = useAgentArrearsBook(bookAsAt);
  const integrity = useAgentIntegritySignals(integrityFrom, integrityTo);

  // All four RPCs below already return server-sorted rows (shortfall desc,
  // agent name asc, effective_pct asc, signal count desc respectively) — no
  // client-side re-sort needed.
  const sortedFloat = floatAdequacy.data ?? [];
  const sortedAttainment = attainment.data ?? [];
  const sortedCapacity = capacity.data ?? [];
  const sortedIntegrity = integrity.data ?? [];

  return (
    <div className="space-y-4">
      <Card className="border shadow-sm">
        <CardContent className="py-3">
          <p className="text-xs text-muted-foreground">
            A tenant who would not pay is a <span className="font-semibold text-foreground">credit event</span> — that
            belongs in Collections and Calling. An agent who could not collect is a{' '}
            <span className="font-semibold text-foreground">liquidity event</span> — that is what this tab is for.
          </p>
        </CardContent>
      </Card>

      {/* 1. Float adequacy */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            Float adequacy
            <label className="ml-auto flex items-center gap-2 text-xs font-normal text-muted-foreground">
              As at
              <Input type="date" value={floatAsAt} onChange={(e) => setFloatAsAt(e.target.value)} className="h-8 w-40" />
            </label>
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Sorted by shortfall. A ratio below 1.0 means the agent's own float cannot cover what is pinned as due — flagged below.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Agent</TableHead>
                  <TableHead className="text-xs">Float balance</TableHead>
                  <TableHead className="text-xs">Expected obligation</TableHead>
                  <TableHead className="text-xs">Adequacy ratio</TableHead>
                  <TableHead className="text-xs">Shortfall</TableHead>
                  <TableHead className="text-xs">Tenants at risk</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedFloat.map((row) => (
                  <TableRow key={row.agent_id}>
                    <TableCell className="text-xs">{row.agent_name ?? 'Unnamed'}</TableCell>
                    <TableCell className="text-xs">{formatUGX(row.float_balance_ugx)}</TableCell>
                    <TableCell className="text-xs">{formatUGX(row.expected_obligation_ugx)}</TableCell>
                    <TableCell className="text-xs">
                      {row.adequacy_ratio == null ? (
                        '—'
                      ) : (
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${row.adequacy_ratio < 1 ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success'}`}
                        >
                          {row.adequacy_ratio.toFixed(2)}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{formatUGX(row.shortfall_ugx)}</TableCell>
                    <TableCell className="text-xs">{row.tenants_at_risk}</TableCell>
                  </TableRow>
                ))}
                {sortedFloat.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-xs text-muted-foreground">
                      {floatAdequacy.isLoading ? 'Loading…' : 'No active agents found.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* 2. Attainment */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            Attainment
            <div className="ml-auto flex items-center gap-2 text-xs font-normal text-muted-foreground">
              <Input type="date" value={attainFrom} onChange={(e) => setAttainFrom(e.target.value)} className="h-8 w-40" />
              to
              <Input type="date" value={attainTo} onChange={(e) => setAttainTo(e.target.value)} className="h-8 w-40" />
            </div>
          </CardTitle>
          <p className="text-[11px] text-warning">
            Attribution between the agent billed and the agent who actually collected is unsettled — a plan reassigned
            mid-cycle can be billed to one agent and collected under another. This is not a settled attribution, and it
            carries no incentive figure and no ranking.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Agent</TableHead>
                  <TableHead className="text-xs">Expected</TableHead>
                  <TableHead className="text-xs">Collected on schedule</TableHead>
                  <TableHead className="text-xs">Coverage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedAttainment.map((row) => (
                  <TableRow key={row.agent_id}>
                    <TableCell className="text-xs">{row.agent_name ?? 'Unnamed'}</TableCell>
                    <TableCell className="text-xs">{formatUGX(row.expected_ugx)}</TableCell>
                    <TableCell className="text-xs">{formatUGX(row.collected_on_schedule_ugx)}</TableCell>
                    <TableCell className="text-xs">{row.coverage_pct == null ? '—' : `${row.coverage_pct}%`}</TableCell>
                  </TableRow>
                ))}
                {sortedAttainment.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-xs text-muted-foreground">
                      {attainment.isLoading ? 'Loading…' : 'No billed agents in this range.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* 3. Capacity and eligibility */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Capacity and eligibility</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            A direct read of the existing daily-eligibility gate (the same one that blocks new plans below 50%) — not
            recomputed here. That gate does not exclude reversed collections, so a same-day reversal can inflate a
            percentage below.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Agent</TableHead>
                  <TableHead className="text-xs">Active plans</TableHead>
                  <TableHead className="text-xs">Expected today</TableHead>
                  <TableHead className="text-xs">Today %</TableHead>
                  <TableHead className="text-xs">Effective %</TableHead>
                  <TableHead className="text-xs">Tenants due</TableHead>
                  <TableHead className="text-xs">Coverage today</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedCapacity.map((row) => (
                  <TableRow key={row.agent_id}>
                    <TableCell className="text-xs">{row.agent_name ?? 'Unnamed'}</TableCell>
                    <TableCell className="text-xs">{row.active_count}</TableCell>
                    <TableCell className="text-xs">{formatUGX(row.expected_daily)}</TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="outline" className={`text-[10px] ${row.today_pct < 0.5 ? 'bg-destructive/10 text-destructive' : ''}`}>
                        {pct(row.today_pct)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{pct(row.effective_pct)}</TableCell>
                    <TableCell className="text-xs">{row.tenants_due}</TableCell>
                    <TableCell className="text-xs">{pct(row.coverage_today)}</TableCell>
                  </TableRow>
                ))}
                {sortedCapacity.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-xs text-muted-foreground">
                      {capacity.isLoading ? 'Loading…' : 'No rows.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* 4. Book by arrears bucket */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            Their book by arrears bucket
            <label className="ml-auto flex items-center gap-2 text-xs font-normal text-muted-foreground">
              As at
              <Input type="date" value={bookAsAt} onChange={(e) => setBookAsAt(e.target.value)} className="h-8 w-40" />
            </label>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Agent</TableHead>
                  {BUCKETS.map((b) => (
                    <TableHead key={b} className="text-xs">{b} days</TableHead>
                  ))}
                  <TableHead className="text-xs">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {arrearsBook.byAgent.map((row) => (
                  <TableRow key={row.agentId}>
                    <TableCell className="text-xs">{row.agentName ?? 'Unnamed'}</TableCell>
                    {BUCKETS.map((b) => (
                      <TableCell key={b} className="text-xs">
                        {row.byBucket[b].planCount > 0 ? (
                          <>
                            {formatUGX(row.byBucket[b].arrearsUgx)}
                            <span className="text-muted-foreground"> ({row.byBucket[b].planCount})</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    ))}
                    <TableCell className="text-xs font-medium">{formatUGX(row.totalArrearsUgx)}</TableCell>
                  </TableRow>
                ))}
                {arrearsBook.byAgent.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={BUCKETS.length + 2} className="text-center text-xs text-muted-foreground">
                      {arrearsBook.isLoading ? 'Loading…' : 'No open arrears.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* 5. Integrity signals */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            Integrity signals
            <div className="ml-auto flex items-center gap-2 text-xs font-normal text-muted-foreground">
              <Input type="date" value={integrityFrom} onChange={(e) => setIntegrityFrom(e.target.value)} className="h-8 w-40" />
              to
              <Input type="date" value={integrityTo} onChange={(e) => setIntegrityTo(e.target.value)} className="h-8 w-40" />
            </div>
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Reversed collections, manual balance-correction frequency, and transfer churn — each a count of an
            already-recorded event, nothing inferred or scored.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Agent</TableHead>
                  <TableHead className="text-xs">Reversed collections</TableHead>
                  <TableHead className="text-xs">Reversed amount</TableHead>
                  <TableHead className="text-xs">Balance corrections</TableHead>
                  <TableHead className="text-xs">Transfer churn</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedIntegrity.map((row) => (
                  <TableRow key={row.agent_id}>
                    <TableCell className="text-xs">{row.agent_name ?? 'Unnamed'}</TableCell>
                    <TableCell className="text-xs">{row.reversed_collections_count}</TableCell>
                    <TableCell className="text-xs">{formatUGX(row.reversed_collections_ugx)}</TableCell>
                    <TableCell className="text-xs">{row.balance_correction_count}</TableCell>
                    <TableCell className="text-xs">{row.transfer_churn_count}</TableCell>
                  </TableRow>
                ))}
                {sortedIntegrity.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-xs text-muted-foreground">
                      {integrity.isLoading ? 'Loading…' : 'No rows.'}
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
