/**
 * Management quick actions for the Tenant Operations Workspace.
 *
 * Every action here opens an EXISTING workflow — nothing new is calculated or
 * written by this surface:
 *  - View tenant / View agent  → the shared ops drilldown drawer (`UserDrilldownDrawer`)
 *  - View payments            → the shared Calling Center payment history panel
 *  - View arrears             → the figures already supplied by the eligibility report
 *  - Transfer tenant / Change assignment → the authoritative
 *    `agent_ops_reassign_idle_tenant` RPC, which owns the tenant↔agent
 *    relationship, its validation, its audit row (`tenant_reassignment_audit`,
 *    recording actor and timestamp) and its system event.
 *
 * No second assignment system, no payment/rent/eligibility logic is touched.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2, MoreHorizontal, ArrowLeftRight, User, UserCheck, Receipt, AlertTriangle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useAuth } from '@/hooks/useAuth';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';
import { TenantPaymentHistoryPanel } from '@/components/executive/tenant-ops/calling-center/TenantPaymentHistoryPanel';
import type { ManagementTenantRow } from '@/hooks/useTenantOpsManagementOverview';

/** Mirrors the role list the reassignment RPC itself enforces. */
export function useCanReassignTenants(): boolean {
  const { user } = useAuth() as any;
  const { data } = useQuery({
    queryKey: ['tenant-ops-can-reassign', user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user!.id)
        .eq('enabled', true);
      const roles = (data ?? []).map((r: any) => r.role as string);
      return roles.some((r) => ['agent_ops', 'coo', 'manager', 'super_admin'].includes(r));
    },
  });
  return !!data;
}

type AgentOption = { id: string; name: string };

type Mode = null | 'payments' | 'arrears' | 'transfer';

export function TenantQuickActions({
  tenant,
  agentOptions,
  onChanged,
}: {
  tenant: ManagementTenantRow;
  agentOptions: AgentOption[];
  onChanged?: () => void;
}) {
  const qc = useQueryClient();
  const canReassign = useCanReassignTenants();
  const [mode, setMode] = useState<Mode>(null);
  const [drawer, setDrawer] = useState<null | 'tenant' | 'agent'>(null);
  const [newAgentId, setNewAgentId] = useState('');
  const [agentSearch, setAgentSearch] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);

  const choices = useMemo(
    () =>
      agentOptions
        .filter((a) => a.id !== tenant.agent_id)
        .filter((a) => a.name.toLowerCase().includes(agentSearch.trim().toLowerCase()))
        .slice(0, 60),
    [agentOptions, agentSearch, tenant.agent_id],
  );

  const reassign = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_reassign_idle_tenant', {
        p_rent_request_id: tenant.rent_request_id,
        p_new_agent_id: newAgentId,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success('Tenant moved to the new agent. The change has been recorded.');
      setMode(null);
      setConfirming(false);
      setNewAgentId('');
      setReason('');
      qc.invalidateQueries({ queryKey: ['tenant-topup-eligibility'] });
      qc.invalidateQueries({ queryKey: ['agent-registration-control'] });
      onChanged?.();
    },
    onError: (e: any) => {
      setConfirming(false);
      toast.error(e?.message || 'The transfer could not be completed.');
    },
  });

  const closeAll = () => {
    setMode(null);
    setConfirming(false);
  };

  const newAgentName = choices.find((a) => a.id === newAgentId)?.name
    ?? agentOptions.find((a) => a.id === newAgentId)?.name
    ?? '';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 px-2">
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-xs">{tenant.tenant_name ?? 'Tenant'}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => setDrawer('tenant')}>
            <User className="mr-2 h-4 w-4" /> View tenant
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setMode('payments')}>
            <Receipt className="mr-2 h-4 w-4" /> View payments
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setMode('arrears')}>
            <AlertTriangle className="mr-2 h-4 w-4" /> View arrears
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!tenant.agent_id} onClick={() => setDrawer('agent')}>
            <UserCheck className="mr-2 h-4 w-4" /> View agent
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canReassign} onClick={() => setMode('transfer')}>
            <ArrowLeftRight className="mr-2 h-4 w-4" /> Transfer tenant
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canReassign} onClick={() => setMode('transfer')}>
            <ArrowLeftRight className="mr-2 h-4 w-4" /> Change assignment
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {drawer && (
        <UserDrilldownDrawer
          open
          onOpenChange={(v) => !v && setDrawer(null)}
          tenantId={tenant.tenant_id}
          agentId={tenant.agent_id}
          defaultTab={drawer}
        />
      )}

      <Dialog open={mode === 'payments'} onOpenChange={(v) => !v && closeAll()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Payments — {tenant.tenant_name ?? 'Tenant'}</DialogTitle>
            <DialogDescription>
              Every receipt already recorded for this tenant, newest first.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            <TenantPaymentHistoryPanel tenantId={tenant.tenant_id} enabled={mode === 'payments'} />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={mode === 'arrears'} onOpenChange={(v) => !v && closeAll()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Arrears — {tenant.tenant_name ?? 'Tenant'}</DialogTitle>
            <DialogDescription>
              The same figures shown in the tenant position report.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {[
              ['Expected to date', tenant.expected_to_date == null ? '—' : formatUGX(tenant.expected_to_date)],
              ['Paid so far', formatUGX(Number(tenant.amount_repaid))],
              ['Behind by', tenant.arrears > 0 ? formatUGX(tenant.arrears) : 'Nothing behind'],
              ['Total for the plan', formatUGX(Number(tenant.total_amount))],
              ['Still to pay', formatUGX(Number(tenant.outstanding))],
              ['Daily amount', formatUGX(Number(tenant.daily_amount))],
            ].map(([label, value]) => (
              <div key={label as string} className="flex items-center justify-between rounded-lg border px-3 py-2">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">{value}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <Badge variant="outline">{tenant.agent_name ?? 'No agent'}</Badge>
              <Badge variant={tenant.arrears > 0 ? 'destructive' : 'secondary'}>
                {Math.round(tenant.pct_covered ?? 0)}% paid
              </Badge>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={mode === 'transfer'} onOpenChange={(v) => !v && closeAll()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Move {tenant.tenant_name ?? 'this tenant'} to another agent</DialogTitle>
            <DialogDescription>
              Currently with {tenant.agent_name ?? 'no agent'}. The new agent must have collected in
              the last three days. The change is recorded with your name, the time and your reason.
            </DialogDescription>
          </DialogHeader>

          {confirming ? (
            <Alert>
              <AlertDescription className="text-sm">
                Move <strong>{tenant.tenant_name ?? 'this tenant'}</strong> from{' '}
                <strong>{tenant.agent_name ?? 'no agent'}</strong> to <strong>{newAgentName}</strong>?
                This changes who collects from them.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">New agent</Label>
                <Input
                  placeholder="Search agent name"
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                />
                <Select value={newAgentId} onValueChange={setNewAgentId}>
                  <SelectTrigger><SelectValue placeholder="Choose an agent" /></SelectTrigger>
                  <SelectContent>
                    {choices.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Reason <span className="text-destructive">*</span></Label>
                <Textarea
                  rows={3}
                  placeholder="Why is this tenant being moved? (at least 10 characters)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            {confirming ? (
              <>
                <Button variant="outline" onClick={() => setConfirming(false)} disabled={reassign.isPending}>
                  Back
                </Button>
                <Button onClick={() => reassign.mutate()} disabled={reassign.isPending}>
                  {reassign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirm transfer
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={closeAll}>Cancel</Button>
                <Button
                  disabled={!newAgentId || reason.trim().length < 10}
                  onClick={() => setConfirming(true)}
                >
                  Continue
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AgentQuickActions({ agentId, agentName }: { agentId: string; agentName: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" className="h-8" onClick={() => setOpen(true)}>
        <UserCheck className="mr-1 h-4 w-4" /> View agent
      </Button>
      {open && (
        <UserDrilldownDrawer
          open
          onOpenChange={(v) => !v && setOpen(false)}
          agentId={agentId}
          defaultTab="agent"
        />
      )}
    </>
  );
}
