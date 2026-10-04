import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';
import {
  Search, ShieldCheck, AlertCircle, Layers, RefreshCw, ChevronLeft,
} from 'lucide-react';

/**
 * AgentFeatureFlagsPanel
 * ---------------------------------------------------------------------
 * Agent Ops control surface for enabling/disabling individual functions
 * (capabilities) per agent at scale.
 *
 *   Backend used:
 *     - vw_agent_ops_directory          (filterable list of agents)
 *     - agent_capabilities              (per-agent rows)
 *     - agent_tier_capabilities         (tier preset mapping)
 *     - ops_set_agent_capability        (single toggle, mandatory reason)
 *     - ops_bulk_set_agent_capability   (≤5000 agents per call)
 *     - ops_set_agent_tier              (apply tier preset)
 *
 * Designed for 1M+ agents:
 *     - Server-side pagination on the directory view (200/page).
 *     - Bulk RPC = 1 round trip regardless of selection count.
 *     - Realtime subscription on `agent_capabilities` so any teammate's
 *       change shows up immediately.
 */

const ALL_CAPABILITIES: { key: string; label: string; risk: 'low'|'med'|'high' }[] = [
  { key: 'view_agent_dashboard', label: 'View dashboard',     risk: 'low' },
  { key: 'collect_rent',         label: 'Collect rent',       risk: 'high' },
  { key: 'request_float',        label: 'Request float',      risk: 'high' },
  { key: 'process_cash_out',     label: 'Process cash-out',   risk: 'high' },
  { key: 'act_as_proxy',         label: 'Act as proxy',       risk: 'high' },
  { key: 'onboard_tenants',      label: 'Onboard tenants',    risk: 'med' },
  { key: 'onboard_landlords',    label: 'Onboard landlords',  risk: 'med' },
  { key: 'capture_supporters',   label: 'Capture supporters', risk: 'med' },
  { key: 'manage_subagents',     label: 'Manage sub-agents',  risk: 'med' },
  { key: 'approve_subagents',    label: 'Approve sub-agents', risk: 'med' },
  { key: 'view_subagent_data',   label: 'View sub-agent data',risk: 'low' },
];

type Tier = 'probation' | 'collector' | 'full_agent' | 'senior' | 'suspended';
const TIERS: Tier[] = ['probation','collector','full_agent','senior','suspended'];

const PAGE_SIZE = 200;

interface DirRow {
  agent_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  region: string | null;
  district: string | null;
  territory: string | null;
  agent_tier: Tier | null;
  is_frozen: boolean;
  last_active_at: string | null;
  active_capability_count: number;
  total_capability_count: number;
}

export function AgentFeatureFlagsPanel({ onBack }: { onBack?: () => void }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<Tier | 'all'>('all');
  const [frozenOnly, setFrozenOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawerAgent, setDrawerAgent] = useState<DirRow | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  // ----- Directory query -----
  const { data: rows = [], isLoading, refetch } = useQuery<DirRow[]>({
    queryKey: ['ops-agent-directory', { search, tierFilter, frozenOnly, page }],
    queryFn: async () => {
      let q = supabase
        .from('vw_agent_ops_directory')
        .select('*')
        .order('last_active_at', { ascending: false, nullsFirst: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (tierFilter !== 'all') q = q.eq('agent_tier', tierFilter);
      if (frozenOnly) q = q.eq('is_frozen', true);
      if (search.trim()) {
        const s = `%${search.trim()}%`;
        q = q.or(`full_name.ilike.${s},phone.ilike.${s},email.ilike.${s}`);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as DirRow[];
    },
    staleTime: 30_000,
  });

  // ----- Realtime: any capability flip refreshes the list & open drawer -----
  useEffect(() => {
    const ch = supabase
      .channel('agent-capabilities-ops')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_capabilities' }, () => {
        queryClient.invalidateQueries({ queryKey: ['ops-agent-directory'] });
        queryClient.invalidateQueries({ queryKey: ['agent-capabilities'] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [queryClient]);

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  const toggleRow = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = (checked: boolean) => {
    if (checked) setSelected(new Set(rows.map(r => r.agent_id)));
    else setSelected(new Set());
  };

  return (
    <div className="space-y-4 pb-20">
      <div className="flex items-center gap-2">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ChevronLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        )}
        <ShieldCheck className="h-5 w-5 text-primary" />
        <div>
          <h2 className="text-lg font-bold">Agent Feature Flags</h2>
          <p className="text-xs text-muted-foreground">
            Enable or disable specific functions per agent. Tiers set defaults; manual overrides survive tier changes.
          </p>
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>

      {/* Filters */}
      <Card className="p-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <div className="md:col-span-2 relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search by name, phone or email"
              className="pl-8"
            />
          </div>
          <Select value={tierFilter} onValueChange={(v) => { setTierFilter(v as Tier | 'all'); setPage(0); }}>
            <SelectTrigger><SelectValue placeholder="All tiers" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tiers</SelectItem>
              {TIERS.map(t => <SelectItem key={t} value={t}>{t.replace('_',' ')}</SelectItem>)}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={frozenOnly} onCheckedChange={(v) => { setFrozenOnly(v); setPage(0); }} />
            Frozen only
          </label>
        </div>
      </Card>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <Card className="p-3 border-primary/40 bg-primary/5 flex items-center gap-3 sticky top-0 z-10">
          <Layers className="h-4 w-4 text-primary" />
          <p className="text-sm font-semibold">{selected.size} selected</p>
          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={() => setSelected(new Set())}>Clear</Button>
          <Button size="sm" onClick={() => setBulkOpen(true)}>Bulk action…</Button>
        </Card>
      )}

      {/* Directory table */}
      <Card>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={rows.length > 0 && selected.size === rows.length}
                    onCheckedChange={(v) => toggleAll(!!v)}
                  />
                </TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No agents match these filters.</TableCell></TableRow>
              )}
              {rows.map(r => (
                <TableRow key={r.agent_id}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(r.agent_id)}
                      onCheckedChange={() => toggleRow(r.agent_id)}
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => setDrawerAgent(r)}
                    >
                      <div className="font-semibold">{r.full_name ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{r.phone ?? r.email ?? r.agent_id.slice(0,8)}</div>
                    </button>
                  </TableCell>
                  <TableCell className="text-xs">
                    {[r.region, r.district, r.territory].filter(Boolean).join(' · ') || '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {(r.agent_tier ?? 'unset').replace('_',' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {r.active_capability_count}/{ALL_CAPABILITIES.length}
                  </TableCell>
                  <TableCell>
                    {r.is_frozen
                      ? <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" />Frozen</Badge>
                      : <Badge variant="secondary">Active</Badge>}
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => setDrawerAgent(r)}>Manage</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between p-2 border-t">
          <p className="text-xs text-muted-foreground">
            Page {page + 1} · showing {rows.length} of up to {PAGE_SIZE}
          </p>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>Prev</Button>
            <Button size="sm" variant="outline" disabled={rows.length < PAGE_SIZE} onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
        </div>
      </Card>

      {/* Agent drawer */}
      <AgentDrawer
        agent={drawerAgent}
        onClose={() => setDrawerAgent(null)}
      />

      {/* Bulk action sheet */}
      <BulkSheet
        open={bulkOpen}
        agentIds={selectedIds}
        onClose={() => setBulkOpen(false)}
        onDone={() => { setBulkOpen(false); setSelected(new Set()); refetch(); }}
      />
    </div>
  );
}

/* =====================================================================
 * Per-agent drawer
 * ===================================================================*/

interface CapRow { capability: string; status: string; }

function AgentDrawer({ agent, onClose }: { agent: DirRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [tier, setTier] = useState<Tier | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReason('');
    setTier(agent?.agent_tier ?? undefined);
  }, [agent?.agent_id, agent?.agent_tier]);

  const { data: caps = [] } = useQuery<CapRow[]>({
    queryKey: ['agent-capabilities', agent?.agent_id],
    enabled: !!agent,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_capabilities')
        .select('capability,status')
        .eq('agent_id', agent!.agent_id);
      if (error) throw error;
      return data ?? [];
    },
  });

  const activeSet = useMemo(() => new Set(caps.filter(c => c.status === 'active').map(c => c.capability)), [caps]);

  const ensureReason = () => {
    if (reason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return false;
    }
    return true;
  };

  const flip = async (capability: string, action: 'enable' | 'disable') => {
    if (!agent || !ensureReason()) return;
    setBusy(true);
    const { error } = await supabase.rpc('ops_set_agent_capability', {
      _agent_id: agent.agent_id,
      _capability: capability,
      _action: action,
      _reason: reason.trim(),
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`${action === 'enable' ? 'Enabled' : 'Disabled'}: ${capability}`);
    queryClient.invalidateQueries({ queryKey: ['agent-capabilities', agent.agent_id] });
    queryClient.invalidateQueries({ queryKey: ['ops-agent-directory'] });
  };

  const applyTier = async () => {
    if (!agent || !tier || !ensureReason()) return;
    setBusy(true);
    const { error } = await supabase.rpc('ops_set_agent_tier', {
      _agent_id: agent.agent_id,
      _tier: tier,
      _reason: reason.trim(),
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Tier set to ${tier}`);
    queryClient.invalidateQueries({ queryKey: ['agent-capabilities', agent.agent_id] });
    queryClient.invalidateQueries({ queryKey: ['ops-agent-directory'] });
  };

  return (
    <Sheet open={!!agent} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        {agent && (
          <>
            <SheetHeader>
              <SheetTitle>{agent.full_name ?? 'Agent'}</SheetTitle>
              <SheetDescription>{agent.phone ?? agent.email ?? agent.agent_id.slice(0, 8)}</SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-4">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Reason (required, 10+ chars) — applies to every change made in this drawer
                </label>
                <Textarea
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="e.g. Suspended after KYC mismatch flagged on 2026-04-29"
                  rows={2}
                />
              </div>

              <Card className="p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Tier preset
                </p>
                <div className="flex gap-2">
                  <Select value={tier} onValueChange={(v) => setTier(v as Tier)}>
                    <SelectTrigger className="flex-1"><SelectValue placeholder="Pick a tier" /></SelectTrigger>
                    <SelectContent>
                      {TIERS.map(t => <SelectItem key={t} value={t}>{t.replace('_',' ')}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button onClick={applyTier} disabled={busy || !tier}>Apply tier</Button>
                </div>
                <p className="text-[10px] text-muted-foreground mt-2">
                  Applying a tier resets tier-sourced capabilities. Manual grants below remain untouched.
                </p>
              </Card>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Per-function toggles
                </p>
                <div className="space-y-1">
                  {ALL_CAPABILITIES.map(c => {
                    const isOn = activeSet.has(c.key);
                    return (
                      <div key={c.key} className="flex items-center justify-between gap-2 p-2 rounded border">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold">{c.label}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">{c.key}</p>
                        </div>
                        <Badge variant={c.risk === 'high' ? 'destructive' : c.risk === 'med' ? 'default' : 'secondary'} className="text-[9px]">
                          {c.risk}
                        </Badge>
                        <Switch
                          checked={isOn}
                          disabled={busy}
                          onCheckedChange={(v) => flip(c.key, v ? 'enable' : 'disable')}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/* =====================================================================
 * Bulk action sheet
 * ===================================================================*/

function BulkSheet({
  open, agentIds, onClose, onDone,
}: { open: boolean; agentIds: string[]; onClose: () => void; onDone: () => void }) {
  const [capability, setCapability] = useState<string>('');
  const [action, setAction] = useState<'enable'|'disable'>('disable');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!open) { setCapability(''); setReason(''); setAction('disable'); } }, [open]);

  const submit = async () => {
    if (!capability) { toast.error('Pick a function'); return; }
    if (reason.trim().length < 10) { toast.error('Reason must be at least 10 characters'); return; }
    if (agentIds.length === 0) { toast.error('No agents selected'); return; }

    setBusy(true);
    const { data, error } = await supabase.rpc('ops_bulk_set_agent_capability', {
      _agent_ids: agentIds,
      _capability: capability,
      _action: action,
      _reason: reason.trim(),
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    const result = data as { affected?: number; requested?: number } | null;
    toast.success(`${action === 'enable' ? 'Enabled' : 'Disabled'} ${capability} on ${result?.affected ?? 0}/${result?.requested ?? agentIds.length} agents`);
    onDone();
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Bulk action</SheetTitle>
          <SheetDescription>
            Applies to <span className="font-semibold">{agentIds.length}</span> selected agents.
            Max 5 000 per call.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-3">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Function</label>
            <Select value={capability} onValueChange={setCapability}>
              <SelectTrigger><SelectValue placeholder="Pick a function" /></SelectTrigger>
              <SelectContent>
                {ALL_CAPABILITIES.map(c => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Action</label>
            <Select value={action} onValueChange={(v) => setAction(v as 'enable'|'disable')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="enable">Enable</SelectItem>
                <SelectItem value="disable">Disable</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Reason (10+ chars)</label>
            <Textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Region-wide suspension pending KYC sweep on 2026-04-29"
              rows={3}
            />
          </div>
          <Button onClick={submit} disabled={busy} className="w-full">
            {busy ? 'Applying…' : `Apply to ${agentIds.length} agent${agentIds.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default AgentFeatureFlagsPanel;
