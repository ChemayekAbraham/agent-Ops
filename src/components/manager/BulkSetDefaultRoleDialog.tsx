import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Loader2, Compass, RotateCcw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';

type ForcedRole = 'tenant' | 'agent' | 'landlord' | 'supporter' | 'clear';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedUserIds: string[];
  onSuccess: () => void;
}

const options: { value: ForcedRole; label: string; description: string; emoji: string }[] = [
  { value: 'tenant', label: 'Tenant', emoji: '🏠', description: 'App opens directly into the Tenant view.' },
  { value: 'agent', label: 'Agent', emoji: '💼', description: 'App opens directly into the Agent view.' },
  { value: 'landlord', label: 'Landlord', emoji: '🏢', description: 'App opens directly into the Landlord view.' },
  { value: 'supporter', label: 'Funder (Supporter)', emoji: '💰', description: 'App opens directly into the Funder/Supporter view.' },
  { value: 'clear', label: 'Clear override (let user choose)', emoji: '↩️', description: 'Removes the forced default. Users return to picking their own default role.' },
];

export default function BulkSetDefaultRoleDialog({ open, onOpenChange, selectedUserIds, onSuccess }: Props) {
  const { user } = useAuth();
  const [selected, setSelected] = useState<ForcedRole | ''>('');
  const [saving, setSaving] = useState(false);

  const handleApply = async () => {
    if (!selected) return;
    if (selectedUserIds.length === 0) {
      toast.error('No users selected');
      return;
    }
    setSaving(true);
    try {
      const isClear = selected === 'clear';
      const payload = isClear
        ? { forced_default_role: null, forced_default_role_set_by: null, forced_default_role_set_at: null }
        : { forced_default_role: selected, forced_default_role_set_by: user?.id ?? null, forced_default_role_set_at: new Date().toISOString() };

      const { error } = await supabase
        .from('profiles')
        .update(payload as any)
        .in('id', selectedUserIds);

      if (error) throw error;

      // Audit log (best effort — never block on this)
      try {
        await supabase.from('audit_logs').insert(
          selectedUserIds.map((uid) => ({
            user_id: uid,
            action_type: isClear ? 'forced_default_role_cleared' : 'forced_default_role_set',
            table_name: 'profiles',
            record_id: uid,
            metadata: { forced_default_role: isClear ? null : selected, set_by: user?.id ?? null, reason: 'cto_admin_override' },
          })) as any
        );
      } catch {/* non-blocking */}

      toast.success(
        isClear
          ? `Default role override cleared for ${selectedUserIds.length} user(s)`
          : `Default role set to "${selected}" for ${selectedUserIds.length} user(s)`
      );
      setSelected('');
      onOpenChange(false);
      onSuccess();
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || 'Failed to update default role');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Compass className="h-4 w-4 text-primary" />
            Set Default Role
          </DialogTitle>
          <DialogDescription>
            Choose which role <span className="font-semibold text-foreground">{selectedUserIds.length}</span> selected user{selectedUserIds.length === 1 ? '' : 's'} will land on by default when they open the app. This overrides the user's own device preference.
          </DialogDescription>
        </DialogHeader>

        <RadioGroup value={selected} onValueChange={(v) => setSelected(v as ForcedRole)} className="space-y-2 py-2">
          {options.map((opt) => (
            <label
              key={opt.value}
              htmlFor={`role-${opt.value}`}
              className="flex items-start gap-3 rounded-lg border border-border p-3 cursor-pointer hover:bg-muted/50 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5"
            >
              <RadioGroupItem id={`role-${opt.value}`} value={opt.value} className="mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-base leading-none">{opt.emoji}</span>
                  <Label htmlFor={`role-${opt.value}`} className="text-sm font-medium cursor-pointer">{opt.label}</Label>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{opt.description}</p>
              </div>
            </label>
          ))}
        </RadioGroup>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleApply} disabled={!selected || saving} className="gap-1.5">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {selected === 'clear' ? <><RotateCcw className="h-3.5 w-3.5" /> Clear Override</> : 'Apply Default'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
