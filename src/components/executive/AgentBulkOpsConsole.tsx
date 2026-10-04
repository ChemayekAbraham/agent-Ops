import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import {
  ChevronLeft, Filter, FileUp, Layers, AlertTriangle, ShieldAlert, CheckCircle2, RefreshCw, Loader2, XCircle,
} from 'lucide-react';
import { ChevronDown, ChevronRight, Clock, AlertCircle, Search, User, History as HistoryIcon, Skull, Eye, Undo2 } from 'lucide-react';
import { Progress } from '@/components/ui/progress';

/**
 * AgentBulkOpsConsole
 * --------------------------------------------------------------------
 * Million-agent scale console to enable/disable functions across:
 *   1. SEGMENT  — server-side resolver across tier/region/district/
 *                 territory/frozen/inactivity/capability filters.
 *   2. CSV      — paste or upload a list of agent IDs, phones, or
 *                 emails; server matches and reports unmatched.
 *
 * Both modes feed the same "Apply" step which calls
 * ops_bulk_apply_capabilities (server chunks 5 000 agents per batch).
 */

const ALL_CAPABILITIES = [
  { key: 'view_agent_dashboard', label: 'View dashboard',     risk: 'low' as const },
  { key: 'collect_rent',         label: 'Collect rent',       risk: 'high' as const },
  { key: 'request_float',        label: 'Request float',      risk: 'high' as const },
  { key: 'process_cash_out',     label: 'Process cash-out',   risk: 'high' as const },
  { key: 'act_as_proxy',         label: 'Act as proxy',       risk: 'high' as const },
  { key: 'onboard_tenants',      label: 'Onboard tenants',    risk: 'med' as const },
  { key: 'onboard_landlords',    label: 'Onboard landlords',  risk: 'med' as const },
  { key: 'capture_supporters',   label: 'Capture supporters', risk: 'med' as const },
  { key: 'manage_subagents',     label: 'Manage sub-agents',  risk: 'med' as const },
  { key: 'approve_subagents',    label: 'Approve sub-agents', risk: 'med' as const },
  { key: 'view_subagent_data',   label: 'View sub-agent data',risk: 'low' as const },
];

type Tier = 'probation' | 'collector' | 'full_agent' | 'senior' | 'suspended';
const TIERS: Tier[] = ['probation','collector','full_agent','senior','suspended'];

interface ResolvedSet {
  source: 'segment' | 'csv';
  agentIds: string[];
  count: number;
  sample: Array<{ agent_id: string; full_name: string|null; phone: string|null; tier: string|null; is_frozen: boolean; last_active_at: string|null }>;
  unmatched?: string[];
}

export function AgentBulkOpsConsole({ onBack }: { onBack?: () => void }) {
  const [resolved, setResolved] = useState<ResolvedSet | null>(null);
  const [selectedCaps, setSelectedCaps] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<'enable'|'disable'>('disable');
  const [reason, setReason] = useState('');
  const [confirmCount, setConfirmCount] = useState('');

  // Quick-action presets — appear after a single agent is selected so the
  // manager doesn't re-pick the same combinations every time.
  type Preset = {
    key: string;
    label: string;
    caps: string[];
    action: 'enable' | 'disable';
    reason: string;
    tone: 'destructive' | 'warning' | 'success' | 'neutral';
    icon: typeof ShieldAlert;
  };
  const QUICK_PRESETS: Preset[] = [
    {
      key: 'freeze-all',
      label: 'Freeze (disable all high-risk)',
      caps: ['collect_rent','request_float','process_cash_out','act_as_proxy'],
      action: 'disable',
      reason: 'Single-agent freeze — disable all high-risk functions pending review',
      tone: 'destructive',
      icon: ShieldAlert,
    },
    {
      key: 'restore-default',
      label: 'Restore default agent set',
      caps: ['view_agent_dashboard','collect_rent','onboard_tenants','onboard_landlords'],
      action: 'enable',
      reason: 'Single-agent restore — re-enable the standard agent function set',
      tone: 'success',
      icon: CheckCircle2,
    },
    {
      key: 'block-cashout',
      label: 'Block cash-out only',
      caps: ['process_cash_out'],
      action: 'disable',
      reason: 'Single-agent — temporarily block cash-out pending verification',
      tone: 'warning',
      icon: AlertTriangle,
    },
    {
      key: 'block-collection',
      label: 'Block rent collection',
      caps: ['collect_rent'],
      action: 'disable',
      reason: 'Single-agent — pause rent collection pending investigation',
      tone: 'warning',
      icon: AlertTriangle,
    },
    {
      key: 'enable-supervisor',
      label: 'Enable supervisor tools',
      caps: ['manage_subagents','approve_subagents','view_subagent_data'],
      action: 'enable',
      reason: 'Single-agent — promote to supervisor with sub-agent management tools',
      tone: 'neutral',
      icon: Layers,
    },
  ];
  const applyPreset = (p: Preset) => {
    setSelectedCaps(new Set(p.caps));
    setAction(p.action);
    if (reason.trim().length < 10) setReason(p.reason);
    toast.success(`Preset loaded: ${p.label}`);
    // Scroll the reason/confirm card into view so the manager sees the CTA.
    requestAnimationFrame(() => {
      document.getElementById('bulk-ops-confirm-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  const toggleCap = (k: string) => {
    setSelectedCaps(prev => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
  };

  const apply = useMutation({
    mutationFn: async () => {
      if (!resolved) throw new Error('Resolve a segment or import a CSV first');
      if (selectedCaps.size === 0) throw new Error('Pick at least one function');
      if (reason.trim().length < 10) throw new Error('Reason must be at least 10 characters');
      if (resolved.count > 1000 && Number(confirmCount) !== resolved.count) {
        throw new Error(`Type the count (${resolved.count}) to confirm large changes`);
      }
      // Enqueue a background job — returns the job id immediately, work
      // happens asynchronously via the process-agent-capability-jobs worker.
      const { data: jobId, error } = await supabase.rpc('enqueue_agent_capability_job', {
        _agent_ids: resolved.agentIds,
        _capabilities: Array.from(selectedCaps),
        _action: action,
        _reason: reason.trim(),
        _source: resolved.source,
        _chunk_size: 1000,
      });
      if (error) throw error;
      // Kick the worker once so users don't wait up to 30s for cron.
      void supabase.functions.invoke('process-agent-capability-jobs', {
        body: { job_id: jobId },
      }).catch(() => { /* background, errors surface via job row */ });
      return jobId as string;
    },
    onSuccess: (jobId) => {
      toast.success('Job queued — running in the background');
      setActiveJobId(jobId);
      setResolved(null);
      setSelectedCaps(new Set());
      setReason('');
      setConfirmCount('');
    },
    onError: (e: any) => toast.error(e?.message ?? 'Failed'),
  });

  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const highRiskPicked = useMemo(
    () => Array.from(selectedCaps).some(k => ALL_CAPABILITIES.find(c => c.key === k)?.risk === 'high'),
    [selectedCaps],
  );

  return (
    <div className="space-y-4 pb-32 sm:pb-20 px-2 sm:px-0">
      {/* ============================ Header ============================ */}
      <div className="flex items-start gap-2">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="shrink-0">
            <ChevronLeft className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">Back</span>
          </Button>
        )}
        <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <Layers className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base sm:text-lg font-bold leading-tight">Agent Functions</h2>
          <p className="text-xs text-muted-foreground leading-snug">
            Turn agent abilities on or off — for one agent or many at once. It runs in the background, you can close this page anytime.
          </p>
        </div>
      </div>

      {/* ============================ Step guide ============================ */}
      <Card className="p-3 bg-muted/30 border-dashed">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 font-semibold">
          How it works
        </p>
        <ol className="text-xs space-y-1 list-decimal list-inside text-foreground/90">
          <li><strong>Pick the agents</strong> — by filter, by list, or just one.</li>
          <li><strong>Pick what to turn on or off</strong> — like “Collect rent” or “Cash-out”.</li>
          <li><strong>Write a short reason</strong> and tap the big button at the bottom.</li>
        </ol>
      </Card>

      <div className="flex flex-col lg:flex-row gap-4 items-start">
        <div className="flex-1 min-w-0 space-y-4 w-full">

      {/* Undo banner — shows whenever a finished job is still inside its 15-min window */}
      <UndoBanner />

      {/* Live + recent jobs */}
      <RecentJobsPanel highlightJobId={activeJobId} />
      <DeadLetterPanel />

      {/* Step 1 – build the agent set */}
      <Card className="p-3 sm:p-4">
        <p className="text-sm font-bold mb-1">Step 1 · Pick the agents</p>
        <p className="text-xs text-muted-foreground mb-3">
          Choose how to find them. Tap a tab below.
        </p>
        <Tabs defaultValue="single">
          {/* On phones: 3 equal-width pill tabs that wrap nicely */}
          <TabsList className="grid grid-cols-3 w-full h-auto p-1 gap-1">
            <TabsTrigger value="single" className="flex-col sm:flex-row gap-1 py-2 text-[11px] sm:text-xs">
              <Search className="h-4 w-4 sm:h-3 sm:w-3" /> One agent
            </TabsTrigger>
            <TabsTrigger value="segment" className="flex-col sm:flex-row gap-1 py-2 text-[11px] sm:text-xs">
              <Filter className="h-4 w-4 sm:h-3 sm:w-3" /> By filter
            </TabsTrigger>
            <TabsTrigger value="csv" className="flex-col sm:flex-row gap-1 py-2 text-[11px] sm:text-xs">
              <FileUp className="h-4 w-4 sm:h-3 sm:w-3" /> A list
            </TabsTrigger>
          </TabsList>
          <TabsContent value="single" className="mt-3">
            <SingleAgentForm onResolved={setResolved} />
          </TabsContent>
          <TabsContent value="segment" className="mt-3">
            <SegmentForm onResolved={setResolved} />
          </TabsContent>
          <TabsContent value="csv" className="mt-3">
            <CsvForm onResolved={setResolved} />
          </TabsContent>
        </Tabs>
      </Card>

      {/* Resolved preview */}
      {resolved && (
        <Card className="p-4 border-primary/40 bg-primary/5">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            <p className="text-sm font-semibold">
              {resolved.count.toLocaleString()} agents matched
              {resolved.unmatched && resolved.unmatched.length > 0 && (
                <span className="text-destructive ml-2">· {resolved.unmatched.length} unmatched</span>
              )}
            </p>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => setResolved(null)}>
              <RefreshCw className="h-3 w-3 mr-1" /> Clear
            </Button>
          </div>
          {resolved.sample.length > 0 && (
            <div className="text-xs space-y-1 max-h-40 overflow-y-auto">
              {resolved.sample.slice(0, 25).map(s => (
                <div key={s.agent_id} className="flex justify-between gap-2 border-b last:border-b-0 py-1">
                  <span className="truncate">{s.full_name ?? s.agent_id.slice(0,8)}</span>
                  <span className="text-muted-foreground truncate">{s.phone ?? '—'}</span>
                  <Badge variant="outline" className="text-[9px] capitalize">{(s.tier ?? 'unset').replace('_',' ')}</Badge>
                </div>
              ))}
              {resolved.count > 25 && (
                <p className="text-muted-foreground italic">…and {(resolved.count - 25).toLocaleString()} more</p>
              )}
            </div>
          )}
          {resolved.unmatched && resolved.unmatched.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-destructive">
                Show {resolved.unmatched.length} unmatched identifier{resolved.unmatched.length === 1 ? '' : 's'}
              </summary>
              <pre className="bg-muted/50 p-2 mt-1 rounded max-h-32 overflow-auto whitespace-pre-wrap">
                {resolved.unmatched.join('\n')}
              </pre>
            </details>
          )}

          {/* Quick actions — single-agent only */}
          {resolved.count === 1 && (
            <div className="mt-3 pt-3 border-t border-primary/20">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Quick actions for this agent
              </p>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_PRESETS.map(p => {
                  const Icon = p.icon;
                  const toneClass =
                    p.tone === 'destructive' ? 'border-destructive/40 text-destructive hover:bg-destructive/10' :
                    p.tone === 'warning'     ? 'border-amber-300 text-amber-700 hover:bg-amber-50' :
                    p.tone === 'success'     ? 'border-emerald-300 text-emerald-700 hover:bg-emerald-50' :
                                               'border-border text-foreground hover:bg-muted';
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => applyPreset(p)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold transition active:scale-95 ${toneClass}`}
                      title={`${p.action === 'enable' ? 'Enable' : 'Disable'}: ${p.caps.join(', ')}`}
                    >
                      <Icon className="h-3 w-3" />
                      {p.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5">
                Presets pre-fill the function list, action, and reason — review and confirm in step 3.
              </p>
            </div>
          )}
        </Card>
      )}

      {/* Step 2 – functions + action */}
      <Card className="p-3 sm:p-4">
        <div className="flex items-start justify-between gap-2 mb-1">
          <p className="text-sm font-bold">Step 2 · Pick what to change</p>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setSelectedCaps(new Set(ALL_CAPABILITIES.map(c => c.key)))}
              className="text-[10px] underline text-muted-foreground hover:text-foreground"
            >
              Pick all
            </button>
            <span className="text-muted-foreground/50 text-[10px]">·</span>
            <button
              type="button"
              onClick={() => setSelectedCaps(new Set())}
              className="text-[10px] underline text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Big enable/disable toggle so it's the FIRST thing the eye picks up */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <button
            type="button"
            onClick={() => setAction('enable')}
            className={`p-3 rounded-xl border-2 text-center transition active:scale-95 ${
              action === 'enable'
                ? 'border-emerald-500 bg-emerald-50 text-emerald-900 shadow-sm'
                : 'border-border bg-background text-muted-foreground hover:border-emerald-300'
            }`}
          >
            <CheckCircle2 className="h-5 w-5 mx-auto mb-1" />
            <p className="text-sm font-bold">Turn ON</p>
            <p className="text-[10px]">give the function</p>
          </button>
          <button
            type="button"
            onClick={() => setAction('disable')}
            className={`p-3 rounded-xl border-2 text-center transition active:scale-95 ${
              action === 'disable'
                ? 'border-destructive bg-destructive/10 text-destructive shadow-sm'
                : 'border-border bg-background text-muted-foreground hover:border-destructive/40'
            }`}
          >
            <XCircle className="h-5 w-5 mx-auto mb-1" />
            <p className="text-sm font-bold">Turn OFF</p>
            <p className="text-[10px]">remove the function</p>
          </button>
        </div>

        <p className="text-[11px] text-muted-foreground mb-2">
          Tap each function you want to <strong>{action === 'enable' ? 'turn ON' : 'turn OFF'}</strong>.
          Red = sensitive (cash, rent, proxy).
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
          {ALL_CAPABILITIES.map(c => {
            const checked = selectedCaps.has(c.key);
            return (
              <label
                key={c.key}
                className={`flex items-center justify-between gap-2 p-3 rounded-lg border-2 cursor-pointer transition active:scale-[0.99] ${
                  checked
                    ? action === 'enable'
                      ? 'border-emerald-500 bg-emerald-50/60'
                      : 'border-destructive bg-destructive/5'
                    : c.risk === 'high'
                      ? 'border-destructive/30 bg-destructive/5'
                      : 'border-border bg-background'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold leading-tight">{c.label}</p>
                  <p className="text-[10px] text-muted-foreground hidden sm:block font-mono truncate">
                    {c.key}
                  </p>
                </div>
                {c.risk === 'high' && (
                  <Badge variant="destructive" className="text-[9px] shrink-0">sensitive</Badge>
                )}
                <Switch
                  checked={checked}
                  onCheckedChange={() => toggleCap(c.key)}
                />
              </label>
            );
          })}
        </div>

        {highRiskPicked && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-destructive/10 border border-destructive/30">
            <ShieldAlert className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <p className="text-xs text-destructive">
              You picked a <strong>sensitive</strong> function. Double-check the agent list before you confirm.
            </p>
          </div>
        )}
      </Card>

      {/* Step 3 – reason + confirm */}
      <Card id="bulk-ops-confirm-card" className="p-3 sm:p-4">
        <p className="text-sm font-bold mb-1">Step 3 · Say why &amp; confirm</p>
        <p className="text-xs text-muted-foreground mb-2">
          Write a short reason (at least 10 letters). This is kept for the audit trail.
        </p>
        <Textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={2}
          placeholder="Example: Pausing rent collection while we review missing receipts"
          className="text-base sm:text-sm"
        />
        <div className="flex items-center justify-between mt-1">
          <span className={`text-[10px] ${reason.trim().length >= 10 ? 'text-emerald-600' : 'text-muted-foreground'}`}>
            {reason.trim().length >= 10
              ? '✓ Reason looks good'
              : `${Math.max(0, 10 - reason.trim().length)} more letter${10 - reason.trim().length === 1 ? '' : 's'} needed`}
          </span>
        </div>

        {resolved && resolved.count > 1000 && (
          <div className="mt-3 p-2 rounded-lg border-2 border-destructive/40 bg-destructive/5">
            <label className="text-xs flex items-center gap-1 text-destructive font-bold">
              <AlertTriangle className="h-3 w-3" /> Big change — type the number {resolved.count.toLocaleString()} to confirm
            </label>
            <Input
              value={confirmCount}
              onChange={e => setConfirmCount(e.target.value)}
              placeholder={String(resolved.count)}
              className="mt-1 text-base sm:text-sm"
              inputMode="numeric"
            />
          </div>
        )}

        <Button
          size="lg"
          className={`w-full mt-3 h-12 text-sm sm:text-base font-bold ${
            action === 'enable' ? '' : 'bg-destructive hover:bg-destructive/90'
          }`}
          disabled={apply.isPending || !resolved || selectedCaps.size === 0 || reason.trim().length < 10}
          onClick={() => apply.mutate()}
        >
          {apply.isPending
            ? 'Saving…'
            : !resolved
              ? 'Pick agents in Step 1'
              : selectedCaps.size === 0
                ? 'Pick at least one function in Step 2'
                : reason.trim().length < 10
                  ? 'Write a reason in Step 3'
                  : `${action === 'enable' ? 'Turn ON' : 'Turn OFF'} ${selectedCaps.size} function${selectedCaps.size === 1 ? '' : 's'} for ${resolved.count.toLocaleString()} agent${resolved.count === 1 ? '' : 's'}`}
        </Button>
        <p className="text-[10px] text-muted-foreground text-center mt-2">
          Runs in the background. You can close this page after you tap.
        </p>
      </Card>
        </div>

        {/* Right rail — agent snapshot when a single agent is staged.
            On phones we collapse it behind a "Show details" toggle so the
            main 3-step flow stays uncluttered. */}
        {resolved && resolved.count === 1 && (
          <SingleAgentDetailsRail
            agentId={resolved.agentIds[0]}
            fallbackName={resolved.sample[0]?.full_name ?? null}
            fallbackPhone={resolved.sample[0]?.phone ?? null}
            pendingCaps={Array.from(selectedCaps)}
            pendingAction={action}
          />
        )}
      </div>
    </div>
  );
}

/* =====================================================================
 * SingleAgentDetailsRail — wraps the agent snapshot + history. On
 * desktop it sits as a sticky right-side panel; on phones it collapses
 * behind a tap-to-open toggle so the 3-step flow stays focused.
 * =====================================================================*/
function SingleAgentDetailsRail({
  agentId, fallbackName, fallbackPhone, pendingCaps, pendingAction,
}: {
  agentId: string;
  fallbackName: string | null;
  fallbackPhone: string | null;
  pendingCaps: string[];
  pendingAction: 'enable' | 'disable';
}) {
  const [openOnMobile, setOpenOnMobile] = useState(false);
  return (
    <aside className="w-full lg:w-80 lg:sticky lg:top-4 shrink-0">
      <button
        type="button"
        onClick={() => setOpenOnMobile(v => !v)}
        className="lg:hidden w-full mb-2 flex items-center justify-between gap-2 p-3 rounded-lg border bg-card"
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Eye className="h-4 w-4 text-primary" />
          {openOnMobile ? 'Hide agent details' : 'Show agent details'}
        </span>
        {openOnMobile ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      <div className={`${openOnMobile ? 'block' : 'hidden'} lg:block space-y-3`}>
        <AgentSnapshotPanel
          agentId={agentId}
          fallbackName={fallbackName}
          fallbackPhone={fallbackPhone}
          pendingCaps={pendingCaps}
          pendingAction={pendingAction}
        />
        <AgentHistoryPanel agentId={agentId} />
      </div>
    </aside>
  );
}

/* =====================================================================
 * Segment form
 * ===================================================================*/
function SegmentForm({ onResolved }: { onResolved: (r: ResolvedSet) => void }) {
  const [tier, setTier] = useState<Tier | 'all'>('all');
  const [region, setRegion] = useState('');
  const [district, setDistrict] = useState('');
  const [territory, setTerritory] = useState('');
  const [frozen, setFrozen] = useState<'any'|'frozen'|'active'>('any');
  const [inactiveDays, setInactiveDays] = useState('');
  const [hasCap, setHasCap] = useState<string>('');
  const [missingCap, setMissingCap] = useState<string>('');

  const resolve = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('ops_resolve_agent_segment', {
        _tier: tier === 'all' ? null : tier,
        _region: region.trim() || null,
        _district: district.trim() || null,
        _territory: territory.trim() || null,
        _frozen: frozen === 'any' ? null : frozen === 'frozen',
        _inactive_days: inactiveDays ? Number(inactiveDays) : null,
        _has_capability: hasCap || null,
        _missing_capability: missingCap || null,
        _limit_preview: 50,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (d) => {
      onResolved({
        source: 'segment',
        agentIds: d?.agent_ids ?? [],
        count: Number(d?.count ?? 0),
        sample: d?.sample ?? [],
      });
      toast.success(`Found ${Number(d?.count ?? 0).toLocaleString()} agents`);
    },
    onError: (e: any) => toast.error(e?.message ?? 'Resolve failed'),
  });

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Set any filters you want, then tap <strong>Find agents</strong>. Leave fields blank to skip them.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
      <Select value={tier} onValueChange={(v) => setTier(v as Tier | 'all')}>
        <SelectTrigger><SelectValue placeholder="Tier" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All tiers</SelectItem>
          {TIERS.map(t => <SelectItem key={t} value={t}>{t.replace('_',' ')}</SelectItem>)}
        </SelectContent>
      </Select>
      <Input placeholder="Region (e.g. Central)" value={region} onChange={e => setRegion(e.target.value)} className="text-base sm:text-sm" />
      <Input placeholder="District" value={district} onChange={e => setDistrict(e.target.value)} className="text-base sm:text-sm" />
      <Input placeholder="Territory" value={territory} onChange={e => setTerritory(e.target.value)} className="text-base sm:text-sm" />
      <Select value={frozen} onValueChange={(v) => setFrozen(v as any)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Any status</SelectItem>
          <SelectItem value="frozen">Frozen only</SelectItem>
          <SelectItem value="active">Active only</SelectItem>
        </SelectContent>
      </Select>
      <Input
        placeholder="Inactive for at least N days"
        type="number"
        inputMode="numeric"
        value={inactiveDays}
        onChange={e => setInactiveDays(e.target.value)}
        className="text-base sm:text-sm"
      />
      <Select value={hasCap || 'none'} onValueChange={(v) => setHasCap(v === 'none' ? '' : v)}>
        <SelectTrigger><SelectValue placeholder="Already has function…" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">— Already has function —</SelectItem>
          {ALL_CAPABILITIES.map(c => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={missingCap || 'none'} onValueChange={(v) => setMissingCap(v === 'none' ? '' : v)}>
        <SelectTrigger><SelectValue placeholder="Missing function…" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">— Missing function —</SelectItem>
          {ALL_CAPABILITIES.map(c => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
        </SelectContent>
      </Select>
      </div>
      <Button onClick={() => resolve.mutate()} disabled={resolve.isPending} className="w-full h-11">
        <Search className="h-4 w-4 mr-2" />
        {resolve.isPending ? 'Searching…' : 'Find agents'}
      </Button>
    </div>
  );
}

/* =====================================================================
 * CSV / paste form
 * ===================================================================*/
function CsvForm({ onResolved }: { onResolved: (r: ResolvedSet) => void }) {
  const [text, setText] = useState('');

  const parseItems = (raw: string): string[] => {
    return raw
      .split(/[\s,;\n\r\t]+/)
      .map(s => s.trim())
      .filter(Boolean);
  };

  const onFile = async (file: File) => {
    const t = await file.text();
    setText(t);
  };

  const resolve = useMutation({
    mutationFn: async () => {
      const items = parseItems(text);
      if (items.length === 0) throw new Error('Paste or upload at least one identifier');
      if (items.length > 200_000) throw new Error('Cap is 200 000 identifiers per import');
      const { data, error } = await supabase.rpc('ops_resolve_agents_by_identifier', { _items: items });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (d) => {
      const matched = (d?.matched ?? []) as Array<any>;
      onResolved({
        source: 'csv',
        agentIds: matched.map(m => m.agent_id),
        count: matched.length,
        sample: matched.slice(0, 50).map(m => ({
          agent_id: m.agent_id,
          full_name: m.full_name,
          phone: m.phone,
          tier: null,
          is_frozen: false,
          last_active_at: null,
        })),
        unmatched: d?.unmatched ?? [],
      });
      toast.success(`Matched ${matched.length} · unmatched ${(d?.unmatched ?? []).length}`);
    },
    onError: (e: any) => toast.error(e?.message ?? 'Resolve failed'),
  });

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Paste agent <strong>phone numbers</strong>, <strong>emails</strong>, or <strong>IDs</strong> — one per line. Or upload a CSV/TXT file.
      </p>
      <Textarea
        rows={6}
        placeholder={'+256700123456\n+256700123457\nagent@example.com'}
        value={text}
        onChange={e => setText(e.target.value)}
        className="text-base sm:text-sm font-mono"
      />
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <Input
          type="file"
          accept=".csv,.txt"
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }}
          className="sm:max-w-xs text-xs"
        />
        <span className="text-xs text-muted-foreground">
          {parseItems(text).length.toLocaleString()} item{parseItems(text).length === 1 ? '' : 's'} ready
        </span>
        <div className="flex-1" />
        <Button onClick={() => resolve.mutate()} disabled={resolve.isPending} className="w-full sm:w-auto h-11 sm:h-10">
          <Search className="h-4 w-4 mr-2" />
          {resolve.isPending ? 'Checking…' : 'Find these agents'}
        </Button>
      </div>
    </div>
  );
}

export default AgentBulkOpsConsole;

/* =====================================================================
 * AgentSnapshotPanel — pre-submit side panel showing the selected agent's
 * current capabilities, status, and last-update timestamp so the manager
 * can sanity-check the impact before queuing the change.
 * ===================================================================*/
function AgentSnapshotPanel({
  agentId, fallbackName, fallbackPhone, pendingCaps, pendingAction,
}: {
  agentId: string;
  fallbackName: string | null;
  fallbackPhone: string | null;
  pendingCaps: string[];
  pendingAction: 'enable' | 'disable';
}) {
  // Auto-refresh: off by default. User picks an interval; we feed it to React Query.
  const [autoMs, setAutoMs] = useState<number>(0); // 0 = off
  // Per-capability expanded history (last 10 enable/disable updates for that capability)
  const [openCap, setOpenCap] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['agent-snapshot', agentId],
    queryFn: async () => {
      const capsRes = await supabase
        .from('agent_capabilities')
        .select('capability,status,granted_at,revoked_at,updated_at')
        .eq('agent_id', agentId)
        .order('updated_at', { ascending: false });
      if (capsRes.error) throw capsRes.error;

      const profileRes = await supabase
        .from('profiles')
        .select('full_name,phone,is_frozen,last_active_at')
        .eq('id', agentId)
        .maybeSingle();

      return {
        caps: capsRes.data ?? [],
        profile: (profileRes.data as {
          full_name: string | null;
          phone: string | null;
          is_frozen: boolean | null;
          last_active_at: string | null;
        } | null) ?? null,
      };
    },
    staleTime: autoMs > 0 ? autoMs : 15_000,
    refetchInterval: autoMs > 0 ? autoMs : false,
    refetchIntervalInBackground: false,
  });
  const data = q.data;
  const isLoading = q.isLoading;
  const refetch = q.refetch;
  const dataUpdatedAt = q.dataUpdatedAt;

  const activeByKey = useMemo(() => {
    const map = new Map<string, { status: string; updated_at: string }>();
    for (const c of data?.caps ?? []) {
      const cur = map.get(c.capability);
      if (!cur || new Date(c.updated_at) > new Date(cur.updated_at)) {
        map.set(c.capability, { status: c.status, updated_at: c.updated_at });
      }
    }
    return map;
  }, [data]);

  const lastUpdated = useMemo(() => {
    const ts = (data?.caps ?? []).map(c => new Date(c.updated_at).getTime());
    if (ts.length === 0) return null;
    return new Date(Math.max(...ts));
  }, [data]);

  const profile = data?.profile;
  const displayName = profile?.full_name ?? fallbackName ?? agentId.slice(0, 8);
  const displayPhone = profile?.phone ?? fallbackPhone ?? '—';

  // Diff: which pending changes are no-ops vs real changes?
  const diff = useMemo(() => {
    const noop: string[] = [];
    const change: string[] = [];
    const newGrants: string[] = [];
    for (const cap of pendingCaps) {
      const cur = activeByKey.get(cap);
      const isCurrentlyEnabled = cur?.status === 'active' || cur?.status === 'granted';
      const willBeEnabled = pendingAction === 'enable';
      if (isCurrentlyEnabled === willBeEnabled) noop.push(cap);
      else if (!cur && pendingAction === 'enable') newGrants.push(cap);
      else change.push(cap);
    }
    return { noop, change, newGrants };
  }, [pendingCaps, activeByKey, pendingAction]);

  return (
    <Card className="p-3 border-primary/30">
      <div className="flex items-start gap-2">
        <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <User className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold truncate">{displayName}</p>
          <p className="text-[10px] text-muted-foreground font-mono truncate">{displayPhone}</p>
          <p className="text-[10px] text-muted-foreground font-mono truncate">{agentId}</p>
        </div>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => refetch()} title="Refresh">
          <RefreshCw className={`h-3 w-3 ${autoMs > 0 && q.isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Auto-refresh control */}
      <div className="mt-2 flex items-center justify-between gap-2 px-1.5 py-1 rounded border border-border bg-muted/30">
        <div className="flex items-center gap-1.5 min-w-0">
          <RefreshCw className={`h-3 w-3 shrink-0 ${autoMs > 0 ? 'text-primary' : 'text-muted-foreground'} ${autoMs > 0 && q.isFetching ? 'animate-spin' : ''}`} />
          <span className="text-[10px] text-muted-foreground truncate">
            {autoMs > 0 ? `Auto-refresh every ${autoMs / 1000}s` : 'Auto-refresh off'}
          </span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {[0, 5, 10, 30].map(s => (
            <Button
              key={s}
              size="sm"
              variant={autoMs === s * 1000 ? 'default' : 'ghost'}
              className="h-5 px-1.5 text-[9px]"
              onClick={() => setAutoMs(s * 1000)}
              title={s === 0 ? 'Disable auto-refresh' : `Refresh every ${s} seconds`}
            >
              {s === 0 ? 'Off' : `${s}s`}
            </Button>
          ))}
        </div>
      </div>

      {/* Status row */}
      <div className="flex flex-wrap gap-1 mt-2">
        <Badge variant={profile?.is_frozen ? 'destructive' : 'secondary'} className="text-[9px]">
          {profile?.is_frozen ? 'Frozen' : 'Active'}
        </Badge>
        <Badge variant="outline" className="text-[9px]">
          {activeByKey.size} active function{activeByKey.size === 1 ? '' : 's'}
        </Badge>
        {profile?.last_active_at && (
          <Badge variant="outline" className="text-[9px]" title={profile.last_active_at}>
            seen {new Date(profile.last_active_at).toLocaleDateString()}
          </Badge>
        )}
        {lastUpdated && (
          <Badge variant="outline" className="text-[9px]" title={lastUpdated.toISOString()}>
            last change {lastUpdated.toLocaleDateString()}
          </Badge>
        )}
      </div>

      {/* Pending diff summary */}
      {pendingCaps.length > 0 && (
        <div className="mt-3 p-2 rounded border border-primary/30 bg-primary/5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-primary mb-1">
            Pending: {pendingAction === 'enable' ? 'enable' : 'disable'} {pendingCaps.length}
          </p>
          <div className="text-[10px] space-y-0.5">
            {diff.change.length > 0 && (
              <p className="text-amber-700">
                <strong>{diff.change.length}</strong> will change
              </p>
            )}
            {diff.newGrants.length > 0 && (
              <p className="text-emerald-700">
                <strong>{diff.newGrants.length}</strong> new grant{diff.newGrants.length === 1 ? '' : 's'}
              </p>
            )}
            {diff.noop.length > 0 && (
              <p className="text-muted-foreground">
                <strong>{diff.noop.length}</strong> already in target state (no-op)
              </p>
            )}
          </div>
        </div>
      )}

      {/* Current capabilities list */}
      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
          Current functions ({activeByKey.size})
        </p>
        {isLoading ? (
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground py-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : activeByKey.size === 0 ? (
          <p className="text-[10px] text-muted-foreground py-2">No capabilities recorded.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto space-y-0.5">
            {ALL_CAPABILITIES.map(c => {
              const cur = activeByKey.get(c.key);
              const enabled = cur?.status === 'active' || cur?.status === 'granted';
              const willBeTouched = pendingCaps.includes(c.key);
              const isOpen = openCap === c.key;
              return (
                <div key={c.key}>
                  <button
                    type="button"
                    onClick={() => setOpenCap(isOpen ? null : c.key)}
                    className={`w-full flex items-center gap-2 text-[10px] py-1 px-1.5 rounded text-left hover:bg-muted/50 transition-colors ${
                      willBeTouched ? 'bg-primary/10 ring-1 ring-primary/30' : ''
                    }`}
                    title="Show last 10 updates for this function"
                  >
                    {isOpen
                      ? <ChevronDown className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                      : <ChevronRight className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />}
                    <span className={`h-2 w-2 rounded-full shrink-0 ${
                      enabled ? 'bg-emerald-500' : cur ? 'bg-muted-foreground/40' : 'bg-muted-foreground/20'
                    }`} />
                    <span className="truncate flex-1" title={c.key}>{c.label}</span>
                    {cur && (
                      <span
                        className="text-muted-foreground tabular-nums shrink-0"
                        title={`Last updated ${new Date(cur.updated_at).toLocaleString()}`}
                      >
                        {new Date(cur.updated_at).toLocaleDateString()}
                      </span>
                    )}
                    {willBeTouched && (
                      <Badge
                        variant={pendingAction === 'enable' ? 'default' : 'destructive'}
                        className="text-[8px] py-0 px-1 shrink-0"
                      >
                        {pendingAction === 'enable' ? '+EN' : '−DIS'}
                      </Badge>
                    )}
                  </button>
                  {isOpen && (
                    <CapabilityHistoryRow agentId={agentId} capability={c.key} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer: last-updated overall */}
      <div className="mt-2 pt-2 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground">
        <span title={lastUpdated?.toISOString()}>
          Last function update: {lastUpdated ? lastUpdated.toLocaleString() : '—'}
        </span>
        <span title={new Date(dataUpdatedAt).toISOString()}>
          Snapshot {new Date(dataUpdatedAt).toLocaleTimeString()}
        </span>
      </div>
    </Card>
  );
}

/* =====================================================================
 * CapabilityHistoryRow — last 10 enable/disable updates that touched
 * this specific (agent, capability) pair. Derived from
 * agent_capability_ops_jobs (the only durable history source) by
 * filtering jobs whose agent_ids array contains this agent and whose
 * capabilities array contains this capability. Each entry shows the
 * action, when it ran, the source channel, and the audit reason.
 * =====================================================================*/
function CapabilityHistoryRow({ agentId, capability }: { agentId: string; capability: string }) {
  const q = useQuery({
    queryKey: ['cap-history', agentId, capability],
    queryFn: async () => {
      const res = await supabase
        .from('agent_capability_ops_jobs')
        .select('id,action,reason,status,source,created_at,finished_at,requested_by,failed_total')
        .contains('agent_ids', [agentId])
        .contains('capabilities', [capability])
        .order('created_at', { ascending: false })
        .limit(10);
      if (res.error) throw res.error;
      return res.data ?? [];
    },
    staleTime: 30_000,
  });

  const rows = q.data ?? [];

  return (
    <div className="ml-5 mr-1 mb-1 mt-0.5 border-l-2 border-border pl-2 py-1 space-y-0.5">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
        Last 10 updates
      </p>
      {q.isLoading ? (
        <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground py-0.5">
          <Loader2 className="h-2.5 w-2.5 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <p className="text-[9px] text-muted-foreground py-0.5">
          No bulk-ops history for this function.
        </p>
      ) : (
        rows.map(r => {
          const failed = r.status === 'failed' || (r.failed_total ?? 0) > 0;
          return (
            <div key={r.id} className="flex items-center gap-1.5 text-[9px]">
              <Badge
                variant={r.action === 'enable' ? 'default' : 'destructive'}
                className="text-[8px] py-0 px-1 shrink-0"
              >
                {r.action === 'enable' ? '+EN' : '−DIS'}
              </Badge>
              <span
                className="text-muted-foreground tabular-nums shrink-0"
                title={r.created_at}
              >
                {new Date(r.created_at).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </span>
              <span className="text-muted-foreground shrink-0">·</span>
              <span className="text-muted-foreground shrink-0" title={`source: ${r.source}`}>
                {r.source}
              </span>
              {failed && (
                <Badge variant="destructive" className="text-[8px] py-0 px-1 shrink-0">
                  failed
                </Badge>
              )}
              {r.status === 'cancelled' && (
                <Badge variant="outline" className="text-[8px] py-0 px-1 shrink-0">
                  cancelled
                </Badge>
              )}
              <span
                className="text-muted-foreground italic truncate flex-1 min-w-0"
                title={r.reason ?? ''}
              >
                {r.reason ? `“${r.reason}”` : ''}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

/* =====================================================================
 * SingleAgentForm — find ONE agent by ID, phone, or email and stage them
 * as a 1-agent target. Lets a manager work on a specific agent inside the
 * same Bulk Ops flow (same audit, same job pipeline).
 * =====================================================================*/
/* =====================================================================
 * AgentHistoryPanel — past ops jobs that targeted this agent + outcomes.
 * Pulls from agent_capability_ops_jobs (filtered by agent_ids @> {id}),
 * each job's batch outcomes, and any open dead-letter rows. Read-only.
 * =====================================================================*/
function AgentHistoryPanel({ agentId }: { agentId: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['agent-ops-history', agentId],
    queryFn: async () => {
      const jobsRes = await supabase
        .from('agent_capability_ops_jobs')
        .select('id,action,capabilities,reason,status,source,total_agents,affected_total,failed_total,total_batches,batches_done,created_at,started_at,finished_at,last_error')
        .contains('agent_ids', [agentId])
        .order('created_at', { ascending: false })
        .limit(25);
      if (jobsRes.error) throw jobsRes.error;
      const jobs = jobsRes.data ?? [];
      const jobIds = jobs.map(j => j.id);

      let dlMap: Record<string, number> = {};
      if (jobIds.length > 0) {
        const dlRes = await supabase
          .from('agent_capability_ops_dead_letters')
          .select('job_id,agent_ids,resolved_at')
          .in('job_id', jobIds)
          .is('resolved_at', null);
        if (!dlRes.error) {
          for (const row of dlRes.data ?? []) {
            const ids = (row as { agent_ids: string[] }).agent_ids ?? [];
            if (ids.includes(agentId)) {
              dlMap[row.job_id] = (dlMap[row.job_id] ?? 0) + 1;
            }
          }
        }
      }
      return { jobs, dlMap };
    },
    staleTime: 20_000,
  });

  const batchesQ = useQuery({
    queryKey: ['agent-ops-history-batches', expanded],
    enabled: !!expanded,
    queryFn: async () => {
      const res = await supabase
        .from('agent_capability_ops_job_batches')
        .select('id,batch_index,capability,status,affected,attempt_count,last_error,finished_at')
        .eq('job_id', expanded as string)
        .order('batch_index', { ascending: true });
      if (res.error) throw res.error;
      return res.data ?? [];
    },
    staleTime: 20_000,
  });

  const jobs = q.data?.jobs ?? [];
  const dlMap = q.data?.dlMap ?? {};

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          <HistoryIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-xs font-semibold">Ops history</p>
          <Badge variant="outline" className="text-[9px]">{jobs.length}</Badge>
        </div>
        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => q.refetch()} title="Refresh">
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      {q.isLoading ? (
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground py-3">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading history…
        </div>
      ) : jobs.length === 0 ? (
        <p className="text-[10px] text-muted-foreground py-3">
          No prior bulk-ops jobs touched this agent.
        </p>
      ) : (
        <div className="max-h-80 overflow-y-auto space-y-1.5">
          {jobs.map(j => {
            const isOpen = expanded === j.id;
            const dl = dlMap[j.id] ?? 0;
            const failed = (j.failed_total ?? 0) > 0 || j.status === 'failed' || dl > 0;
            const tone =
              j.status === 'done' && !failed ? 'text-emerald-700' :
              j.status === 'cancelled' ? 'text-muted-foreground' :
              failed ? 'text-destructive' :
              j.status === 'running' ? 'text-amber-700' :
              'text-foreground';
            return (
              <div key={j.id} className="border border-border rounded">
                <button
                  type="button"
                  className="w-full text-left p-2 hover:bg-muted/40 transition-colors"
                  onClick={() => setExpanded(isOpen ? null : j.id)}
                >
                  <div className="flex items-start gap-1.5">
                    {isOpen
                      ? <ChevronDown className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground" />
                      : <ChevronRight className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge
                          variant={j.action === 'enable' ? 'default' : 'destructive'}
                          className="text-[8px] py-0 px-1"
                        >
                          {j.action}
                        </Badge>
                        <span className="text-[10px] font-medium truncate" title={j.capabilities.join(', ')}>
                          {j.capabilities.length === 1
                            ? j.capabilities[0]
                            : `${j.capabilities.length} functions`}
                        </span>
                        <span className={`text-[9px] uppercase tracking-wider ml-auto ${tone}`}>
                          {j.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap mt-1 text-[9px] text-muted-foreground">
                        <Clock className="h-2.5 w-2.5" />
                        <span title={j.created_at}>{new Date(j.created_at).toLocaleString()}</span>
                        <span>·</span>
                        <span>{j.source}</span>
                        <span>·</span>
                        <span>{j.total_agents.toLocaleString()} agents</span>
                        {(j.failed_total ?? 0) > 0 && (
                          <Badge variant="destructive" className="text-[8px] py-0 px-1 ml-1">
                            <AlertCircle className="h-2 w-2 mr-0.5" />{j.failed_total} failed
                          </Badge>
                        )}
                        {dl > 0 && (
                          <Badge variant="destructive" className="text-[8px] py-0 px-1">
                            <Skull className="h-2 w-2 mr-0.5" />{dl} DL
                          </Badge>
                        )}
                      </div>
                      {j.reason && (
                        <p className="text-[9px] text-muted-foreground italic mt-1 line-clamp-2" title={j.reason}>
                          “{j.reason}”
                        </p>
                      )}
                    </div>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-border bg-muted/20 p-2 space-y-1">
                    {j.last_error && (
                      <p className="text-[9px] text-destructive font-mono break-all">
                        {j.last_error}
                      </p>
                    )}
                    {batchesQ.isLoading ? (
                      <div className="flex items-center gap-2 text-[9px] text-muted-foreground">
                        <Loader2 className="h-2.5 w-2.5 animate-spin" /> Loading batches…
                      </div>
                    ) : (batchesQ.data ?? []).length === 0 ? (
                      <p className="text-[9px] text-muted-foreground">No batches recorded.</p>
                    ) : (
                      <div className="space-y-0.5">
                        {(batchesQ.data ?? []).map(b => {
                          const bTone =
                            b.status === 'done' ? 'bg-emerald-500' :
                            b.status === 'running' ? 'bg-amber-500' :
                            b.status === 'failed' ? 'bg-destructive' :
                            b.status === 'dead_letter' ? 'bg-destructive' :
                            'bg-muted-foreground/40';
                          return (
                            <div key={b.id} className="flex items-center gap-1.5 text-[9px]">
                              <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${bTone}`} />
                              <span className="font-mono shrink-0">#{b.batch_index}</span>
                              <span className="truncate flex-1" title={b.capability}>{b.capability}</span>
                              <span className="text-muted-foreground tabular-nums shrink-0">
                                {b.affected}/{b.attempt_count}a
                              </span>
                              {b.last_error && (
                                <span className="text-destructive truncate max-w-[6rem]" title={b.last_error}>
                                  err
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <p className="text-[9px] text-muted-foreground pt-1 border-t border-border">
                      job {j.id.slice(0, 8)} · {j.batches_done}/{j.total_batches} batches · {j.affected_total} affected
                      {j.finished_at && ` · finished ${new Date(j.finished_at).toLocaleString()}`}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* =====================================================================
 * UndoBanner — sticky banner that appears whenever the current user has
 * a finished bulk-ops job within the last 15 minutes that has NOT been
 * undone yet. Shows a live countdown and a single "Undo" button that
 * calls ops_undo_agent_capability_job to restore exactly the rows the
 * job changed (using the per-row prior-state snapshot table).
 * =====================================================================*/
function UndoBanner() {
  const UNDO_WINDOW_MIN = 15;
  const [tick, setTick] = useState(0);
  const [undoing, setUndoing] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const q = useQuery({
    queryKey: ['undo-eligible-job'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;
      const cutoff = new Date(Date.now() - UNDO_WINDOW_MIN * 60_000).toISOString();
      const res = await supabase
        .from('agent_capability_ops_jobs')
        .select('id,action,capabilities,total_agents,affected_total,finished_at,undone_at,status,reason')
        .eq('requested_by', user.id)
        .gte('finished_at', cutoff)
        .is('undone_at', null)
        .in('status', ['done', 'failed', 'cancelled'])
        .order('finished_at', { ascending: false })
        .limit(1);
      if (res.error) throw res.error;
      return res.data?.[0] ?? null;
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  // Re-render every second so the countdown ticks
  useEffect(() => {
    if (!q.data?.finished_at) return;
    const i = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(i);
  }, [q.data?.finished_at]);

  const job = q.data;
  const remainingMs = useMemo(() => {
    if (!job?.finished_at) return 0;
    const ends = new Date(job.finished_at).getTime() + UNDO_WINDOW_MIN * 60_000;
    return Math.max(0, ends - Date.now());
    // tick is read so this re-runs every second
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.finished_at, tick]);

  const undo = useMutation({
    mutationFn: async () => {
      if (!job) throw new Error('No job to undo');
      if (reason.trim().length < 10) throw new Error('Type at least 10 characters of reason');
      const { data, error } = await supabase.rpc('ops_undo_agent_capability_job', {
        _job_id: job.id,
        _reason: reason.trim(),
      });
      if (error) throw error;
      return data as { restored: number; deleted: number; snapshot_total: number };
    },
    onSuccess: (r) => {
      const total = (r?.restored ?? 0) + (r?.deleted ?? 0);
      toast.success(`Undone — restored ${total.toLocaleString()} row${total === 1 ? '' : 's'}`);
      setConfirmId(null);
      setReason('');
      q.refetch();
    },
    onError: (e: any) => toast.error(e?.message ?? 'Undo failed'),
  });

  if (!job || remainingMs <= 0) return null;

  const mins = Math.floor(remainingMs / 60_000);
  const secs = Math.floor((remainingMs % 60_000) / 1000);
  const verb = job.action === 'enable' ? 'turned ON' : 'turned OFF';
  const capCount = job.capabilities?.length ?? 0;
  const isConfirming = confirmId === job.id;

  return (
    <Card className="p-3 border-2 border-amber-400 bg-amber-50">
      <div className="flex items-start gap-2">
        <div className="h-9 w-9 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
          <Undo2 className="h-4 w-4 text-amber-700" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-amber-900">
            You can undo your last change
          </p>
          <p className="text-xs text-amber-800 leading-snug">
            {verb} <strong>{capCount}</strong> function{capCount === 1 ? '' : 's'} on{' '}
            <strong>{(job.affected_total ?? job.total_agents).toLocaleString()}</strong> agent{(job.affected_total ?? job.total_agents) === 1 ? '' : 's'}.
            Reverts each agent to exactly what it was before.
          </p>
          <p className="text-[10px] text-amber-700 mt-0.5 font-mono">
            Undo expires in {mins}:{String(secs).padStart(2, '0')}
          </p>
        </div>
        {!isConfirming && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 border-amber-500 text-amber-900 hover:bg-amber-100"
            onClick={() => {
              setConfirmId(job.id);
              setReason(`Undo of bulk job — reverting ${verb} ${capCount} function(s)`);
            }}
          >
            <Undo2 className="h-3 w-3 mr-1" /> Undo
          </Button>
        )}
      </div>

      {isConfirming && (
        <div className="mt-3 pt-3 border-t border-amber-300 space-y-2">
          <p className="text-xs text-amber-900 font-semibold">
            Type a short reason to confirm the undo:
          </p>
          <Textarea
            rows={2}
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. Wrong agent set picked, restoring previous state"
            className="text-base sm:text-sm bg-background"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setConfirmId(null); setReason(''); }}
              disabled={undo.isPending}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => undo.mutate()}
              disabled={undo.isPending || reason.trim().length < 10}
              className="flex-1 bg-amber-600 hover:bg-amber-700 text-white"
            >
              {undo.isPending
                ? 'Reversing…'
                : <><Undo2 className="h-3 w-3 mr-1" /> Confirm undo</>}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function SingleAgentForm({ onResolved }: { onResolved: (r: ResolvedSet) => void }) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Array<{ agent_id: string; full_name: string | null; phone: string | null; email?: string | null }>>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);

  const search = useMutation({
    mutationFn: async () => {
      const term = query.trim();
      if (term.length < 3) throw new Error('Type at least 3 characters');
      // Reuses the existing identifier resolver — accepts agent ID, phone, or email.
      const { data, error } = await supabase.rpc('ops_resolve_agents_by_identifier', { _items: [term] });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (d) => {
      const matched = (d?.matched ?? []) as Array<any>;
      const um = (d?.unmatched ?? []) as string[];
      setMatches(matched);
      setUnmatched(um);
      if (matched.length === 0) {
        toast.error('No agent matched that identifier');
      } else if (matched.length === 1) {
        // Auto-stage the single hit so the manager can go straight to step 2.
        pick(matched[0]);
      } else {
        toast.message(`${matched.length} matches — pick one to continue`);
      }
    },
    onError: (e: any) => toast.error(e?.message ?? 'Search failed'),
  });

  const pick = (a: { agent_id: string; full_name: string | null; phone: string | null }) => {
    onResolved({
      source: 'csv', // routed through the same identifier-based pipeline
      agentIds: [a.agent_id],
      count: 1,
      sample: [{
        agent_id: a.agent_id,
        full_name: a.full_name,
        phone: a.phone,
        tier: null,
        is_frozen: false,
        last_active_at: null,
      }],
      unmatched: [],
    });
    toast.success(`Selected ${a.full_name ?? a.phone ?? a.agent_id.slice(0, 8)}`);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Look up one agent by their <strong>agent ID</strong>, <strong>phone</strong>, or <strong>email</strong> and apply a function change to just that agent — same audit trail and reason requirements as a bulk job.
      </p>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); search.mutate(); } }}
            placeholder="+256700123456, agent@example.com, or UUID…"
            className="pl-8"
            autoFocus
          />
        </div>
        <Button onClick={() => search.mutate()} disabled={search.isPending || query.trim().length < 3}>
          {search.isPending ? 'Searching…' : 'Find agent'}
        </Button>
      </div>

      {matches.length > 1 && (
        <Card className="p-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {matches.length} matches — pick one
          </p>
          <div className="max-h-56 overflow-y-auto divide-y">
            {matches.map(m => (
              <button
                key={m.agent_id}
                type="button"
                onClick={() => pick(m)}
                className="w-full flex items-center gap-2 py-2 px-1 text-left hover:bg-muted/50 rounded"
              >
                <User className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate">{m.full_name ?? '(no name)'}</p>
                  <p className="text-[10px] text-muted-foreground truncate font-mono">
                    {m.phone ?? '—'}{m.email ? ` · ${m.email}` : ''} · {m.agent_id.slice(0, 8)}…
                  </p>
                </div>
                <span className="text-[10px] text-primary font-semibold shrink-0">Select →</span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {unmatched.length > 0 && matches.length === 0 && (
        <p className="text-xs text-destructive">
          No agent found for "{unmatched[0]}". Check the spelling or try a different identifier.
        </p>
      )}
    </div>
  );
}

/* =====================================================================
 * Dead Letter Queue panel — terminally failed batches (after 5 retries)
 * ===================================================================*/
interface DeadLetterRow {
  id: number;
  job_id: string;
  batch_id: number;
  capability: string;
  action: 'enable' | 'disable';
  agent_ids: string[];
  attempt_count: number;
  last_error: string | null;
  reason: string;
  created_at: string;
}

function DeadLetterPanel() {
  const { data: rows = [], refetch } = useQuery<DeadLetterRow[]>({
    queryKey: ['agent-capability-dead-letters'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_capability_ops_dead_letters')
        .select('id,job_id,batch_id,capability,action,agent_ids,attempt_count,last_error,reason,created_at')
        .is('resolved_at', null)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as DeadLetterRow[];
    },
    refetchInterval: 15_000,
  });

  useEffect(() => {
    const ch = supabase
      .channel('agent-capability-dead-letters-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_capability_ops_dead_letters' },
        () => refetch())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [refetch]);

  if (rows.length === 0) return null;

  const requeue = async (id: number) => {
    const { error } = await supabase.rpc('requeue_dead_letter_batch', { _dead_letter_id: id });
    if (error) toast.error(error.message);
    else toast.success('Re-queued for one more attempt');
    refetch();
  };

  const archive = async (id: number) => {
    const { error } = await supabase.rpc('archive_dead_letter_batch', { _dead_letter_id: id });
    if (error) toast.error(error.message);
    else toast.success('Archived');
    refetch();
  };

  return (
    <Card className="p-3 border-destructive/40 bg-destructive/5">
      <div className="flex items-center gap-2 mb-2">
        <ShieldAlert className="h-4 w-4 text-destructive" />
        <p className="text-xs font-semibold uppercase tracking-wider text-destructive">
          Dead-letter queue · {rows.length} batch{rows.length === 1 ? '' : 'es'} need attention
        </p>
      </div>
      <p className="text-[10px] text-muted-foreground mb-2">
        These chunks failed after 5 retries with exponential backoff. Re-queue to give them one more cycle, or archive to give up.
      </p>
      <div className="space-y-2">
        {rows.map(r => (
          <div key={r.id} className="p-2 rounded border bg-background">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-[9px] capitalize">{r.action}</Badge>
              <span className="text-xs font-semibold">{r.capability}</span>
              <span className="text-xs text-muted-foreground">· {r.agent_ids.length.toLocaleString()} agents · {r.attempt_count} attempts</span>
              <div className="flex-1" />
              <Button size="sm" variant="outline" onClick={() => requeue(r.id)}>Re-queue</Button>
              <Button size="sm" variant="ghost" onClick={() => archive(r.id)}>Archive</Button>
            </div>
            {r.last_error && (
              <p className="text-[10px] text-destructive font-mono mt-1 truncate" title={r.last_error}>
                {r.last_error}
              </p>
            )}
            <p className="text-[10px] text-muted-foreground mt-1 truncate" title={r.reason}>
              {r.reason}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* =====================================================================
 * Recent jobs panel — live progress for in-flight bulk jobs
 * ===================================================================*/
interface JobRow {
  id: string;
  action: 'enable' | 'disable';
  capabilities: string[];
  total_agents: number;
  total_batches: number;
  batches_done: number;
  affected_total: number;
  failed_total: number;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  source: string;
  reason: string;
  last_error: string | null;
  created_at: string;
  finished_at: string | null;
}

function RecentJobsPanel({ highlightJobId }: { highlightJobId: string | null }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Auto-expand the highlighted (just-enqueued) job
  useEffect(() => {
    if (highlightJobId) {
      setExpanded(prev => prev.has(highlightJobId) ? prev : new Set(prev).add(highlightJobId));
    }
  }, [highlightJobId]);

  const { data: jobs = [], refetch } = useQuery<JobRow[]>({
    queryKey: ['agent-capability-ops-jobs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_capability_ops_jobs')
        .select('id,action,capabilities,total_agents,total_batches,batches_done,affected_total,failed_total,status,source,reason,last_error,created_at,finished_at')
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as JobRow[];
    },
    refetchInterval: (q) => {
      const rows = (q.state.data ?? []) as JobRow[];
      return rows.some(j => j.status === 'queued' || j.status === 'running') ? 2_000 : 15_000;
    },
  });

  // Realtime nudge so other ops sessions see fresh state instantly
  useEffect(() => {
    const ch = supabase
      .channel('agent-capability-ops-jobs-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_capability_ops_jobs' },
        () => refetch())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [refetch]);

  if (jobs.length === 0) return null;

  const cancel = async (id: string) => {
    const { error } = await supabase.rpc('cancel_agent_capability_job', { _job_id: id });
    if (error) toast.error(error.message);
    else toast.success('Job cancelled');
    refetch();
  };

  return (
    <Card className="p-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
        Recent bulk jobs
      </p>
      <div className="space-y-2">
        {jobs.map(j => {
          const pct = j.total_batches === 0 ? 0 : Math.round((j.batches_done / j.total_batches) * 100);
          const isActive = j.status === 'queued' || j.status === 'running';
          const isOpen = expanded.has(j.id);
          return (
            <div
              key={j.id}
              className={`p-2 rounded border ${j.id === highlightJobId ? 'border-primary bg-primary/5' : ''}`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => toggle(j.id)}
                  className="flex items-center text-muted-foreground hover:text-foreground"
                  aria-label={isOpen ? 'Collapse details' : 'Expand details'}
                >
                  {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </button>
                {j.status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
                {j.status === 'done' && <CheckCircle2 className="h-3 w-3 text-emerald-600" />}
                {j.status === 'failed' && <XCircle className="h-3 w-3 text-destructive" />}
                {j.status === 'cancelled' && <XCircle className="h-3 w-3 text-muted-foreground" />}
                {j.status === 'queued' && <Loader2 className="h-3 w-3 text-muted-foreground" />}
                <Badge variant="outline" className="capitalize text-[9px]">{j.action}</Badge>
                <span className="text-xs font-semibold">
                  {j.capabilities.length} function{j.capabilities.length === 1 ? '' : 's'} · {j.total_agents.toLocaleString()} agents
                </span>
                <span className="text-[10px] text-muted-foreground">{j.source}</span>
                <div className="flex-1" />
                <span className="text-xs tabular-nums">{j.batches_done}/{j.total_batches} batches · {j.affected_total.toLocaleString()} applied</span>
                {isActive && (
                  <Button size="sm" variant="ghost" onClick={() => cancel(j.id)}>Cancel</Button>
                )}
              </div>
              <Progress value={pct} className="h-1 mt-1" />
              <p className="text-[10px] text-muted-foreground mt-1 truncate" title={j.reason}>
                {j.reason}
                {j.failed_total > 0 && (
                  <span className="text-destructive"> · {j.failed_total} failed batch{j.failed_total === 1 ? '' : 'es'}</span>
                )}
                {j.last_error && j.status === 'failed' && (
                  <span className="text-destructive"> · {j.last_error.slice(0, 80)}</span>
                )}
              </p>
              {isOpen && <BatchTimeline jobId={j.id} jobActive={isActive} />}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ===================================================================
 * BatchTimeline — live per-batch status + error breakdown
 * ===================================================================*/
interface BatchRow {
  id: number;
  batch_index: number;
  capability: string;
  agent_count: number;
  affected: number;
  attempt_count: number;
  max_attempts: number;
  status: string;
  claimed_at: string | null;
  finished_at: string | null;
  next_attempt_at: string | null;
  dead_lettered_at: string | null;
  last_error: string | null;
  error: string | null;
}

function BatchTimeline({ jobId, jobActive }: { jobId: string; jobActive: boolean }) {
  type StatusFilter = 'all' | 'pending' | 'running' | 'done' | 'failed' | 'dead_letter' | 'retry';
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [groupByError, setGroupByError] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) => setExpandedGroups(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const { data: batches = [], refetch, isLoading } = useQuery<BatchRow[]>({
    queryKey: ['agent-capability-ops-job-batches', jobId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_capability_ops_job_batches')
        .select('id,batch_index,capability,agent_count,affected,attempt_count,max_attempts,status,claimed_at,finished_at,next_attempt_at,dead_lettered_at,last_error,error')
        .eq('job_id', jobId)
        .order('batch_index', { ascending: true })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as BatchRow[];
    },
    refetchInterval: jobActive ? 2_000 : false,
  });

  // No Realtime listener: agent_capability_ops_job_batches is not in the
  // publication, so it never fired. refetchInterval (2s while the job is
  // active) covers batch progress (doc 147).

  // Aggregate error breakdown — group by normalized message
  const errorGroups = useMemo(() => {
    const map = new Map<string, { count: number; sample: BatchRow }>();
    for (const b of batches) {
      const msg = (b.last_error || b.error || '').trim();
      if (!msg) continue;
      const key = msg.slice(0, 120);
      const cur = map.get(key);
      if (cur) cur.count += 1;
      else map.set(key, { count: 1, sample: b });
    }
    return Array.from(map.entries())
      .map(([msg, v]) => ({ msg, count: v.count, sample: v.sample }))
      .sort((a, b) => b.count - a.count);
  }, [batches]);

  const counts = useMemo(() => {
    const c = { pending: 0, running: 0, done: 0, failed: 0, dead_letter: 0, retry: 0 };
    for (const b of batches) {
      if (b.status === 'pending') c.pending++;
      else if (b.status === 'running' || b.status === 'claimed') c.running++;
      else if (b.status === 'done' || b.status === 'completed') c.done++;
      else if (b.status === 'dead_letter' || b.status === 'dead-lettered' || b.dead_lettered_at) c.dead_letter++;
      else if (b.status === 'failed') c.failed++;
      if (b.next_attempt_at && (b.status === 'pending' || b.status === 'failed') && b.attempt_count > 0) c.retry++;
    }
    return c;
  }, [batches]);

  // Classify a batch into the same buckets as the counters
  const classify = (b: BatchRow): Exclude<StatusFilter, 'all'> | 'other' => {
    const isDead = b.status === 'dead_letter' || b.status === 'dead-lettered' || !!b.dead_lettered_at;
    if (isDead) return 'dead_letter';
    if (b.status === 'done' || b.status === 'completed') return 'done';
    if (b.status === 'running' || b.status === 'claimed') return 'running';
    if (b.status === 'failed') return 'failed';
    if (b.status === 'pending') return 'pending';
    return 'other';
  };
  const isRetryQueued = (b: BatchRow) =>
    !!b.next_attempt_at && (b.status === 'pending' || b.status === 'failed') && b.attempt_count > 0;

  const filteredBatches = useMemo(() => {
    if (statusFilter === 'all') return batches;
    if (statusFilter === 'retry') return batches.filter(isRetryQueued);
    return batches.filter(b => classify(b) === statusFilter);
  }, [batches, statusFilter]);

  // Per-error groups built from the *filtered* batches (so filter + grouping compose)
  const errorGroupsFiltered = useMemo(() => {
    const map = new Map<string, { count: number; batches: BatchRow[] }>();
    for (const b of filteredBatches) {
      const msg = (b.last_error || b.error || '').trim();
      if (!msg) continue;
      const key = msg.slice(0, 200);
      const cur = map.get(key);
      if (cur) { cur.count += 1; cur.batches.push(b); }
      else map.set(key, { count: 1, batches: [b] });
    }
    return Array.from(map.entries())
      .map(([msg, v]) => ({ msg, count: v.count, batches: v.batches }))
      .sort((a, b) => b.count - a.count);
  }, [filteredBatches]);

  if (isLoading) {
    return (
      <div className="mt-2 pl-5 text-[10px] text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading batch timeline…
      </div>
    );
  }

  if (batches.length === 0) {
    return (
      <div className="mt-2 pl-5 text-[10px] text-muted-foreground">No batches yet.</div>
    );
  }

  const FilterChip = ({
    value, label, count, tone,
  }: { value: StatusFilter; label: string; count: number; tone?: string }) => {
    const active = statusFilter === value;
    return (
      <button
        type="button"
        onClick={() => setStatusFilter(active ? 'all' : value)}
        disabled={count === 0 && value !== 'all'}
        className={`px-1.5 py-0.5 rounded border font-mono text-[10px] transition ${
          active ? 'bg-primary text-primary-foreground border-primary' :
          count === 0 && value !== 'all' ? 'opacity-40 cursor-not-allowed border-muted' :
          tone || 'border-border hover:bg-muted'
        }`}
      >
        {label} {count}
      </button>
    );
  };

  return (
    <div className="mt-2 pl-5 border-l-2 border-muted ml-1 space-y-2">
      {/* Filterable counters */}
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <FilterChip value="all"         label="all"          count={batches.length} />
        <FilterChip value="pending"     label="pending"      count={counts.pending} />
        <FilterChip value="running"     label="running"      count={counts.running} tone="text-primary border-primary/40 hover:bg-primary/10" />
        <FilterChip value="done"        label="done"         count={counts.done} tone="text-emerald-700 border-emerald-300 hover:bg-emerald-50" />
        <FilterChip value="retry"       label="retry queued" count={counts.retry} tone="text-amber-700 border-amber-300 hover:bg-amber-50" />
        <FilterChip value="failed"      label="failed"       count={counts.failed} tone="text-destructive border-destructive/40 hover:bg-destructive/10" />
        <FilterChip value="dead_letter" label="dead-letter"  count={counts.dead_letter} tone="text-destructive bg-destructive/10 border-destructive/50 hover:bg-destructive/20" />
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setGroupByError(g => !g)}
          className={`px-1.5 py-0.5 rounded border text-[10px] flex items-center gap-1 transition ${
            groupByError ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'
          }`}
          title="Group identical errors together"
        >
          <Layers className="h-3 w-3" /> Group by error
        </button>
        {(statusFilter !== 'all' || groupByError) && (
          <button
            type="button"
            onClick={() => { setStatusFilter('all'); setGroupByError(false); }}
            className="text-[10px] text-muted-foreground underline"
          >
            Reset
          </button>
        )}
      </div>

      {/* Error breakdown — top-5 summary, hidden when group-by-error mode is on */}
      {!groupByError && errorGroups.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <AlertCircle className="h-3 w-3 text-destructive" /> Error breakdown
          </p>
          {errorGroups.slice(0, 5).map((g) => (
            <button
              type="button"
              key={g.msg}
              onClick={() => { setGroupByError(true); setExpandedGroups(new Set([g.msg.slice(0, 200)])); }}
              className="w-full text-left text-[10px] p-1.5 rounded bg-destructive/5 border border-destructive/20 hover:bg-destructive/10"
            >
              <div className="flex items-center gap-2">
                <Badge variant="destructive" className="text-[9px]">×{g.count}</Badge>
                <span className="text-muted-foreground">batch #{g.sample.batch_index} · {g.sample.capability} · attempt {g.sample.attempt_count}/{g.sample.max_attempts}</span>
              </div>
              <p className="mt-0.5 text-destructive font-mono break-all" title={g.msg}>{g.msg}</p>
            </button>
          ))}
          {errorGroups.length > 5 && (
            <p className="text-[10px] text-muted-foreground">+{errorGroups.length - 5} more distinct errors</p>
          )}
        </div>
      )}

      {/* Body: either per-batch timeline or grouped-by-error view */}
      {groupByError ? (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
            <AlertCircle className="h-3 w-3 text-destructive" />
            Errors ({errorGroupsFiltered.length}) · {filteredBatches.length} batch{filteredBatches.length === 1 ? '' : 'es'}
          </p>
          {errorGroupsFiltered.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">
              No errored batches{statusFilter !== 'all' ? ` in "${statusFilter.replace(/_/g, ' ')}" filter` : ''}.
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
              {errorGroupsFiltered.map(g => {
                const key = g.msg.slice(0, 200);
                const open = expandedGroups.has(key);
                return (
                  <div key={key} className="rounded border border-destructive/20 bg-destructive/5">
                    <button
                      type="button"
                      onClick={() => toggleGroup(key)}
                      className="w-full text-left p-1.5 flex items-start gap-2"
                    >
                      {open ? <ChevronDown className="h-3 w-3 mt-0.5 shrink-0" /> : <ChevronRight className="h-3 w-3 mt-0.5 shrink-0" />}
                      <Badge variant="destructive" className="text-[9px] shrink-0">×{g.count}</Badge>
                      <p className="flex-1 text-[10px] text-destructive font-mono break-all">{g.msg}</p>
                    </button>
                    {open && (
                      <div className="border-t border-destructive/20 p-1.5 space-y-0.5">
                        {g.batches.map(b => {
                          const isDead = classify(b) === 'dead_letter';
                          return (
                            <div key={b.id} className="flex items-center gap-2 text-[10px]">
                              <span className={`h-2 w-2 rounded-full shrink-0 ${isDead ? 'bg-destructive' : 'bg-amber-500'}`} />
                              <span className="font-mono text-muted-foreground w-10 shrink-0">#{b.batch_index}</span>
                              <span className="truncate flex-1" title={b.capability}>{b.capability}</span>
                              <span className="text-muted-foreground shrink-0">try {b.attempt_count}/{b.max_attempts}</span>
                              <span className="capitalize text-muted-foreground shrink-0">{(b.status || '').replace(/_/g, ' ')}</span>
                              {b.next_attempt_at && !isDead && (
                                <span className="text-amber-700 shrink-0" title={b.next_attempt_at}>
                                  retry {new Date(b.next_attempt_at).toLocaleTimeString()}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
          <Clock className="h-3 w-3" />
          Batches ({filteredBatches.length}{statusFilter !== 'all' ? ` of ${batches.length}` : ''})
        </p>
        {filteredBatches.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">No batches match this filter.</p>
        ) : (
        <div className="max-h-64 overflow-y-auto space-y-0.5 pr-1">
          {filteredBatches.map(b => {
            const isDead = b.status === 'dead_letter' || b.status === 'dead-lettered' || !!b.dead_lettered_at;
            const isDone = b.status === 'done' || b.status === 'completed';
            const isRunning = b.status === 'running' || b.status === 'claimed';
            const isFailed = b.status === 'failed' && !isDead;
            const dotClass =
              isDead ? 'bg-destructive' :
              isDone ? 'bg-emerald-500' :
              isRunning ? 'bg-primary animate-pulse' :
              isFailed ? 'bg-amber-500' :
              'bg-muted-foreground/40';
            const ts = b.finished_at || b.claimed_at;
            return (
              <div key={b.id} className="flex items-start gap-2 text-[10px] py-0.5">
                <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${dotClass}`} />
                <span className="font-mono text-muted-foreground w-10 shrink-0">#{b.batch_index}</span>
                <span className="w-32 truncate shrink-0" title={b.capability}>{b.capability}</span>
                <span className="tabular-nums w-20 shrink-0">{b.affected}/{b.agent_count}</span>
                <span className="capitalize w-16 shrink-0">{(b.status || '').replace(/_/g, ' ')}</span>
                {b.attempt_count > 0 && (
                  <span className="text-muted-foreground shrink-0">try {b.attempt_count}/{b.max_attempts}</span>
                )}
                {b.next_attempt_at && !isDone && !isDead && (
                  <span className="text-amber-700 shrink-0" title={b.next_attempt_at}>
                    retry {new Date(b.next_attempt_at).toLocaleTimeString()}
                  </span>
                )}
                <span className="flex-1" />
                {ts && (
                  <span className="text-muted-foreground tabular-nums shrink-0" title={ts}>
                    {new Date(ts).toLocaleTimeString()}
                  </span>
                )}
                {(b.last_error || b.error) && (
                  <span className="text-destructive truncate max-w-[40%]" title={b.last_error || b.error || ''}>
                    {(b.last_error || b.error || '').slice(0, 60)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        )}
      </div>
      )}
    </div>
  );
}