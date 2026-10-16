import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, RotateCcw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { useMetricsTotals } from '@/hooks/useAgentOpsMetrics';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import {
  METRICS_PRESETS, clearMetricsParams, clearOrder, dropCard, metricsPresetOf, metricsPresetRange, moveCard, readMetricsParams, readOrder, writeMetricsParams, writeOrder,
  type CardId, type MetricsParams,
} from '@/lib/agentMetrics';
import type { CardControls } from './MetricsShared';
import { HeadlineCard } from './HeadlineCard';
import { ListingsCard } from './ListingsCard';
import { ListingEarningsCard } from './ListingEarningsCard';
import { AgentsCard } from './AgentsCard';
import { LocationsCard } from './LocationsCard';
import { MainAgentsCard } from './MainAgentsCard';
import { AdvancesCard } from './AdvancesCard';
import { ActivityExtrasCard } from './ActivityExtrasCard';

// "Metrics" tab of Agent Ops: stacked, collapsible cards (built for a 380px phone first) over the agent_ops_metrics_* functions. The dates,
// who to list and the sort live in the URL (?metrics=1&mfrom=&mto=&mscope=&msort=); the card order is kept per user in this browser.
// Every figure is shown exactly as the server returns it: no money arithmetic here.

export function AgentMetricsStandalone() {
  const [sp, setSp] = useSearchParams();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const today = kampalaTodayYmd();
  const params = useMemo(() => readMetricsParams(sp, today), [sp, today]);
  const preset = metricsPresetOf(params.from, params.to, today);
  const [customOpen, setCustomOpen] = useState(preset === 'custom');
  const showCustom = customOpen || preset === 'custom';

  const update = (patch: Partial<MetricsParams>) =>
    setSp((prev) => writeMetricsParams(prev, { ...readMetricsParams(prev, today), ...patch }), { replace: true });

  // keep the link in the address bar while this view is open, and take it out again when another chip is chosen
  const { from, to, scope, sort } = params;
  const setSpRef = useRef(setSp);
  setSpRef.current = setSp;
  useEffect(() => {
    setSpRef.current((prev) => writeMetricsParams(prev, { from, to, scope, sort }), { replace: true });
  }, [from, to, scope, sort]);
  useEffect(() => () => setSpRef.current((prev) => clearMetricsParams(prev), { replace: true }), []);

  // card order, per user
  const [order, setOrder] = useState<CardId[]>(() => readOrder(userId));
  useEffect(() => { setOrder(readOrder(userId)); }, [userId]);
  const save = useCallback((next: CardId[]) => { setOrder(next); writeOrder(userId, next); }, [userId]);
  const reset = () => { clearOrder(userId); setOrder(readOrder(userId)); };
  const [dragId, setDragId] = useState<CardId | null>(null);

  const totals = useMetricsTotals(from, to);

  const controlsFor = (id: CardId, index: number): CardControls => ({
    index,
    count: order.length,
    onUp: () => save(moveCard(order, index, -1)),
    onDown: () => save(moveCard(order, index, 1)),
    dragging: dragId === id,
    onDragStart: (e: DragEvent) => { setDragId(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); },
    onDragEnd: () => setDragId(null),
    onDragOver: (e: DragEvent) => { if (dragId) e.preventDefault(); },
    onDrop: (e: DragEvent) => { e.preventDefault(); if (dragId) save(dropCard(order, dragId, id)); setDragId(null); },
  });

  const render = (id: CardId, index: number) => {
    const controls = controlsFor(id, index);
    const common = { controls, totals, from, to };
    switch (id) {
      case 'headline': return <HeadlineCard key={id} {...common} />;
      case 'listings': return <ListingsCard key={id} {...common} />;
      case 'earnings': return <ListingEarningsCard key={id} {...common} />;
      case 'advances': return <AdvancesCard key={id} {...common} />;
      case 'activity': return <ActivityExtrasCard key={id} {...common} />;
      case 'agents': return <AgentsCard key={id} controls={controls} from={from} to={to} scope={scope} sort={sort} onScope={(s) => update({ scope: s })} onSort={(s) => update({ sort: s })} />;
      case 'locations': return <LocationsCard key={id} controls={controls} from={from} to={to} />;
      case 'main-agents': return <MainAgentsCard key={id} controls={controls} from={from} to={to} />;
    }
  };

  return (
    <div className="space-y-3" data-testid="agent-metrics-standalone">
      <Card className="space-y-3 p-3">
        <div className="flex items-start gap-2">
          <BarChart3 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-foreground">Metrics</p>
            <p className="text-xs text-muted-foreground">Listings, listing earnings, locations, teams and advances. Pick the dates; every card follows them.</p>
          </div>
          <Button type="button" variant="ghost" className="min-h-11 shrink-0 px-2 text-xs" onClick={reset} aria-label="Reset order">
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />Reset order
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Dates">
          {METRICS_PRESETS.map((p) => (
            <Button
              key={p.id} type="button" size="sm" variant={!showCustom && preset === p.id ? 'default' : 'outline'} aria-pressed={!showCustom && preset === p.id}
              className="min-h-11 text-xs" onClick={() => { setCustomOpen(false); update(metricsPresetRange(p.id, today)); }}
            >
              {p.label}
            </Button>
          ))}
          <Button type="button" size="sm" variant={showCustom ? 'default' : 'outline'} aria-pressed={showCustom} className="min-h-11 text-xs" onClick={() => setCustomOpen(true)}>Custom</Button>
        </div>
        {showCustom && (
          <div className="grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <label className="flex items-center gap-2">
              From
              <Input type="date" value={from} max={today} onChange={(e) => e.target.value && update({ from: e.target.value, to: e.target.value > to ? e.target.value : to })} className="h-11 flex-1 text-sm" />
            </label>
            <label className="flex items-center gap-2">
              To
              <Input type="date" value={to} max={today} onChange={(e) => e.target.value && update({ to: e.target.value > today ? today : e.target.value, from: e.target.value < from ? e.target.value : from })} className="h-11 flex-1 text-sm" />
            </label>
          </div>
        )}
      </Card>
      {order.map(render)}
    </div>
  );
}
