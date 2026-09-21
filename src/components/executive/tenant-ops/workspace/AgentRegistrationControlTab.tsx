import { useState } from 'react';
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
import { Loader2, ShieldAlert, ShieldCheck, Settings2, History } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useAgentRegistrationControl,
  useGrantRegistrationOverride,
  useRevokeRegistrationOverride,
  useSaveRegistrationControlRules,
  type RegistrationControlRow,
  type RegistrationControlRules,
} from '@/hooks/useAgentRegistrationControl';
import RegistrationRuleGroupsDialog from './RegistrationRuleGroupsDialog';

type StatusFilter = 'all' | 'blocked' | 'restricted' | 'overridden' | 'clear';

export default function AgentRegistrationControlTab() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const { data, isLoading, error } = useAgentRegistrationControl({ search, status });

  const [overrideFor, setOverrideFor] = useState<RegistrationControlRow | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideDays, setOverrideDays] = useState('30');
  const grant = useGrantRegistrationOverride();
  const revoke = useRevokeRegistrationOverride();

  const [rulesOpen, setRulesOpen] = useState(false);
  const [minTenants, setMinTenants] = useState('');
  const [requiredPct, setRequiredPct] = useState('');
  const saveRules = useSaveRegistrationControlRules();

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

  const submitRules = async () => {
    try {
      await saveRules.mutateAsync({
        min_active_tenants: Math.max(Number(minTenants) || 20, 1),
        required_prev_month_pct: Number(requiredPct) || 80,
      });
      toast.success('Rules updated');
      setRulesOpen(false);
    } catch (e) {
      toast.error('Could not save the rules', { description: e instanceof Error ? e.message : undefined });
    }
  };

  if (error) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          This report is only available to management and operations users.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Agent registration control</CardTitle>
            <CardDescription>
              {rules
                ? `An agent carrying ${rules.min_active_tenants} or more active tenants must have collected at least ${rules.required_prev_month_pct}% of last month's dues to keep registering new tenants.`
                : 'Loading the approved rules…'}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setMinTenants(String(rules?.min_active_tenants ?? 20));
              setRequiredPct(String(rules?.required_prev_month_pct ?? 80));
              setRulesOpen(true);
            }}
          >
            <Settings2 className="mr-2 h-4 w-4" />
            Rules
          </Button>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 md:grid-cols-5">
          {[
            { label: 'Agents reviewed', value: totals?.agents ?? 0 },
            { label: `At ${rules?.min_active_tenants ?? 20}+ tenants`, value: totals?.at_threshold ?? 0 },
            { label: 'Below required level', value: totals?.restricted ?? 0 },
            { label: 'Blocked now', value: totals?.blocked ?? 0 },
            { label: 'Allowed by override', value: totals?.overridden ?? 0 },
          ].map((t) => (
            <div key={t.label} className="rounded-xl border bg-muted/30 p-3">
              <div className="text-2xl font-semibold">{isLoading ? '—' : t.value}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t.label}</div>
            </div>
          ))}
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
        <CardContent className="overflow-x-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading agents…
            </div>
          ) : (
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
                      <div className="text-xs text-muted-foreground">{row.phone ?? '—'}</div>
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
        <CardContent className="overflow-x-auto">
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
        </CardContent>
      </Card>

      <Dialog open={!!overrideFor} onOpenChange={(o) => !o && setOverrideFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Allow {overrideFor?.full_name ?? 'this agent'} to register</DialogTitle>
            <DialogDescription>
              {overrideFor
                ? `${overrideFor.active_tenants} active tenants and ${overrideFor.prev_pct ?? 0}% collected last month, against the required ${rules?.required_prev_month_pct ?? 80}%.`
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

      <Dialog open={rulesOpen} onOpenChange={setRulesOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registration control rules</DialogTitle>
            <DialogDescription>These approved figures drive the restriction everywhere.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="rule-min">Restriction starts at this many active tenants</Label>
              <Input
                id="rule-min"
                type="number"
                min={1}
                value={minTenants}
                onChange={(e) => setMinTenants(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="rule-pct">Required previous month performance (%)</Label>
              <Input
                id="rule-pct"
                type="number"
                min={0}
                max={100}
                value={requiredPct}
                onChange={(e) => setRequiredPct(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRulesOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitRules} disabled={saveRules.isPending}>
              {saveRules.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save rules
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
