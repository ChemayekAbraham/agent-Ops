import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ChevronDown, FileDown } from 'lucide-react';
import { downloadDormantAgentsPdf, type DormantAgentsReport } from '@/lib/dormantAgentsPdf';

type DormantTenant = {
  rent_request_id: string;
  tenant_name: string;
  tenant_phone: string | null;
  daily_amount: number;
  arrears: number;
  outstanding: number;
  plan_total: number;
  repaid: number;
  term_start: string;
  obligation_end: string;
  days_past_term: number;
  last_paid_on: string | null;
};

type DormantAgent = {
  agent_id: string;
  agent_name: string;
  agent_phone: string | null;
  last_collection_on: string | null;
  never_collected: boolean;
  days_silent: number | null;
  tenants_owing: number;
  arrears_ugx: number;
  outstanding_ugx: number;
  tenants: DormantTenant[];
};

type DormantResponse = {
  as_of: string;
  silent_days: number;
  timezone: string;
  totals: {
    agents: number;
    agents_never_collected: number;
    tenants_owing: number;
    arrears_ugx: number;
    outstanding_ugx: number;
  };
  agents: DormantAgent[];
  generated_at: string;
};

const num = (v: any) => Number(v ?? 0);

export function DormantAgentsDialog({
  asOf,
  open,
  onOpenChange,
}: {
  asOf: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [silentDays, setSilentDays] = useState(7);
  const [mode, setMode] = useState<'silent' | 'not_scheduled'>('silent');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { data, isPending, error } = useQuery({
    queryKey: ['agent-ops-dormant-agents', asOf, silentDays, mode],
    enabled: open,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_dormant_agents_arrears' as any, {
        p_silent_days: silentDays,
        p_as_of: asOf,
        p_mode: mode,
      });
      if (error) throw new Error(error.message);
      return data as unknown as DormantResponse;
    },
  });

  const totals = data?.totals;
  const agents = data?.agents ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Agents gone quiet with money owed</DialogTitle>
          <DialogDescription>
            {mode === 'not_scheduled' ? (
              <>
                As at {data?.as_of ?? asOf} · East Africa Time · tenants in arrears whose agent has
                no instalment falling due today
              </>
            ) : (
              <>
                As at {data?.as_of ?? asOf} · East Africa Time · no collection recorded for{' '}
                {data?.silent_days ?? silentDays} days or more
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[85vh] overflow-y-auto space-y-3 pr-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="h-8 text-xs min-h-11 sm:min-h-8"
              variant={mode === 'silent' ? 'default' : 'outline'}
              onClick={() => setMode('silent')}
            >
              Gone quiet
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs min-h-11 sm:min-h-8"
              variant={mode === 'not_scheduled' ? 'default' : 'outline'}
              onClick={() => setMode('not_scheduled')}
            >
              Not on today's schedule
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground">
            {mode === 'not_scheduled'
              ? 'Agents holding tenants in arrears who have nothing scheduled today, so they do not appear anywhere in the schedule above. These balances are invisible in the daily view.'
              : 'Agents who have recorded no collection for the selected number of days, while still holding tenants in arrears.'}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {mode === 'silent' &&
              [7, 14, 30].map((d) => (
                <Button
                  key={d}
                  size="sm"
                  className="h-8 text-xs"
                  variant={silentDays === d ? 'default' : 'outline'}
                  onClick={() => setSilentDays(d)}
                >
                  {d}+ days
                </Button>
              ))}
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs ml-auto min-h-11"
              disabled={isPending || agents.length === 0}
              onClick={() => data && downloadDormantAgentsPdf(data as DormantAgentsReport)}
            >
              <FileDown className="h-3.5 w-3.5 mr-1" /> Download PDF
            </Button>
          </div>

          {error && (
            <p className="text-sm text-destructive">{(error as Error).message}</p>
          )}

          {isPending && !error && (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded-md bg-muted animate-pulse" />
              ))}
            </div>
          )}

          {!isPending && !error && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                <Card className="p-3">
                  <div className="text-xs text-muted-foreground">Agents</div>
                  <p className="text-lg font-bold mt-1">{num(totals?.agents)}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {num(totals?.agents_never_collected)} have never collected
                  </p>
                </Card>
                <Card className="p-3">
                  <div className="text-xs text-muted-foreground">Tenants owing</div>
                  <p className="text-lg font-bold mt-1">{num(totals?.tenants_owing)}</p>
                </Card>
                <Card className="p-3">
                  <div className="text-xs text-muted-foreground">Arrears</div>
                  <p className="text-lg font-bold mt-1 text-destructive">
                    {formatUGX(num(totals?.arrears_ugx))}
                  </p>
                  <p className="text-[11px] text-muted-foreground">owed and overdue</p>
                </Card>
                <Card className="p-3">
                  <div className="text-xs text-muted-foreground">Outstanding</div>
                  <p className="text-lg font-bold mt-1">{formatUGX(num(totals?.outstanding_ugx))}</p>
                  <p className="text-[11px] text-muted-foreground">full remaining balance</p>
                </Card>
              </div>

              {agents.length === 0 && (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  No agents are silent for {silentDays} days or more with money owed.
                </p>
              )}

              <div className="space-y-2">
                {agents.map((a) => {
                  const isOpen = !!expanded[a.agent_id];
                  return (
                    <div key={a.agent_id} className="border rounded-md">
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((prev) => ({ ...prev, [a.agent_id]: !prev[a.agent_id] }))
                        }
                        className="w-full flex items-start justify-between gap-3 p-3 text-left min-h-11"
                      >
                        <div className="flex items-start gap-2 min-w-0">
                          <ChevronDown
                            className={`h-4 w-4 mt-0.5 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                          />
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{a.agent_name}</div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {a.agent_phone || '—'} · {num(a.tenants_owing)} tenants
                            </div>
                            <div className="mt-1">
                              {a.never_collected ? (
                                <Badge variant="destructive" className="text-[10px]">
                                  Never collected
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px]">
                                  Silent {a.days_silent} days · last {a.last_collection_on}
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-bold text-destructive tabular-nums">
                            {formatUGX(num(a.arrears_ugx))}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            of {formatUGX(num(a.outstanding_ugx))} outstanding
                          </div>
                        </div>
                      </button>

                      {isOpen && (
                        <div className="border-t overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead className="bg-muted/50">
                              <tr className="text-muted-foreground">
                                <th className="text-left font-medium p-2">Tenant</th>
                                <th className="text-left font-medium p-2">Phone</th>
                                <th className="text-right font-medium p-2">Arrears</th>
                                <th className="text-right font-medium p-2">Outstanding</th>
                                <th className="text-right font-medium p-2">Daily</th>
                                <th className="text-left font-medium p-2">Term start</th>
                                <th className="text-left font-medium p-2">Obligation end</th>
                                <th className="text-right font-medium p-2">Days past term</th>
                                <th className="text-left font-medium p-2">Last paid</th>
                              </tr>
                            </thead>
                            <tbody>
                              {a.tenants.map((t) => (
                                <tr key={t.rent_request_id} className="border-t">
                                  <td className="p-2">{t.tenant_name}</td>
                                  <td className="p-2">{t.tenant_phone || '—'}</td>
                                  <td className="p-2 text-right tabular-nums text-destructive">
                                    {formatUGX(num(t.arrears))}
                                  </td>
                                  <td className="p-2 text-right tabular-nums">
                                    {formatUGX(num(t.outstanding))}
                                  </td>
                                  <td className="p-2 text-right tabular-nums">
                                    {formatUGX(num(t.daily_amount))}
                                  </td>
                                  <td className="p-2">{t.term_start}</td>
                                  <td className="p-2">{t.obligation_end}</td>
                                  <td className="p-2 text-right tabular-nums">
                                    {num(t.days_past_term)}
                                  </td>
                                  <td className="p-2">{t.last_paid_on ?? '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
