import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import {
  PromissoryOpsActionDialog,
  type OpsAction,
  type OpsActionTarget,
} from './PromissoryOpsActionDialog';
import {
  AlertTriangle,
  ArrowUpDown,
  BellOff,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Flame,
  ListOrdered,
  Phone,
  RotateCcw,
  Search,
  Timer,
  UserPlus,
} from 'lucide-react';


/**
 * Read-only Partner Ops conversion queue for the Promissory Notes page.
 *
 * Ranks every OPEN (status 'pending') promise by how much money it represents
 * and how late it is against the date the partner promised, then labels an
 * escalation tier. Promises more than 7 days late land in the escalated tier
 * automatically (derived, not stored).
 *
 * Nothing here writes: no status changes, no wallet or ledger effect, no
 * change to the existing partner/agent reminder schedules.
 */

interface QueueNote {
  id: string;
  partner_name: string;
  phone_number: string | null;
  whatsapp_number: string | null;
  agent_id: string;
  amount: number;
  status: string;
  recorded_on: string;
  fulfilment_due_on: string | null;
  follow_up_status: string | null;
  last_followed_up_on: string | null;
}

const dayMs = 86400000;
const asDate = (d: string) => new Date(`${d}T00:00:00`);

/** Today in Kampala (UTC+3), as a plain YYYY-MM-DD date. */
function kampalaToday() {
  const now = new Date();
  const k = new Date(now.getTime() + 3 * 3600_000);
  return k.toISOString().slice(0, 10);
}

type Tier = 'escalated' | 'chasing' | 'due_soon' | 'grace';

const TIERS: Record<Tier, { label: string; hint: string; cls: string }> = {
  escalated: {
    label: 'Escalated',
    hint: 'more than 7 days past the promised date',
    cls: 'bg-red-50 border-red-200 text-red-700',
  },
  chasing: {
    label: 'Chasing',
    hint: '1–7 days past the promised date',
    cls: 'bg-amber-50 border-amber-200 text-amber-700',
  },
  due_soon: {
    label: 'Due soon',
    hint: 'promised date today or ahead',
    cls: 'bg-sky-50 border-sky-200 text-sky-700',
  },
  grace: {
    label: 'No promised date',
    hint: 'no date given yet — agent to confirm one',
    cls: 'bg-muted border-border text-muted-foreground',
  },
};

interface RankedNote extends QueueNote {
  daysOverdue: number | null;
  ageDays: number;
  tier: Tier;
  score: number;
}

export function PromissoryConversionQueue() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<Tier | 'all'>('all');
  const [sortBy, setSortBy] = useState<'score' | 'amount' | 'overdue'>('score');

  const { data: notes = [], isLoading, isError, error } = useQuery({
    queryKey: ['promissory-conversion-queue'],
    enabled: open,
    staleTime: 120_000,
    queryFn: async () => {
      // PostgREST caps a single response at ~1000 rows; page through so the
      // queue covers every open promise.
      const pageSize = 1000;
      const all: QueueNote[] = [];
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await supabase
          .from('promissory_notes')
          .select('id, partner_name, phone_number, whatsapp_number, agent_id, amount, status, recorded_on, fulfilment_due_on, follow_up_status, last_followed_up_on')
          .eq('status', 'pending')
          .order('recorded_on', { ascending: false })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        all.push(...((data || []) as QueueNote[]));
        if (!data || data.length < pageSize) break;
      }
      return all;
    },
  });

  const agentIds = useMemo(
    () => Array.from(new Set(notes.map(n => n.agent_id).filter(Boolean))),
    [notes],
  );

  const { data: agentNames = {} } = useQuery({
    queryKey: ['promissory-conversion-agent-names', agentIds],
    enabled: open && agentIds.length > 0,
    staleTime: 300_000,
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', agentIds);
        if (error) return {};
        const map: Record<string, string> = {};
        for (const p of data || []) map[(p as any).id] = (p as any).full_name || '';
        return map;
      } catch {
        return {};
      }
    },
  });

  const ranked = useMemo<RankedNote[]>(() => {
    if (!notes.length) return [];
    const today = asDate(kampalaToday()).getTime();
    const maxAmount = Math.max(...notes.map(n => Number(n.amount || 0)), 1);

    return notes
      .map(n => {
        const amount = Number(n.amount || 0);
        const daysOverdue = n.fulfilment_due_on
          ? Math.floor((today - asDate(n.fulfilment_due_on).getTime()) / dayMs)
          : null;
        const ageDays = Math.max(0, Math.floor((today - asDate(n.recorded_on).getTime()) / dayMs));

        const tier: Tier =
          daysOverdue === null ? 'grace'
            : daysOverdue > 7 ? 'escalated'
              : daysOverdue >= 1 ? 'chasing'
                : 'due_soon';

        // Transparent 0–100 ranking: 60 parts size, 40 parts lateness
        // (lateness saturates at 30 days so one ancient promise can't bury
        // a large fresh one).
        const amountScore = Math.min(1, amount / maxAmount);
        const lateness = daysOverdue !== null ? Math.max(0, daysOverdue) : Math.max(0, ageDays - 7);
        const overdueScore = Math.min(1, lateness / 30);
        const score = Math.round(amountScore * 60 + overdueScore * 40);

        return { ...n, daysOverdue, ageDays, tier, score };
      })
      .sort((a, b) => {
        if (sortBy === 'amount') return Number(b.amount) - Number(a.amount);
        if (sortBy === 'overdue') return (b.daysOverdue ?? -999) - (a.daysOverdue ?? -999);
        return b.score - a.score;
      });
  }, [notes, sortBy]);

  const totals = useMemo(() => {
    const by = (t: Tier) => ranked.filter(n => n.tier === t);
    const sum = (rows: RankedNote[]) => rows.reduce((s, n) => s + Number(n.amount || 0), 0);
    const esc = by('escalated');
    return {
      openCount: ranked.length,
      openValue: sum(ranked),
      escalatedCount: esc.length,
      escalatedValue: sum(esc),
      chasingCount: by('chasing').length,
      chasingValue: sum(by('chasing')),
      dueSoonCount: by('due_soon').length,
      noDateCount: by('grace').length,
      topTenValue: sum(ranked.slice().sort((a, b) => b.score - a.score).slice(0, 10)),
    };
  }, [ranked]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ranked.filter(n => {
      if (tierFilter !== 'all' && n.tier !== tierFilter) return false;
      if (!q) return true;
      return (
        (n.partner_name || '').toLowerCase().includes(q) ||
        (n.phone_number || '').includes(q) ||
        (agentNames[n.agent_id] || '').toLowerCase().includes(q)
      );
    });
  }, [ranked, tierFilter, search, agentNames]);

  return (
    <Card className="border-primary/20">
      <CardContent className="p-3 space-y-3">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="w-full flex items-center justify-between gap-2 text-left"
        >
          <span className="flex items-center gap-2">
            <ListOrdered className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">Conversion queue</span>
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              open promises ranked by size and how late they are
            </span>
          </span>
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>

        {open && (
          <>
            {isLoading ? (
              <p className="text-xs text-muted-foreground py-4 text-center">Loading the queue…</p>
            ) : isError ? (
              <p className="text-xs text-destructive py-2">
                Could not load the queue: {(error as any)?.message}
              </p>
            ) : (
              <>
                {/* Headline tiles */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                  <div className="rounded-lg border bg-muted/40 p-2.5">
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <ListOrdered className="h-3 w-3" /> Open promises
                    </p>
                    <p className="text-base font-bold mt-0.5">{formatUGX(totals.openValue)}</p>
                    <p className="text-[10px] text-muted-foreground">{totals.openCount} waiting to convert</p>
                  </div>
                  <div className="rounded-lg border bg-red-50 border-red-200 p-2.5">
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Flame className="h-3 w-3" /> Escalated (7+ days late)
                    </p>
                    <p className="text-base font-bold mt-0.5">{formatUGX(totals.escalatedValue)}</p>
                    <p className="text-[10px] text-muted-foreground">{totals.escalatedCount} promises</p>
                  </div>
                  <div className="rounded-lg border bg-amber-50 border-amber-200 p-2.5">
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Timer className="h-3 w-3" /> Chasing (1–7 days late)
                    </p>
                    <p className="text-base font-bold mt-0.5">{formatUGX(totals.chasingValue)}</p>
                    <p className="text-[10px] text-muted-foreground">{totals.chasingCount} promises</p>
                  </div>
                  <div className="rounded-lg border bg-sky-50 border-sky-200 p-2.5">
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <ArrowUpDown className="h-3 w-3" /> Top 10 priority
                    </p>
                    <p className="text-base font-bold mt-0.5">{formatUGX(totals.topTenValue)}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {totals.dueSoonCount} due soon · {totals.noDateCount} with no promised date
                    </p>
                  </div>
                </div>

                {/* Controls */}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 min-w-[180px]">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search partner, phone or agent"
                      className="h-8 pl-7 text-xs"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(['all', 'escalated', 'chasing', 'due_soon', 'grace'] as const).map(t => (
                      <Button
                        key={t}
                        type="button"
                        size="sm"
                        variant={tierFilter === t ? 'default' : 'outline'}
                        className="h-7 text-[11px] px-2"
                        onClick={() => setTierFilter(t)}
                      >
                        {t === 'all' ? 'All' : TIERS[t].label}
                      </Button>
                    ))}
                  </div>
                  <div className="flex gap-1">
                    {([['score', 'Priority'], ['amount', 'Amount'], ['overdue', 'Days late']] as const).map(([key, label]) => (
                      <Button
                        key={key}
                        type="button"
                        size="sm"
                        variant={sortBy === key ? 'secondary' : 'ghost'}
                        className="h-7 text-[11px] px-2"
                        onClick={() => setSortBy(key)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>

                {totals.escalatedCount > 0 && (
                  <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5">
                    <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
                    <p className="text-[11px] text-red-700">
                      <span className="font-semibold">{totals.escalatedCount} promises ({formatUGX(totals.escalatedValue)})</span>{' '}
                      are more than 7 days past the date the partner gave. They move into the escalated tier
                      automatically and should be taken off the recording agent and handled by a Partner Ops lead.
                    </p>
                  </div>
                )}

                {/* Queue */}
                <div className="space-y-1.5 max-h-[520px] overflow-y-auto">
                  {visible.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-4 text-center">No open promises match.</p>
                  ) : (
                    visible.map((n, idx) => {
                      const tier = TIERS[n.tier];
                      return (
                        <div
                          key={n.id}
                          className={cn('rounded-lg border p-2.5 flex items-start gap-3', tier.cls)}
                        >
                          <div className="w-7 shrink-0 text-center">
                            <p className="text-xs font-bold">#{idx + 1}</p>
                            <p className="text-[9px] opacity-70">{n.score}</p>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm font-semibold truncate">{n.partner_name || 'Unnamed partner'}</span>
                              <Badge variant="outline" className="text-[9px] px-1 py-0 bg-white/60">
                                {tier.label}
                              </Badge>
                              <span className="text-sm font-bold ml-auto">{formatUGX(Number(n.amount || 0))}</span>
                            </div>
                            <p className="text-[10px] opacity-80 mt-0.5">
                              {n.daysOverdue === null
                                ? `No promised date · recorded ${n.ageDays} day${n.ageDays === 1 ? '' : 's'} ago`
                                : n.daysOverdue > 0
                                  ? `${n.daysOverdue} day${n.daysOverdue === 1 ? '' : 's'} late · promised ${n.fulfilment_due_on}`
                                  : n.daysOverdue === 0
                                    ? `Promised today (${n.fulfilment_due_on})`
                                    : `Due in ${Math.abs(n.daysOverdue)} day${Math.abs(n.daysOverdue) === 1 ? '' : 's'} · ${n.fulfilment_due_on}`}
                            </p>
                            <p className="text-[10px] opacity-70">
                              Agent: {agentNames[n.agent_id] || 'Unknown'}
                              {n.phone_number ? ` · ${n.phone_number}` : ''}
                              {n.last_followed_up_on ? ` · last follow-up ${n.last_followed_up_on}` : ' · no follow-up logged'}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <p className="text-[10px] text-muted-foreground">
                  Priority score = 60% promise size + 40% lateness (lateness counted up to 30 days). Read-only view —
                  partners keep getting their Monday/Wednesday/Friday reminder and agents their own chase; nothing here
                  changes a promise, a wallet or any record.
                </p>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
