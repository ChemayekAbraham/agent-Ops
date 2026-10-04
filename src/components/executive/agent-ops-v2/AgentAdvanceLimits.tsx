import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  Search, Users, Wallet, Home, FileText, Loader2, User, ChevronRight,
  Coins, ShieldCheck, Info, AlertTriangle,
} from 'lucide-react';

interface LimitRow {
  agent_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  avatar_url: string | null;
  verified: boolean | null;
  territory: string | null;
  direct_subagents: number;
  registered_subagents: number;
  active_subagents: number;
  rent_collected: number;
  collections_count: number;
  houses_listed: number;
  rent_requests: number;
  base_limit: number;
  subagents_bonus: number;
  collections_bonus: number;
  houses_bonus: number;
  requests_bonus: number;
  total_limit: number;
  stored_total_limit: number;
  total_matched: number;
}

const num = (v: any) => Number(v ?? 0);
const MAX_LIMIT = 9_000_000;

function AgentAvatar({ src, name }: { src: string | null; name: string | null }) {
  const [failed, setFailed] = useState(false);
  const showImg = !!src && !failed;
  return showImg ? (
    <img
      src={src as string}
      alt={name ?? ''}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-10 w-10 rounded-full object-cover bg-muted"
    />
  ) : (
    <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
      <User className="h-5 w-5" />
    </div>
  );
}

export function AgentAdvanceLimits() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<LimitRow | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 150);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ['agent-advance-limits', debounced],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_agent_advance_limits', {
        _search: debounced || null,
        _limit: 100,
        _offset: 0,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        ...r,
        direct_subagents: num(r.direct_subagents),
        registered_subagents: num(r.registered_subagents),
        active_subagents: num(r.active_subagents),
        rent_collected: num(r.rent_collected),
        collections_count: num(r.collections_count),
        houses_listed: num(r.houses_listed),
        rent_requests: num(r.rent_requests),
        base_limit: num(r.base_limit),
        subagents_bonus: num(r.subagents_bonus),
        collections_bonus: num(r.collections_bonus),
        houses_bonus: num(r.houses_bonus),
        requests_bonus: num(r.requests_bonus),
        total_limit: num(r.total_limit),
        stored_total_limit: num(r.stored_total_limit),
      })) as LimitRow[];
    },
  });

  const rows = data ?? [];
  const totalMatched = rows[0]?.total_matched ?? 0;

  return (
    <div className="space-y-4">
      {/* Formula explainer */}
      <div className="rounded-2xl border border-border bg-gradient-to-br from-primary/5 to-transparent p-4">
        <div className="flex items-start gap-2.5">
          <div className="p-2 rounded-xl bg-primary/10 shrink-0">
            <Coins className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold">How the advance limit is calculated</h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Every agent starts at <strong>{formatUGX(20000)}</strong>. Each ingredient below adds to the
              limit, and the total is capped at <strong>{formatUGX(MAX_LIMIT)}</strong>. Tap an agent to see
              the exact breakdown of how their number is reached.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
              {[
                { label: 'Active sub-agents', icon: Users, add: '+30,000 each', note: 'plus 9,000 registered · cap 3M' },
                { label: 'Rent collected', icon: Wallet, add: '+6% collected', note: 'cap 2,400,000' },
                { label: 'Rent requests', icon: FileText, add: '+9,000 each', note: 'cap 1,500,000' },
                { label: 'Promissory notes', icon: Home, add: '+9,000 each', note: 'cap 600,000' },
              ].map((c) => (
                <div key={c.label} className="rounded-xl border border-border bg-card p-2.5">
                  <div className="flex items-center gap-1.5">
                    <c.icon className="h-3.5 w-3.5 text-primary" />
                    <span className="text-[11px] font-bold leading-tight">{c.label}</span>
                  </div>
                  <p className="text-[12px] font-bold text-emerald-600 mt-1 leading-tight">{c.add}</p>
                  <p className="text-[10px] text-muted-foreground leading-tight">{c.note}</p>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-3 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              Sub-agents are by far the biggest driver, then rent collected, then rent requests, then promissory notes.
            </p>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents by name, phone or territory…"
          className="pl-9"
        />
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
        <span>{totalMatched.toLocaleString()} agents ranked by limit</span>
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </div>

      {/* Ranked list */}
      <div className="space-y-2">
        {rows.map((r, i) => {
          const atCap = r.total_limit >= MAX_LIMIT;
          return (
            <button
              key={r.agent_id}
              onClick={() => setSelected(r)}
              className="w-full text-left rounded-2xl border border-border bg-card p-3 hover:border-primary/40 hover:shadow-md active:scale-[0.99] transition-all"
            >
              <div className="flex items-center gap-3">
                <div className="relative shrink-0">
                  <AgentAvatar src={r.avatar_url} name={r.full_name} />
                  <span className="absolute -top-1 -left-1 h-5 w-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
                    {i + 1}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-bold truncate">{r.full_name || 'Unknown agent'}</p>
                    {atCap && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold shrink-0">
                        AT CAP
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{r.active_subagents} active subs</span>
                    <span className="inline-flex items-center gap-1"><Wallet className="h-3 w-3" />{formatUGX(r.rent_collected)}</span>
                    <span className="inline-flex items-center gap-1"><Home className="h-3 w-3" />{r.houses_listed}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-base font-extrabold leading-none text-emerald-600">{formatUGX(r.total_limit)}</p>
                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground mt-0.5">computed limit</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </div>
              <div className="mt-2">
                <Progress value={Math.min(100, (r.total_limit / MAX_LIMIT) * 100)} className="h-1.5" />
              </div>
            </button>
          );
        })}
        {!isLoading && rows.length === 0 && (
          <div className="text-center py-10 text-sm text-muted-foreground">No agents found.</div>
        )}
      </div>

      <AgentLimitDialog row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function ContribBar({ label, value, detail, total }: { label: string; value: number; detail: string; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] mb-1">
        <span className="font-medium">{label} <span className="text-muted-foreground">· {detail}</span></span>
        <span className="font-bold text-emerald-600">+{formatUGX(value)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

function AgentLimitDialog({ row, onClose }: { row: LimitRow | null; onClose: () => void }) {
  if (!row) return null;
  const summed = row.base_limit + row.subagents_bonus + row.collections_bonus + row.houses_bonus + row.requests_bonus;
  const capped = summed > MAX_LIMIT;
  const drift = Math.abs(row.total_limit - row.stored_total_limit);

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-primary" />
            {row.full_name || 'Agent'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Headline */}
          <div className="rounded-2xl border border-border bg-gradient-to-br from-emerald-500/10 to-transparent p-4">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Computed advance limit</p>
            <p className="text-3xl font-extrabold text-emerald-600 leading-tight">{formatUGX(row.total_limit)}</p>
            {capped && (
              <p className="text-[11px] text-amber-700 mt-1">
                Raw total {formatUGX(summed)} exceeds the {formatUGX(MAX_LIMIT)} cap — trimmed to the cap.
              </p>
            )}
          </div>

          {/* Breakdown */}
          <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
            <p className="text-xs font-bold flex items-center gap-1.5"><Info className="h-3.5 w-3.5" /> How this limit is built</p>
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-medium">Base limit <span className="text-muted-foreground">· every agent</span></span>
              <span className="font-bold">{formatUGX(row.base_limit)}</span>
            </div>
            <ContribBar
              label="Sub-agent bonus"
              detail={`${row.registered_subagents} registered × 30k + ${row.active_subagents} active × 50k`}
              value={row.subagents_bonus}
              total={summed}
            />
            <ContribBar
              label="Rent collection bonus"
              detail={`50% of ${formatUGX(row.rent_collected)}`}
              value={row.collections_bonus}
              total={summed}
            />
            <ContribBar
              label="Houses-listed bonus"
              detail={`${row.houses_listed} × 100k`}
              value={row.houses_bonus}
              total={summed}
            />
            <ContribBar
              label="Tenant-placement bonus"
              detail={`${row.rent_requests} × 150k`}
              value={row.requests_bonus}
              total={summed}
            />
            <div className="flex items-center justify-between text-xs pt-2 border-t border-border">
              <span className="font-bold">Raw total (before cap)</span>
              <span className="font-extrabold">{formatUGX(summed)}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold">Final limit (after {formatUGX(MAX_LIMIT)} cap)</span>
              <span className="font-extrabold text-emerald-600">{formatUGX(row.total_limit)}</span>
            </div>
          </div>

          {/* Underlying activity */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-center gap-1.5 text-muted-foreground"><Users className="h-3.5 w-3.5" /><span className="text-[11px] font-semibold uppercase">Sub-agents</span></div>
              <p className="text-base font-bold mt-1">{row.active_subagents} active</p>
              <p className="text-[11px] text-muted-foreground">{row.direct_subagents} total direct</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-center gap-1.5 text-muted-foreground"><Wallet className="h-3.5 w-3.5" /><span className="text-[11px] font-semibold uppercase">Rent collected</span></div>
              <p className="text-base font-bold mt-1">{formatUGX(row.rent_collected)}</p>
              <p className="text-[11px] text-muted-foreground">{row.collections_count} collections</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-center gap-1.5 text-muted-foreground"><Home className="h-3.5 w-3.5" /><span className="text-[11px] font-semibold uppercase">Houses listed</span></div>
              <p className="text-base font-bold mt-1">{row.houses_listed}</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-center gap-1.5 text-muted-foreground"><FileText className="h-3.5 w-3.5" /><span className="text-[11px] font-semibold uppercase">Tenants placed</span></div>
              <p className="text-base font-bold mt-1">{row.rent_requests}</p>
            </div>
          </div>

          {/* Stored comparison */}
          <div className={cn(
            'rounded-xl border p-3 text-xs flex items-start gap-2',
            drift > 1000 ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-border bg-muted/30 text-muted-foreground',
          )}>
            <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              Stored limit on file: <strong>{formatUGX(row.stored_total_limit)}</strong>.
              {drift > 1000
                ? ` This differs from the freshly computed ${formatUGX(row.total_limit)} — the stored value refreshes when the limit engine next recalculates for this agent.`
                : ' Matches the freshly computed value.'}
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
