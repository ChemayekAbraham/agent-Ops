import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useCanEditAccess } from '@/hooks/useCanEditAccess';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Loader2, ShieldCheck, Compass, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type ForcedRole = 'tenant' | 'agent' | 'landlord' | 'supporter';
const DEFAULT_ROLE_OPTIONS: { value: ForcedRole; label: string; emoji: string }[] = [
  { value: 'tenant', label: 'Tenant', emoji: '🏠' },
  { value: 'agent', label: 'Agent', emoji: '💼' },
  { value: 'landlord', label: 'Landlord', emoji: '🏢' },
  { value: 'supporter', label: 'Funder', emoji: '💰' },
];

const DASHBOARDS = [
  { key: 'ceo', label: 'CEO Dashboard' },
  { key: 'cto', label: 'CTO Dashboard' },
  { key: 'cfo', label: 'CFO Dashboard' },
  { key: 'coo', label: 'COO Dashboard' },
  { key: 'cmo', label: 'CMO Dashboard' },
  { key: 'crm', label: 'CRM Dashboard' },
  { key: 'director', label: 'Director Dashboard' },
  { key: 'financial-ops', label: 'Financial Ops' },
  { key: 'company-ops', label: 'Company Staff' },
  { key: 'platform-users', label: 'Platform Users' },
  { key: 'agent-ops', label: 'Agent Ops' },
  { key: 'tenant-ops', label: 'Tenant Ops' },
  { key: 'landlord-ops', label: 'Landlord Ops' },
  { key: 'partner-ops', label: 'Partner Ops' },
  { key: 'hr', label: 'HR Dashboard' },
  { key: 'rd', label: 'R&D Dashboard' },
  { key: 'kyc', label: 'KYC Console' },
];

interface DashboardPermissionsTabProps {
  userId: string;
}

export default function DashboardPermissionsTab({ userId }: DashboardPermissionsTabProps) {
  const { user } = useAuth();
  const { canEdit } = useCanEditAccess();
  const [granted, setGranted] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [forcedRole, setForcedRole] = useState<ForcedRole | null>(null);
  const [savingRole, setSavingRole] = useState<ForcedRole | 'clear' | null>(null);

  useEffect(() => {
    const fetch = async () => {
      const { data, error } = await supabase
        .from('staff_permissions')
        .select('id, permitted_dashboard')
        .eq('user_id', userId)
        .is('revoked_at', null);
      if (error) {
        toast.error(error.message);
      }
      const map: Record<string, string> = {};
      (data || []).forEach((p: any) => { map[p.permitted_dashboard] = p.id; });
      setGranted(map);
      const { data: prof } = await supabase
        .from('profiles')
        .select('forced_default_role')
        .eq('id', userId)
        .maybeSingle();
      setForcedRole(((prof as any)?.forced_default_role as ForcedRole) ?? null);
      setLoading(false);
    };
    fetch();
  }, [userId]);

  const setDefaultRole = async (role: ForcedRole | 'clear') => {
    if (!user) return;
    setSavingRole(role);
    try {
      const isClear = role === 'clear';
      const payload = isClear
        ? { forced_default_role: null, forced_default_role_set_by: null, forced_default_role_set_at: null }
        : { forced_default_role: role, forced_default_role_set_by: user.id, forced_default_role_set_at: new Date().toISOString() };
      const { error } = await supabase.from('profiles').update(payload as any).eq('id', userId);
      if (error) throw error;
      setForcedRole(isClear ? null : role);
      try {
        await supabase.from('audit_logs').insert({
          user_id: user.id,
          action_type: isClear ? 'forced_default_role_cleared' : 'forced_default_role_set',
          table_name: 'profiles',
          record_id: userId,
          metadata: { forced_default_role: isClear ? null : role, set_by: user.id, reason: 'cto_per_user_override' },
        } as any);
      } catch {/* non-blocking */}
      toast.success(isClear ? 'Default role override cleared' : `Default role set to ${role}`);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update default role');
    } finally {
      setSavingRole(null);
    }
  };

  const toggle = async (dashboard: string, checked: boolean) => {
    if (!user) return;
    setToggling(dashboard);

    try {
      if (checked) {
        const { data: inserted, error: insertError } = await supabase
          .from('staff_permissions')
          .insert({
            user_id: userId,
            permitted_dashboard: dashboard,
            granted_by: user.id,
          } as any)
          .select('id')
          .single();
        if (insertError) throw insertError;

        await supabase.from('audit_logs').insert({
          user_id: user.id,
          action_type: 'permission_granted',
          table_name: 'staff_permissions',
          record_id: userId,
          metadata: { dashboard, granted_to: userId, reason: reason.trim() },
        });

        setGranted(prev => ({ ...prev, [dashboard]: (inserted as any).id }));
        toast.success(`Access granted: ${dashboard}`);
      } else {
        const rowId = granted[dashboard];
        if (!rowId) throw new Error('No active grant found to revoke. Reopen this tab and try again.');
        const { error: revokeError } = await supabase
          .from('staff_permissions')
          .update({
            revoked_at: new Date().toISOString(),
            revoked_by: user.id,
            revoke_reason: reason.trim() || null,
          } as any)
          .eq('id', rowId);
        if (revokeError) throw revokeError;

        await supabase.from('audit_logs').insert({
          user_id: user.id,
          action_type: 'permission_revoked',
          table_name: 'staff_permissions',
          record_id: userId,
          metadata: { dashboard, revoked_from: userId, reason: reason.trim() },
        });

        setGranted(prev => {
          const next = { ...prev };
          delete next[dashboard];
          return next;
        });
        setReason('');
        toast.success(`Access revoked: ${dashboard}`);
      }
    } catch (e: any) {
      toast.error(e?.message || 'The database refused the change.');
    } finally {
      setToggling(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-2">
          <Compass className="h-4 w-4 text-primary" />
          <p className="text-sm font-semibold text-foreground">Default Role on App Open</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Pick which role this user lands on by default when they open the app. They can still switch to any of their other roles. Leave unset to let the user choose.
        </p>
        <div className="flex flex-wrap gap-2">
          {DEFAULT_ROLE_OPTIONS.map((opt) => {
            const active = forcedRole === opt.value;
            const busy = savingRole === opt.value;
            return (
              <Button
                key={opt.value}
                size="sm"
                variant={active ? 'default' : 'outline'}
                disabled={savingRole !== null}
                onClick={() => setDefaultRole(opt.value)}
                className="gap-1.5"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span>{opt.emoji}</span>}
                {opt.label}
              </Button>
            );
          })}
          <Button
            size="sm"
            variant="ghost"
            disabled={savingRole !== null || !forcedRole}
            onClick={() => setDefaultRole('clear')}
            className="gap-1.5 text-muted-foreground"
          >
            {savingRole === 'clear' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            Clear
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Current: <span className="font-medium text-foreground">{forcedRole ? forcedRole : 'Not forced (user chooses)'}</span>
        </p>
      </div>

      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <p className="text-sm font-semibold text-foreground">Dashboard Permissions</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Select which dashboards this staff member can access. Changes are logged for auditing.
      </p>
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason for this change (recorded against the grant)"
        className="h-9 text-xs"
        disabled={!canEdit}
      />
      {!canEdit && (
        <p className="text-xs text-muted-foreground">
          You can view dashboard access here. Only access administrators can change it.
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {DASHBOARDS.map((d) => (
          <div key={d.key} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
            {toggling === d.key ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <Checkbox
                checked={!!granted[d.key]}
                onCheckedChange={(checked) => toggle(d.key, !!checked)}
                disabled={toggling === d.key || !canEdit}
              />
            )}
            <Label className="text-sm cursor-pointer">{d.label}</Label>
          </div>
        ))}
      </div>
    </div>
  );
}
