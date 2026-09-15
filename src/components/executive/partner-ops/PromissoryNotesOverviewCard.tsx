import React, { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FileText, ArrowRight, Clock, CheckCircle, XCircle, TrendingUp, Search } from 'lucide-react';
import { usePromissoryOpsReport, PROMISSORY_RANGES, type PromissoryRange } from '@/hooks/usePromissoryOpsReport';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

type PromissoryStatus = 'pending' | 'activated' | 'rejected';

export interface PromissoryOverviewFilter {
  status?: PromissoryStatus;
  search?: string;
  range?: PromissoryRange;
}

const PILL_CONFIG: { key: PromissoryStatus; label: string; icon: React.ElementType }[] = [
  { key: 'pending', label: 'Awaiting Review', icon: Clock },
  { key: 'activated', label: 'Approved', icon: CheckCircle },
  { key: 'rejected', label: 'Rejected', icon: XCircle },
];

function matchesSearch(note: any, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  const haystack = [
    note.partner_name,
    note.agent_name,
    note.whatsapp_number,
    note.phone_number,
    note.email,
    note.came_in_name,
    note.lead_partner_name,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q);
}

/**
 * Prominent overview entry point for the Promissory Notes workspace.
 * Surfaces live queue stats so Partner Ops can see workload at a glance.
 */
export function PromissoryNotesOverviewCard({ onOpen }: { onOpen: (filter?: PromissoryOverviewFilter) => void }) {
  const { report, isLoading, range, setRange } = usePromissoryOpsReport();
  const { kpis, notes } = report;
  const [selected, setSelected] = useState<PromissoryStatus>('pending');
  const [search, setSearch] = useState('');

  const filteredNotes = useMemo(() => notes.filter((n) => matchesSearch(n, search)), [notes, search]);

  const counts = {
    pending: filteredNotes.filter((n) => n.status === 'pending').length,
    activated: filteredNotes.filter((n) => n.status === 'activated').length,
    rejected: filteredNotes.filter((n) => n.status === 'cancelled' || n.status === 'defaulted').length,
  };

  const activeFilter: PromissoryOverviewFilter = { status: selected, search, range };

  const openLabel = {
    pending: 'Open awaiting review',
    activated: 'Open approved',
    rejected: 'Open rejected',
  }[selected];

  return (
    <Card
      className="border-primary/30 bg-primary/5 cursor-pointer hover:bg-primary/10 transition-colors"
      onClick={() => onOpen(activeFilter)}
      role="button"
      aria-label="Open Promissory Notes"
    >
      <CardContent className="p-4 sm:p-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-primary/10 shrink-0">
            <FileText className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-base font-bold">Promissory Notes</p>
              {!isLoading && (
                <Badge variant="secondary" className="text-xs">
                  {kpis.notes_count.toLocaleString()} total
                </Badge>
              )}
              {counts.pending > 0 && (
                <Badge variant="destructive" className="text-xs">
                  {counts.pending.toLocaleString()} awaiting review
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Review partner commitments, approve notes &amp; track collections
            </p>
          </div>
          <Button size="sm" className="gap-1.5 shrink-0" onClick={(e) => { e.stopPropagation(); onOpen(activeFilter); }} aria-label={openLabel}>
            {openLabel} <ArrowRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search partner, agent, phone or email..."
              className="h-8 pl-8 text-xs"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
            {PROMISSORY_RANGES.map((r) => (
              <button
                key={r.key}
                onClick={(e) => { e.stopPropagation(); setRange(r.key); }}
                className={cn(
                  'shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium transition-all',
                  range === r.key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background/80 text-muted-foreground hover:bg-background border'
                )}
                aria-pressed={range === r.key}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {PILL_CONFIG.map(({ key, label, icon: Icon }) => {
            const active = selected === key;
            return (
              <button
                key={key}
                onClick={(e) => { e.stopPropagation(); setSelected(key); }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all',
                  active
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-background/80 text-muted-foreground hover:bg-background border'
                )}
                aria-pressed={active}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{label}</span>
                {!isLoading && (
                  <span className={cn('ml-0.5 tabular-nums', active ? 'text-primary-foreground/80' : 'text-muted-foreground/80')}>
                    {counts[key].toLocaleString()}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border bg-background/60 p-2.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium uppercase tracking-wide">Awaiting review</span>
            </div>
            <p className="text-sm font-bold mt-1">{isLoading ? '…' : counts.pending.toLocaleString()}</p>
          </div>
          <div className="rounded-lg border bg-background/60 p-2.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <CheckCircle className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium uppercase tracking-wide">Approved</span>
            </div>
            <p className="text-sm font-bold mt-1">{isLoading ? '…' : counts.activated.toLocaleString()}</p>
          </div>
          <div className="rounded-lg border bg-background/60 p-2.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium uppercase tracking-wide">Promised</span>
            </div>
            <p className="text-sm font-bold mt-1 truncate">{isLoading ? '…' : formatUGX(kpis.promised_total)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
