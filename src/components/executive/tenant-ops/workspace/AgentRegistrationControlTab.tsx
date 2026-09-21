import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Settings2,
  History,
  Users,
  ListChecks,
  TrendingDown,
  Lock,
  FileDown,
  FileSpreadsheet,
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { formatUGX } from '@/lib/rentCalculations';
import { useAuth } from '@/hooks/useAuth';
import {
  useAgentRegistrationControl,
  useGrantRegistrationOverride,
  useRevokeRegistrationOverride,
  useSaveRegistrationControlRules,
  type RegistrationControlRow,
  type RegistrationControlRules,
} from '@/hooks/useAgentRegistrationControl';
import RegistrationRuleGroupsDialog from './RegistrationRuleGroupsDialog';
import { KPICard } from '@/components/executive/KPICard';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';
import { WorkspaceMobileRow } from './WorkspaceMobileRow';
import {
  generateRegistrationControlPdf,
  exportRegistrationControlXlsx,
} from '@/lib/tenantOpsRegistrationControlReport';

type StatusFilter = 'all' | 'blocked' | 'restricted' | 'overridden' | 'clear';

export default function AgentRegistrationControlTab() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const { data, isLoading, error } = useAgentRegistrationControl({ search, status });

  const [overrideFor, setOverrideFor] = useState<RegistrationControlRow | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideDays, setOverrideDays] = useState('30');
  const grant = useGrantRegistrationOverride();
  const revoke = useRevokeRegistrationOverride();

  const [rulesOpen, setRulesOpen] = useState(false);
  const saveRules = useSaveRegistrationControlRules();

  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [generatingXlsx, setGeneratingXlsx] = useState(false);

  const rules = data?.rules;
  const totals = data?.totals;

  const submitOverride = async () => {
    if (!overrideFor) return;
    try {
      await grant.mutateAsync({
        agentId: overrideFor.agent_id,
        reason: overrideReason.trim(),
        days: Math.max(Number(overrideDays) || 30, 1),
      });
      toast.success('Override recorded', {
        description: `${overrideFor.full_name ?? 'This agent'} can register tenants again.`,
      });
      setOverrideFor(null);
      setOverrideReason('');
    } catch (e) {
      toast.error('Could not record the override', {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  const withdrawOverride = async (row: RegistrationControlRow) => {
    if (!row.override_id) return;
    const reason = window.prompt('Why are you withdrawing this override? (at least 10 characters)')?.trim();
    if (!reason) return;
    try {
      await revoke.mutateAsync({ overrideId: row.override_id, reason });
      toast.success('Override withdrawn');
    } catch (e) {
      toast.error('Could not withdraw the override', {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  const submitRules = async (next: Partial<RegistrationControlRules>) => {
    try {
      await saveRules.mutateAsync(next);
      toast.success('Rules updated');
      setRulesOpen(false);
    } catch (e) {
      toast.error('Could not save the rules', { description: e instanceof Error ? e.message : undefined });
    }
  };

  const ruleSummary = () => {
    if (!rules) return 'Loading the approved rules…';
    if (rules.enabled === false) return 'The restriction is switched off — no agent is being stopped.';
    const active = (rules.groups ?? []).filter((g) => g.active);
    if (active.length === 0) return 'No rules are active — no agent is being stopped.';
    return active
      .map((g) => {
        const band = g.max_active_tenants
          ? `${g.min_active_tenants}–${g.max_active_tenants} tenants`
          : `${g.min_active_tenants}+ tenants`;
        const who =
          [
            g.regions?.length ? g.regions.join(', ') : null,
            g.districts?.length ? g.districts.join(', ') : null,
            g.tiers?.length ? g.tiers.join(', ') : null,
            g.agent_ids?.length ? `${g.agent_ids.length} named agent(s)` : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'all agents';
        return `${g.label}: ${who} on ${band} must have collected ${g.required_prev_month_pct}% of last month's dues.`;
      })
      .join(' ');
  };

  // Client-side classification of the already-fetched rows into the same
  // three states the Status badge renders — no new query.
  const statusData = useMemo(() => {
    const rows = data?.rows ?? [];
    let blocked = 0;
    let overridden = 0;
    let clear = 0;
    rows.forEach((row) => {
      if (row.blocked) blocked += 1;
      else if (row.restricted && row.override_id) overridden += 1;
      else clear += 1;
    });
    return [
      { name: 'Blocked', count: blocked, color: 'hsl(var(--destructive))' },
      { name: 'Overridden', count: overridden, color: 'hsl(var(--warning))' },
      { name: 'Clear', count: clear, color: 'hsl(var(--success))' },
    ];
  }, [data?.rows]);

  const handleGeneratePdf = async () => {
    setGeneratingPdf(true);
    const t = toast.loading('Generating the professional PDF…');
    try {
      await generateRegistrationControlPdf(data?.rows ?? [], data?.overrides ?? [], {
        generatedByUserId: user?.id,
      });
      toast.success('PDF ready', { id: t, description: 'Saved to your device and the offline vault.' });
    } catch (e) {
      toast.error('Could not generate the PDF', { id: t, description: e instanceof Error ? e.message : undefined });
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleExportXlsx = async () => {
    setGeneratingXlsx(true);
    const t = toast.loading('Building the Excel workbook…');
    try {
      await exportRegistrationControlXlsx(data?.rows ?? [], data?.overrides ?? []);
      toast.success('Excel file ready', { id: t });
    } catch (e) {
      toast.error('Could not export to Excel', { id: t, description: e instanceof Error ? e.message : undefined });
    } finally {
      setGeneratingXlsx(false);
    }
  };

  if (error) {
    return (
      <Card>
        <CardContent className="py-10">
          <WorkspaceEmptyState
            icon={Lock}
            title="Management access required"
            hint="This report is only available to management and operations users."
            tone="destructive"
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col items-start justify-between gap-4 sm:flex-row">
          <div>
            <CardTitle className="text-base">Agent registration control</CardTitle>
            <CardDescription>{ruleSummary()}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleGeneratePdf} disabled={generatingPdf}>
              {generatingPdf ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileDown className="mr-2 h-4 w-4" />
              )}
              Professional PDF
            </Button>
            <Button variant="outline" size="sm" onClick={handleExportXlsx} disabled={generatingXlsx}>
              {generatingXlsx ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileSpreadsheet className="mr-2 h-4 w-4" />
              )}
              Export Excel
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRulesOpen(true)}>
              <Settings2 className="mr-2 h-4 w-4" />
              Rules
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-5">
          <KPICard
            title="Agents reviewed"
            value={totals?.agents ?? 0}
            icon={Users}
            color="bg-primary/10 text-primary"
            loading={isLoading}
          />
          <KPICard
            title="Covered by a rule"
            value={totals?.at_threshold ?? 0}
            icon={ListChecks}
            color="bg-muted text-muted-foreground"
            loading={isLoading}
          />
          <KPICard
            title="Below required level"
            value={totals?.restricted ?? 0}
            icon={TrendingDown}
            color="bg-warning/10 text-warning"
            loading={isLoading}
          />
          <KPICard
            title="Blocked now"
            value={totals?.blocked ?? 0}
            icon={ShieldAlert}
            color="bg-destructive/10 text-destructive"
            loading={isLoading}
          />
          <KPICard
            title="Allowed by override"
            value={totals?.overridden ?? 0}
            icon={ShieldCheck}
            color="bg-warning/10 text-warning"
            loading={isLoading}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agents by status</CardTitle>
          <CardDescription>How the currently loaded agents split across registration status.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} className="fill-muted-foreground" />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {statusData.map((d) => (
                    <Cell key={d.name} fill={d.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agents</CardTitle>
          <CardDescription>
            Previous month performance is last month's collections measured against what was due on their plans.
          </CardDescription>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder="Search agent name or phone"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="sm:max-w-xs"
            />
            <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
              <SelectTrigger className="sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                <SelectItem value="blocked">Blocked now</SelectItem>
                <SelectItem value="restricted">Below required level</SelectItem>
                <SelectItem value="overridden">Allowed by override</SelectItem>
                <SelectItem value="clear">No restriction</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading agents…
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto lg:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead className="text-right">Active tenants</TableHead>
                      <TableHead className="text-right">Last month due</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                      <TableHead className="text-right">Performance</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data?.rows ?? []).map((row) => (
                      <TableRow key={row.agent_id}>
                        <TableCell>
                          <div className="font-medium">{row.full_name ?? 'Unnamed agent'}</div>
                          <div className="text-xs text-muted-foreground">
                            {row.phone ?? '—'}
                            {row.district ? ` · ${row.district}` : ''}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {row.group_label
                              ? `${row.group_label} · needs ${row.group_required_pct}%`
                              : 'No rule applies'}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{row.active_tenants}</TableCell>
                        <TableCell className="text-right">{formatUGX(Number(row.prev_expected))}</TableCell>
                        <TableCell className="text-right">{formatUGX(Number(row.prev_collected))}</TableCell>
                        <TableCell className="text-right">
                          {row.prev_pct == null ? '—' : `${row.prev_pct}%`}
                        </TableCell>
                        <TableCell>
                          {row.blocked ? (
                            <Badge variant="destructive" className="gap-1">
                              <ShieldAlert className="h-3 w-3" /> Blocked
                            </Badge>
                          ) : row.restricted && row.override_id ? (
                            <Badge variant="secondary" className="gap-1">
                              <ShieldCheck className="h-3 w-3" /> Override active
                            </Badge>
                          ) : (
                            <Badge variant="outline">Can register</Badge>
                          )}
                          {row.restricted && row.override_id && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {row.override_by ?? 'Management'} ·{' '}
                              {row.override_at ? new Date(row.override_at).toLocaleDateString() : ''}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.blocked ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setOverrideFor(row);
                                setOverrideReason('');
                                setOverrideDays('30');
                              }}
                            >
                              Allow anyway
                            </Button>
                          ) : row.restricted && row.override_id ? (
                            <Button size="sm" variant="ghost" onClick={() => withdrawOverride(row)}>
                              Withdraw
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                    {(data?.rows ?? []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                          No agents match this view.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-2 lg:hidden">
                {(data?.rows ?? []).map((row) => {
                  const badge = row.blocked ? (
                    <Badge variant="destructive" className="gap-1">
                      <ShieldAlert className="h-3 w-3" /> Blocked
                    </Badge>
                  ) : row.restricted && row.override_id ? (
                    <Badge variant="secondary" className="gap-1">
                      <ShieldCheck className="h-3 w-3" /> Override active
                    </Badge>
                  ) : (
                    <Badge variant="outline">Can register</Badge>
                  );
                  return (
                    <WorkspaceMobileRow
                      key={row.agent_id}
                      title={row.full_name ?? 'Unnamed agent'}
                      badge={badge}
                      fields={[
                        { label: 'Active tenants', value: row.active_tenants },
                        { label: 'Last month due', value: formatUGX(Number(row.prev_expected)) },
                        { label: 'Collected', value: formatUGX(Number(row.prev_collected)) },
                        { label: 'Performance', value: row.prev_pct == null ? '—' : `${row.prev_pct}%` },
                      ]}
                      actions={
                        row.blocked ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            onClick={() => {
                              setOverrideFor(row);
                              setOverrideReason('');
                              setOverrideDays('30');
                            }}
                          >
                            Allow anyway
                          </Button>
                        ) : row.restricted && row.override_id ? (
                          <Button size="sm" variant="ghost" className="w-full" onClick={() => withdrawOverride(row)}>
                            Withdraw
                          </Button>
                        ) : undefined
                      }
                    />
                  );
                })}
                {(data?.rows ?? []).length === 0 && (
                  <WorkspaceEmptyState icon={Users} title="No agents match this view." tone="muted" />
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" /> Override record
          </CardTitle>
          <CardDescription>Every override kept on record with who approved it and why.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="hidden overflow-x-auto lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Approved by</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Was</TableHead>
                  <TableHead>Now</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.overrides ?? []).map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(o.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>{o.agent_name ?? o.agent_id}</TableCell>
                    <TableCell>{o.approved_by_name ?? o.approved_by}</TableCell>
                    <TableCell className="max-w-[18rem] text-xs">{o.reason}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {String((o.previous_state as { blocked?: unknown })?.blocked) === 'true'
                        ? 'Blocked from registering'
                        : 'Not blocked'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {o.revoked_at
                        ? `Withdrawn ${new Date(o.revoked_at).toLocaleDateString()}`
                        : o.active
                          ? `Allowed${o.expires_at ? ` until ${new Date(o.expires_at).toLocaleDateString()}` : ''}`
                          : 'Ended'}
                    </TableCell>
                  </TableRow>
                ))}
                {(data?.overrides ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                      No overrides recorded yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-2 lg:hidden">
            {(data?.overrides ?? []).map((o) => (
              <WorkspaceMobileRow
                key={o.id}
                title={o.agent_name ?? o.agent_id}
                fields={[
                  { label: 'When', value: new Date(o.created_at).toLocaleString() },
                  { label: 'Approved by', value: o.approved_by_name ?? o.approved_by },
                  { label: 'Reason', value: o.reason, full: true },
                  {
                    label: 'Was → Now',
                    value: `${
                      String((o.previous_state as { blocked?: unknown })?.blocked) === 'true'
                        ? 'Blocked from registering'
                        : 'Not blocked'
                    } → ${
                      o.revoked_at
                        ? `Withdrawn ${new Date(o.revoked_at).toLocaleDateString()}`
                        : o.active
                          ? `Allowed${o.expires_at ? ` until ${new Date(o.expires_at).toLocaleDateString()}` : ''}`
                          : 'Ended'
                    }`,
                    full: true,
                  },
                ]}
              />
            ))}
            {(data?.overrides ?? []).length === 0 && (
              <WorkspaceEmptyState icon={History} title="No overrides recorded yet." tone="muted" />
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!overrideFor} onOpenChange={(o) => !o && setOverrideFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Allow {overrideFor?.full_name ?? 'this agent'} to register</DialogTitle>
            <DialogDescription>
              {overrideFor
                ? `${overrideFor.active_tenants} active tenants and ${overrideFor.prev_pct ?? 0}% collected last month, against the ${overrideFor.group_required_pct ?? rules?.required_prev_month_pct ?? 0}% required by ${overrideFor.group_label ?? 'the active rule'}.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="ovr-reason">Reason (at least 10 characters)</Label>
              <Textarea
                id="ovr-reason"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Why this agent may continue registering tenants"
                rows={3}
              />
            </div>
            <div>
              <Label htmlFor="ovr-days">Valid for (days)</Label>
              <Input
                id="ovr-days"
                type="number"
                min={1}
                value={overrideDays}
                onChange={(e) => setOverrideDays(e.target.value)}
                className="max-w-[8rem]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOverrideFor(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitOverride}
              disabled={overrideReason.trim().length < 10 || grant.isPending}
            >
              {grant.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record override
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RegistrationRuleGroupsDialog
        open={rulesOpen}
        onOpenChange={setRulesOpen}
        rules={rules}
        options={data?.options}
        saving={saveRules.isPending}
        onSave={submitRules}
      />
    </div>
  );
}
