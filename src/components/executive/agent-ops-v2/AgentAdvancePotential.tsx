import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  Search, TrendingUp, Users, Network, Home, FileText, Wallet, Phone,
  MessageCircle, Sparkles, Info, ChevronRight, Target, Loader2, User,
} from 'lucide-react';

interface PotentialRow {
  agent_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  avatar_url: string | null;
  verified: boolean | null;
  territory: string | null;
  direct_subagents: number;
  active_subagents: number;
  grand_subagents: number;
  rent_collected: number;
  collections_count: number;
  house_listings: number;
  rent_requests: number;
  advances_count: number;
  principal_total: number;
  outstanding_total: number;
  repayment_rate: number | null;
  current_limit: number;
  has_active_advance: boolean;
  network_score: number;
  collections_score: number;
  repayment_score: number;
  listings_score: number;
  requests_score: number;
  potential_score: number;
  suggested_amount: number;
  total_matched: number;
}

const num = (v: any) => Number(v ?? 0);

function scoreColor(score: number) {
  if (score >= 75) return 'text-emerald-600';
  if (score >= 50) return 'text-amber-600';
  return 'text-rose-600';
}
function scoreBg(score: number) {
  if (score >= 75) return 'bg-emerald-500';
  if (score >= 50) return 'bg-amber-500';
  return 'bg-rose-500';
}
function tierLabel(score: number) {
  if (score >= 75) return 'High potential';
  if (score >= 50) return 'Growing';
  return 'Early stage';
}

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

export function AgentAdvancePotential() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<PotentialRow | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 150);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ['agent-advance-potential', debounced],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_agent_advance_potential', {
        _search: debounced || null,
        _limit: 100,
        _offset: 0,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        ...r,
        direct_subagents: num(r.direct_subagents),
        active_subagents: num(r.active_subagents),
        grand_subagents: num(r.grand_subagents),
        rent_collected: num(r.rent_collected),
        collections_count: num(r.collections_count),
        house_listings: num(r.house_listings),
        rent_requests: num(r.rent_requests),
        advances_count: num(r.advances_count),
        principal_total: num(r.principal_total),
        outstanding_total: num(r.outstanding_total),
        repayment_rate: r.repayment_rate == null ? null : Number(r.repayment_rate),
        current_limit: num(r.current_limit),
        network_score: num(r.network_score),
        collections_score: num(r.collections_score),
        repayment_score: num(r.repayment_score),
        listings_score: num(r.listings_score),
        requests_score: num(r.requests_score),
        potential_score: num(r.potential_score),
        suggested_amount: num(r.suggested_amount),
      })) as PotentialRow[];
    },
  });

  const rows = data ?? [];
  const totalMatched = rows[0]?.total_matched ?? 0;

  return (
    <div className="space-y-4">
      {/* Explanation of the model */}
      <div className="rounded-2xl border border-border bg-gradient-to-br from-primary/5 to-transparent p-4">
        <div className="flex items-start gap-2.5">
          <div className="p-2 rounded-xl bg-primary/10 shrink-0">
            <Target className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold">How advance potential is scored</h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Potential estimates how much an agent can safely grow within the advance
              programme. The sub-agent network is the biggest driver.
            </p>
            <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
              <span className="font-semibold text-foreground">Suggested amounts start low</span> and grow
              over time. New agents get a small starter; the amount only increases as they repay
              advances well (repaying early raises their next offer).
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-3">
              {[
                { label: 'Sub-agent network', weight: '70%', icon: Network, note: 'Direct + grand sub-agents' },
                { label: 'Rent collections', weight: '12%', icon: Wallet, note: 'Total collected' },
                { label: 'Repayment', weight: '8%', icon: TrendingUp, note: 'Advance payback rate' },
                { label: 'House listings', weight: '5%', icon: Home, note: 'Houses listed' },
                { label: 'Rent requests', weight: '5%', icon: FileText, note: 'For tenants' },
              ].map((c) => (
                <div key={c.label} className="rounded-xl border border-border bg-card p-2.5">
                  <div className="flex items-center gap-1.5">
                    <c.icon className="h-3.5 w-3.5 text-primary" />
                    <span className="text-[13px] font-bold">{c.weight}</span>
                  </div>
                  <p className="text-[11px] font-semibold mt-1 leading-tight">{c.label}</p>
                  <p className="text-[10px] text-muted-foreground leading-tight">{c.note}</p>
                </div>
              ))}
            </div>
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
        <span>{totalMatched} qualifying agents ranked by potential</span>
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </div>

      {/* Ranked list */}
      <div className="space-y-2">
        {rows.map((r, i) => (
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
                  {r.has_active_advance && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 font-semibold shrink-0">
                      ON ADVANCE
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{r.direct_subagents} subs</span>
                  <span className="inline-flex items-center gap-1"><Network className="h-3 w-3" />{r.grand_subagents} grand</span>
                  <span className="inline-flex items-center gap-1"><Wallet className="h-3 w-3" />{formatUGX(r.rent_collected)}</span>
                </div>
              </div>

              <div className="text-right shrink-0">
                <p className={cn('text-lg font-extrabold leading-none', scoreColor(r.potential_score))}>
                  {r.potential_score.toFixed(0)}
                </p>
                <p className="text-[9px] uppercase tracking-wide text-muted-foreground">/100</p>
                <p className="text-[11px] font-semibold text-emerald-600 mt-1">{formatUGX(r.suggested_amount)}</p>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </div>
            <div className="mt-2">
              <Progress value={r.potential_score} className="h-1.5" />
            </div>
          </button>
        ))}
        {!isLoading && rows.length === 0 && (
          <div className="text-center py-10 text-sm text-muted-foreground">No agents found.</div>
        )}
      </div>

      <AgentDetailDialog row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function StatBlock({ icon: Icon, label, value, sub }: { icon: any; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-base font-bold mt-1">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function ScoreBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.round((value / max) * 100);
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] mb-1">
        <span className="font-medium">{label} <span className="text-muted-foreground">(max {max})</span></span>
        <span className="font-bold">{value.toFixed(1)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full', scoreBg(pct))} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

function AgentDetailDialog({ row, onClose }: { row: PotentialRow | null; onClose: () => void }) {
  if (!row) return null;
  const repayPct = row.repayment_rate == null ? null : Math.round(row.repayment_rate * 100);
  const digits = (row.phone ?? '').replace(/\D/g, '');
  const waNumber = digits.startsWith('0') ? '256' + digits.slice(1) : digits;
  const waMsg = encodeURIComponent(
    `Hello ${row.full_name ?? ''}, based on your growing network you now qualify for a Welile agent advance of up to ${formatUGX(row.suggested_amount)}. Reply to unlock it and grow your float today.`,
  );

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {row.full_name || 'Agent'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Headline */}
          <div className="rounded-2xl border border-border bg-gradient-to-br from-primary/10 to-transparent p-4 flex items-center justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Potential score</p>
              <p className={cn('text-3xl font-extrabold leading-none', scoreColor(row.potential_score))}>
                {row.potential_score.toFixed(0)}<span className="text-base text-muted-foreground">/100</span>
              </p>
              <p className="text-[11px] font-semibold mt-1">{tierLabel(row.potential_score)}</p>
            </div>
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Suggested advance</p>
              <p className="text-2xl font-extrabold text-emerald-600 leading-tight">{formatUGX(row.suggested_amount)}</p>
              {row.current_limit > 0 && (
                <p className="text-[11px] text-muted-foreground">Current limit {formatUGX(row.current_limit)}</p>
              )}
            </div>
          </div>

          {/* Score breakdown */}
          <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
            <p className="text-xs font-bold flex items-center gap-1.5"><Info className="h-3.5 w-3.5" /> Score breakdown</p>
            <ScoreBar label="Sub-agent network" value={row.network_score} max={70} />
            <ScoreBar label="Rent collections" value={row.collections_score} max={12} />
            <ScoreBar label="Repayment performance" value={row.repayment_score} max={8} />
            <ScoreBar label="House listings" value={row.listings_score} max={5} />
            <ScoreBar label="Rent requests" value={row.requests_score} max={5} />
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-2">
            <StatBlock icon={Users} label="Direct sub-agents" value={String(row.direct_subagents)} sub={`${row.active_subagents} active`} />
            <StatBlock icon={Network} label="Grand sub-agents" value={String(row.grand_subagents)} sub="Under their subs" />
            <StatBlock icon={Wallet} label="Rent collected" value={formatUGX(row.rent_collected)} sub={`${row.collections_count} collections`} />
            <StatBlock icon={Home} label="Houses listed" value={String(row.house_listings)} />
            <StatBlock icon={FileText} label="Rent requests" value={String(row.rent_requests)} sub="For tenants" />
            <StatBlock
              icon={TrendingUp}
              label="Repayment"
              value={repayPct == null ? 'No history' : `${repayPct}%`}
              sub={row.advances_count > 0 ? `${row.advances_count} advances` : 'Never taken advance'}
            />
          </div>

          {row.outstanding_total > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              Outstanding advance balance: <strong>{formatUGX(row.outstanding_total)}</strong> of {formatUGX(row.principal_total)} principal.
            </div>
          )}

          {/* Actions to entice */}
          <div className="rounded-2xl border border-border bg-card p-4 space-y-2.5">
            <p className="text-xs font-bold flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5 text-primary" /> Actions to grow this agent</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {digits && (
                <a
                  href={`https://wa.me/${waNumber}?text=${waMsg}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold py-2.5 hover:bg-emerald-700 transition-colors"
                >
                  <MessageCircle className="h-4 w-4" /> Offer advance on WhatsApp
                </a>
              )}
              {digits && (
                <a
                  href={`tel:${row.phone}`}
                  className="flex items-center justify-center gap-2 rounded-xl border border-border text-sm font-semibold py-2.5 hover:bg-muted transition-colors"
                >
                  <Phone className="h-4 w-4" /> Call agent
                </a>
              )}
            </div>
            <ul className="text-[11px] text-muted-foreground space-y-1 mt-1 list-disc pl-4">
              {row.direct_subagents < 10 && <li>Recruit more sub-agents — the fastest way to raise this agent's limit.</li>}
              {row.grand_subagents < 5 && <li>Coach their sub-agents to enrol their own sub-agents (grand network).</li>}
              {row.rent_collected < 2000000 && <li>Push daily rent collections to strengthen repayment capacity.</li>}
              {!row.has_active_advance && <li>Offer a starter advance now to activate them in the programme.</li>}
              {repayPct != null && repayPct >= 80 && <li>Strong repayer — safe to upsell a larger advance.</li>}
              {row.advances_count === 0 && <li>Start with the small suggested amount — it grows automatically as they repay.</li>}
              {row.outstanding_total > 0 && <li>Encourage clearing the outstanding balance early — it unlocks a higher next advance.</li>}
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
