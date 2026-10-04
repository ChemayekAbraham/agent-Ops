import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { UserMinus, Loader2, ShieldX, ClipboardList } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useCanEditAccess } from '@/hooks/useCanEditAccess';
import { Progress } from '@/components/ui/progress';

type AppRole = 'tenant' | 'agent' | 'landlord' | 'supporter' | 'manager';

interface BulkRemoveRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedUserIds: string[];
  selectedUserNames?: Record<string, string>;
  onSuccess: () => void;
}

const roles: { value: AppRole; label: string; description: string }[] = [
  { value: 'tenant', label: 'Tenant', description: 'Remove tenant access' },
  { value: 'agent', label: 'Agent', description: 'Remove agent privileges' },
  { value: 'landlord', label: 'Landlord', description: 'Remove landlord access' },
  { value: 'supporter', label: 'Supporter', description: 'Remove supporter/investor access' },
  { value: 'manager', label: 'Manager', description: 'Remove administrative access' },
];

export default function BulkRemoveRoleDialog({
  open,
  onOpenChange,
  selectedUserIds,
  selectedUserNames = {},
  onSuccess
}: BulkRemoveRoleDialogProps) {
  const { user } = useAuth();
  const { canEdit } = useCanEditAccess();
  const [selectedRole, setSelectedRole] = useState<AppRole>('tenant');
  const [removing, setRemoving] = useState(false);
  const [progress, setProgress] = useState(0);

  const roleLabels: Record<string, string> = {
    tenant: '🏠 Tenant',
    agent: '💼 Agent', 
    landlord: '🏢 Landlord',
    supporter: '💰 Supporter',
    manager: '👑 Manager'
  };

  const logRoleChange = async (userId: string, role: string, userName?: string) => {
    if (!user?.id) return;
    
    try {
      await supabase.from('audit_logs').insert({
        action_type: 'role_removed',
        user_id: user.id,
        record_id: userId,
        table_name: 'user_roles',
        metadata: { role, user_name: userName, old_values: { role } },
      });
    } catch (error) {
      console.error('Failed to log role change:', error);
    }
  };

  const sendBulkNotifications = async (userIds: string[], role: string) => {
    try {
      await supabase.functions.invoke('send-push-notification', {
        body: {
          userIds,
          payload: {
            title: `🔔 Role Removed: ${roleLabels[role] || role}`,
            body: `Your ${role} role has been removed. Some features may no longer be accessible.`,
            url: '/dashboard/tenant',
            type: 'role_change'
          }
        }
      });
    } catch (error) {
      console.error('Failed to send bulk notifications:', error);
    }
  };

  const handleRemove = async () => {
    if (!selectedRole) {
      toast.error('Please select a role to remove');
      return;
    }

    setRemoving(true);
    setProgress(0);
    
    try {
      let successCount = 0;
      let skipCount = 0;
      const totalUsers = selectedUserIds.length;
      const successfulUserIds: string[] = [];

      for (let i = 0; i < selectedUserIds.length; i++) {
        const userId = selectedUserIds[i];
        
        // Check if user has this role
        const { data: existingRole } = await supabase
          .from('user_roles')
          .select('id')
          .eq('user_id', userId)
          .eq('role', selectedRole)
          .single();

        if (!existingRole) {
          skipCount++;
        } else {
          // Disable the role (set enabled=false) instead of deleting
          // This prevents auto-provisioning from re-creating it on next login
          const { error } = await supabase
            .from('user_roles')
            .update({ enabled: false })
            .eq('user_id', userId)
            .eq('role', selectedRole);

          if (!error) {
            successCount++;
            successfulUserIds.push(userId);
            // Log to audit
            await logRoleChange(userId, selectedRole, selectedUserNames[userId]);
          }
        }
        
        setProgress(Math.round(((i + 1) / totalUsers) * 100));
      }

      // Send push notifications to all successfully updated users
      if (successfulUserIds.length > 0) {
        await sendBulkNotifications(successfulUserIds, selectedRole);
        // Notify managers (fire-and-forget)
        supabase.functions.invoke('notify-managers', {
          body: { title: '🔒 Bulk Role Removed', body: `${selectedRole} role removed from ${successfulUserIds.length} user(s)`, url: '/dashboard/manager' }
        }).catch(() => {});
      }

      if (successCount > 0) {
        toast.success(`Removed "${selectedRole}" role from ${successCount} user${successCount > 1 ? 's' : ''}`, {
          description: 'Changes logged to audit trail'
        });
      }
      if (skipCount > 0) {
        toast.info(`${skipCount} user${skipCount > 1 ? 's' : ''} didn't have this role`);
      }
      if (successCount === 0 && skipCount === selectedUserIds.length) {
        toast.warning('No users had this role to remove');
      }

      onOpenChange(false);
      onSuccess();
    } catch (error) {
      console.error('Error removing roles:', error);
      toast.error('Failed to remove roles');
    } finally {
      setRemoving(false);
      setProgress(0);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserMinus className="h-5 w-5 text-destructive" />
            Remove Role
          </DialogTitle>
          <DialogDescription>
            Remove a role from {selectedUserIds.length} selected user{selectedUserIds.length > 1 ? 's' : ''}.
            Users who don't have this role will be skipped.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <Label className="text-sm font-medium mb-3 block">Select Role to Remove</Label>
          <RadioGroup
            value={selectedRole}
            onValueChange={(value) => setSelectedRole(value as AppRole)}
            className="space-y-2"
          >
            {roles.map((role) => (
              <div
                key={role.value}
                className={`flex items-start gap-3 p-3 rounded-xl border transition-colors cursor-pointer ${
                  selectedRole === role.value
                    ? 'border-destructive bg-destructive/5'
                    : 'border-border hover:border-destructive/30'
                }`}
                onClick={() => setSelectedRole(role.value)}
              >
                <RadioGroupItem value={role.value} id={`remove-${role.value}`} className="mt-0.5" />
                <div className="flex-1">
                  <Label htmlFor={`remove-${role.value}`} className="font-medium cursor-pointer">
                    {role.label}
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {role.description}
                  </p>
                </div>
              </div>
            ))}
          </RadioGroup>
        </div>

        {removing && (
          <div className="space-y-2 pb-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <ClipboardList className="h-3.5 w-3.5" />
                Processing & logging changes...
              </span>
              <span>{progress}%</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {!canEdit && (
            <p className="w-full text-xs text-muted-foreground">
              Only access administrators can bulk remove internal and executive roles.
            </p>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={removing}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleRemove} disabled={removing || (!canEdit && !['tenant','agent','landlord','supporter','senior_agent','sub_agent'].includes(selectedRole))}>
            {removing ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Removing...
              </>
            ) : (
              <>
                <ShieldX className="h-4 w-4 mr-2" />
                Remove Role
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
