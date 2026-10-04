import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Target, Users } from 'lucide-react';
import { useServiceCentreCandidates } from '@/hooks/useServiceCentreCandidates';

const PAGE = 15;
const THRESHOLDS = [50, 60, 75, 90] as const;

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

/**
 * Agents who are at least half-way to earning a Service Centre.
 * Qualification rule lives in the database (sub-agents + personal active tenants),
 * so the requirement labels here are read from the same report, never hardcoded.
 */
export function ServiceCentreCandidatesPanel() {
  const [minProgress, setMinProgress] = useState<number>(50);
  const [page, setPage] = useState(0);
  const { data, isLoading } = useServiceCentreCandidates(minProgress, PAGE, page * PAGE);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Target className="h-4 w-4 text-primary" />
          Agents qualifying for a Service Centre
          <span className="ml-auto text-xs font-normal text-muted-foreground">{total} agents</span>
        </CardTitle>
        {data && (
          <p className="text-xs text-muted-foreground">
            Requirement: {data.required_sub_agents} verified sub-agents each with an active tenant, plus{' '}
            {data.required_main_agent_tenants} personal active tenants. Progress is the average of both.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {THRESHOLDS.map((t) => (
            <Button
              key={t}
              size="sm"
              variant={minProgress === t ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => { setMinProgress(t); setPage(0); }}
            >
              {t}%+
            </Button>
          ))}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No agent has reached {minProgress}% yet.</p>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead className="text-right">Sub-agents</TableHead>
                    <TableHead className="text-right">Personal tenants</TableHead>
                    <TableHead className="text-right">Network tenants</TableHead>
                    <TableHead>Progress</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.agent_id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-8 w-8">
                            {r.avatar_url && <AvatarImage src={r.avatar_url} alt={r.agent_name} />}
                            <AvatarFallback className="text-[10px]">{initials(r.agent_name)}</AvatarFallback>
                          </Avatar>
                          <span className="text-sm font-medium">{r.agent_name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">{r.agent_phone || '—'}</TableCell>
                      <TableCell className="text-xs">{[r.district, r.region].filter(Boolean).join(' · ') || '—'}</TableCell>
                      <TableCell className="text-right text-xs">
                        {r.qualifying_sub_agents}/{data?.required_sub_agents}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {r.main_agent_active_tenants}/{data?.required_main_agent_tenants}
                      </TableCell>
                      <TableCell className="text-right text-xs">{r.network_active_tenants}</TableCell>
                      <TableCell className="min-w-[120px]">
                        <div className="flex items-center gap-2">
                          <Progress value={Number(r.qualification_progress)} className="h-1.5" />
                          <span className="text-xs tabular-nums">{Number(r.qualification_progress)}%</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {r.is_qualified ? (
                          <Badge className="text-[10px]">Qualified</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">In progress</Badge>
                        )}
                        {r.existing_service_centres > 0 && (
                          <Badge variant="secondary" className="ml-1 text-[10px]">
                            {r.existing_service_centres} centre{r.existing_service_centres > 1 ? 's' : ''}
                          </Badge>
                        )}
                        {r.request_status && (
                          <p className="mt-1 text-[10px] capitalize text-muted-foreground">
                            {r.request_status.replace(/_/g, ' ')}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile cards */}
            <div className="space-y-2 md:hidden">
              {rows.map((r) => (
                <div key={r.agent_id} className="rounded-xl border border-border p-3">
                  <div className="flex items-center gap-2">
                    <Avatar className="h-8 w-8">
                      {r.avatar_url && <AvatarImage src={r.avatar_url} alt={r.agent_name} />}
                      <AvatarFallback className="text-[10px]">{initials(r.agent_name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{r.agent_name}</p>
                      <p className="text-xs text-muted-foreground">{r.agent_phone || '—'}</p>
                    </div>
                    <span className="ml-auto text-xs font-semibold tabular-nums">{Number(r.qualification_progress)}%</span>
                  </div>
                  <Progress value={Number(r.qualification_progress)} className="mt-2 h-1.5" />
                  <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                    <Users className="h-3 w-3" />
                    {r.qualifying_sub_agents}/{data?.required_sub_agents} sub-agents ·{' '}
                    {r.main_agent_active_tenants}/{data?.required_main_agent_tenants} personal tenants
                  </p>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-muted-foreground">Page {page + 1} of {pages}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
