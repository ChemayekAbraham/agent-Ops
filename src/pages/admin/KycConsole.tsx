import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from 'sonner';
import { Shield, ShieldAlert, Lock, Search, RefreshCw } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

type KycRow = {
  user_id: string;
  kyc_level: number;
  level_source: string;
  frozen: boolean;
  frozen_reason: string | null;
  updated_at: string;
  daily_withdrawal_cap_ugx: number | null;
  daily_withdrawal_count_cap: number | null;
};

type ProfileLite = { id: string; full_name: string | null; phone: string | null; email: string | null };
type Risk = { user_id: string; score: number; tier: string; factors: Record<string, unknown> };
type Flag = {
  id: string;
  user_id: string;
  reason: string;
  severity: number;
  status: string;
  created_at: string;
};
type Event = { id: string; event_type: string; severity: number; occurred_at: string; metadata: Record<string, unknown> };

export default function KycConsole() {
  const [rows, setRows] = useState<KycRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, ProfileLite>>({});
  const [risks, setRisks] = useState<Record<string, Risk>>({});
  const [flagCounts, setFlagCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [tierFilter, setTierFilter] = useState<string>('all');
  const [frozenOnly, setFrozenOnly] = useState(false);

  const [selected, setSelected] = useState<KycRow | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<Event[]>([]);
  const [selectedFlags, setSelectedFlags] = useState<Flag[]>([]);
  const [actionReason, setActionReason] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  const fetchAll = async () => {
    setLoading(true);
    const { data: kycData } = await supabase
      .from('kyc_profiles')
      .select('user_id,kyc_level,level_source,frozen,frozen_reason,updated_at,daily_withdrawal_cap_ugx,daily_withdrawal_count_cap')
      .order('updated_at', { ascending: false })
      .limit(500);
    const list = (kycData ?? []) as KycRow[];
    setRows(list);

    const userIds = list.map((r) => r.user_id);
    if (userIds.length) {
      const [{ data: profs }, { data: risksData }, { data: flagRows }] = await Promise.all([
        supabase.from('profiles').select('id,full_name,phone,email').in('id', userIds),
        supabase.from('kyc_risk_scores').select('user_id,score,tier,factors').in('user_id', userIds),
        supabase.from('kyc_flags').select('user_id,status').in('user_id', userIds).in('status', ['open', 'reviewing']),
      ]);
      const pMap: Record<string, ProfileLite> = {};
      (profs ?? []).forEach((p) => { pMap[p.id] = p as ProfileLite; });
      setProfiles(pMap);

      const rMap: Record<string, Risk> = {};
      (risksData ?? []).forEach((r) => { rMap[(r as Risk).user_id] = r as Risk; });
      setRisks(rMap);

      const fMap: Record<string, number> = {};
      (flagRows ?? []).forEach((f: { user_id: string }) => { fMap[f.user_id] = (fMap[f.user_id] ?? 0) + 1; });
      setFlagCounts(fMap);
    }
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (frozenOnly && !r.frozen) return false;
      if (levelFilter !== 'all' && String(r.kyc_level) !== levelFilter) return false;
      const tier = risks[r.user_id]?.tier ?? 'low';
      if (tierFilter !== 'all' && tier !== tierFilter) return false;
      if (!q) return true;
      const p = profiles[r.user_id];
      return (
        r.user_id.toLowerCase().includes(q) ||
        (p?.full_name?.toLowerCase().includes(q) ?? false) ||
        (p?.phone?.toLowerCase().includes(q) ?? false) ||
        (p?.email?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rows, search, levelFilter, tierFilter, frozenOnly, risks, profiles]);

  const openDrawer = async (row: KycRow) => {
    setSelected(row);
    setActionReason('');
    const [{ data: ev }, { data: fl }] = await Promise.all([
      supabase.from('kyc_risk_events').select('id,event_type,severity,occurred_at,metadata')
        .eq('user_id', row.user_id).order('occurred_at', { ascending: false }).limit(50),
      supabase.from('kyc_flags').select('id,user_id,reason,severity,status,created_at')
        .eq('user_id', row.user_id).order('created_at', { ascending: false }).limit(20),
    ]);
    setSelectedEvents((ev ?? []) as Event[]);
    setSelectedFlags((fl ?? []) as Flag[]);
  };

  const runAction = async (fn: () => PromiseLike<{ error: unknown } | void>, successMsg: string) => {
    if (actionReason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters.');
      return;
    }
    setActionBusy(true);
    try {
      const res = (await fn()) as { error?: unknown } | void;
      if (res && 'error' in res && res.error) {
        toast.error((res.error as { message?: string }).message ?? 'Action failed');
      } else {
        toast.success(successMsg);
        await fetchAll();
        if (selected) await openDrawer(selected);
      }
    } finally {
      setActionBusy(false);
    }
  };

  const openFlagCount = Object.values(flagCounts).reduce((s, n) => s + n, 0);
  const criticalCount = Object.values(risks).filter((r) => r.tier === 'critical').length;

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-7xl mx-auto">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Shield className="h-6 w-6" /> KYC Console
          </h1>
          <p className="text-sm text-muted-foreground">
            Tiered KYC, fraud risk scoring, and account freeze controls.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchAll} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3"><div className="text-xs text-muted-foreground">Total users tracked</div><div className="text-xl font-semibold">{rows.length}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Open flags</div><div className="text-xl font-semibold text-warning">{openFlagCount}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Critical tier</div><div className="text-xl font-semibold text-destructive">{criticalCount}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Frozen</div><div className="text-xl font-semibold">{rows.filter((r) => r.frozen).length}</div></Card>
      </div>

      <Card className="p-3 flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, phone, email, user id" className="pl-8" />
        </div>
        <Select value={levelFilter} onValueChange={setLevelFilter}>
          <SelectTrigger className="w-32"><SelectValue placeholder="Level" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All levels</SelectItem>
            <SelectItem value="1">Level 1</SelectItem>
            <SelectItem value="2">Level 2</SelectItem>
            <SelectItem value="3">Level 3</SelectItem>
          </SelectContent>
        </Select>
        <Select value={tierFilter} onValueChange={setTierFilter}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Risk tier" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tiers</SelectItem>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="elevated">Elevated</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
          </SelectContent>
        </Select>
        <Button variant={frozenOnly ? 'default' : 'outline'} size="sm" onClick={() => setFrozenOnly((v) => !v)}>
          <Lock className="h-3 w-3 mr-1" /> Frozen only
        </Button>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left p-2">User</th>
                <th className="text-left p-2">Level</th>
                <th className="text-left p-2">Risk</th>
                <th className="text-left p-2">Flags</th>
                <th className="text-left p-2">State</th>
                <th className="text-left p-2">Updated</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const p = profiles[r.user_id];
                const risk = risks[r.user_id];
                return (
                  <tr key={r.user_id} className="border-t hover:bg-muted/20">
                    <td className="p-2">
                      <div className="font-medium">{p?.full_name ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{p?.phone ?? p?.email ?? r.user_id.slice(0, 8)}</div>
                    </td>
                    <td className="p-2">
                      <Badge variant={r.kyc_level >= 2 ? 'default' : 'secondary'}>L{r.kyc_level}</Badge>
                      <div className="text-[10px] text-muted-foreground">{r.level_source}</div>
                    </td>
                    <td className="p-2">
                      {risk ? (
                        <Badge variant={risk.tier === 'critical' ? 'destructive' : risk.tier === 'high' ? 'destructive' : risk.tier === 'elevated' ? 'default' : 'outline'}>
                          {risk.tier} · {risk.score}
                        </Badge>
                      ) : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                    <td className="p-2">
                      {flagCounts[r.user_id] ? <Badge variant="destructive">{flagCounts[r.user_id]}</Badge> : <span className="text-xs text-muted-foreground">0</span>}
                    </td>
                    <td className="p-2">
                      {r.frozen ? <Badge variant="destructive"><Lock className="h-3 w-3 mr-1" />Frozen</Badge> : <Badge variant="outline">Active</Badge>}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">{new Date(r.updated_at).toLocaleDateString()}</td>
                    <td className="p-2"><Button size="sm" variant="ghost" onClick={() => openDrawer(r)}>Review</Button></td>
                  </tr>
                );
              })}
              {!filtered.length && !loading && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground text-sm">No matching users.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{profiles[selected.user_id]?.full_name ?? 'User'} · KYC review</SheetTitle>
              </SheetHeader>
              <div className="space-y-4 mt-4 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2 rounded bg-muted/40"><div className="text-xs text-muted-foreground">Level</div><div className="font-medium">L{selected.kyc_level} ({selected.level_source})</div></div>
                  <div className="p-2 rounded bg-muted/40"><div className="text-xs text-muted-foreground">Risk</div><div className="font-medium">{risks[selected.user_id]?.tier ?? 'low'} · {risks[selected.user_id]?.score ?? 0}</div></div>
                  <div className="p-2 rounded bg-muted/40"><div className="text-xs text-muted-foreground">Daily cap</div><div className="font-medium">{formatUGX(selected.daily_withdrawal_cap_ugx ?? 0)}</div></div>
                  <div className="p-2 rounded bg-muted/40"><div className="text-xs text-muted-foreground">Daily count</div><div className="font-medium">{selected.daily_withdrawal_count_cap ?? '—'}</div></div>
                </div>

                {selected.frozen && (
                  <div className="p-3 rounded bg-destructive/10 text-destructive text-xs flex items-start gap-2">
                    <ShieldAlert className="h-4 w-4 mt-0.5" />
                    <div><div className="font-medium">Frozen</div><div>{selected.frozen_reason}</div></div>
                  </div>
                )}

                <div>
                  <div className="text-xs font-semibold mb-1 text-muted-foreground">Open flags</div>
                  {selectedFlags.length ? (
                    <ul className="space-y-1">
                      {selectedFlags.map((f) => (
                        <li key={f.id} className="p-2 rounded border text-xs flex justify-between gap-2">
                          <span>{f.reason}</span>
                          <Badge variant={f.status === 'open' ? 'destructive' : 'outline'}>{f.status}</Badge>
                        </li>
                      ))}
                    </ul>
                  ) : <div className="text-xs text-muted-foreground">None</div>}
                </div>

                <div>
                  <div className="text-xs font-semibold mb-1 text-muted-foreground">Recent risk events</div>
                  <ul className="space-y-1 max-h-40 overflow-y-auto">
                    {selectedEvents.slice(0, 20).map((e) => (
                      <li key={e.id} className="text-xs flex justify-between gap-2 border-b py-1">
                        <span>{e.event_type}</span>
                        <span className="text-muted-foreground">sev {e.severity} · {new Date(e.occurred_at).toLocaleString()}</span>
                      </li>
                    ))}
                    {!selectedEvents.length && <li className="text-xs text-muted-foreground">No events</li>}
                  </ul>
                </div>

                <div className="space-y-2 pt-2 border-t">
                  <div className="text-xs font-semibold text-muted-foreground">Reason (min 10 chars, required for every action)</div>
                  <Textarea value={actionReason} onChange={(e) => setActionReason(e.target.value)} rows={2} placeholder="Explain your decision..." />
                  <div className="grid grid-cols-2 gap-2">
                    <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => runAction(
                      () => supabase.rpc('admin_set_kyc_level', { p_user_id: selected.user_id, p_new_level: Math.min(3, selected.kyc_level + 1) as unknown as number, p_reason: actionReason }),
                      'Level raised'
                    )}>Upgrade level</Button>
                    <Button size="sm" variant="outline" disabled={actionBusy || selected.kyc_level <= 1} onClick={() => runAction(
                      () => supabase.rpc('admin_set_kyc_level', { p_user_id: selected.user_id, p_new_level: Math.max(1, selected.kyc_level - 1) as unknown as number, p_reason: actionReason }),
                      'Level lowered'
                    )}>Downgrade level</Button>
                    {selected.frozen ? (
                      <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => runAction(
                        () => supabase.rpc('admin_unfreeze_kyc_account', { p_user_id: selected.user_id, p_reason: actionReason }),
                        'Account unfrozen'
                      )}>Unfreeze</Button>
                    ) : (
                      <Button size="sm" variant="destructive" disabled={actionBusy} onClick={() => runAction(
                        () => supabase.rpc('admin_freeze_kyc_account', { p_user_id: selected.user_id, p_reason: actionReason }),
                        'Account frozen'
                      )}>Freeze account</Button>
                    )}
                    <Button size="sm" variant="outline" disabled={actionBusy || !selectedFlags.length} onClick={() => {
                      const open = selectedFlags.find((f) => f.status === 'open' || f.status === 'reviewing');
                      if (!open) { toast.error('No open flag'); return; }
                      runAction(
                        () => supabase.rpc('admin_resolve_kyc_flag', { p_flag_id: open.id, p_status: 'resolved', p_resolution: actionReason }),
                        'Flag resolved'
                      );
                    }}>Resolve flag</Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}