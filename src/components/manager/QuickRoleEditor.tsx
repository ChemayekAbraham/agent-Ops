import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from '@/components/ui/badge';
import { MoreVertical, Check, User, UserCog } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QuickRoleEditorProps {
  userId: string;
  userName: string;
  userAvatar?: string;
  onRoleChange?: () => void;
}

export function QuickRoleEditor({ userId, userName, userAvatar, onRoleChange }: QuickRoleEditorProps) {
  const [userRole, setUserRole] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const fetchUserRole = async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('user_roles')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (error) {
          console.error('Error fetching user role:', error);
        }

        setUserRole(data);
      } finally {
        setLoading(false);
      }
    };

    fetchUserRole();
  }, [userId]);

  const handleRoleUpdate = async (role: string) => {
    setLoading(true);
    try {
      const previousRole = userRole?.role ?? null;
      const { error } = await supabase
        .from('user_roles')
        .upsert({ user_id: userId, role: role as any }, { onConflict: 'user_id' });

      if (error) {
        console.error('Error updating user role:', error);
        toast({
          title: 'Error',
          description: 'Failed to update user role',
          variant: 'destructive',
        });
      } else {
        setUserRole({ ...userRole, role: role });
        toast({
          title: 'Success',
          description: `User role updated to ${role}`,
        });
        onRoleChange?.();

        // Role grants are high-risk -- gaining authority lets someone
        // perform many other actions afterward. Not logged before this.
        // Plain client-side insert so the audit_logs IP-capture trigger
        // sees the real browser IP directly.
        try {
          const { data: { user: actor } } = await supabase.auth.getUser();
          await supabase.from('audit_logs').insert({
            user_id: actor?.id ?? null,
            action_type: 'role_granted',
            table_name: 'user_roles',
            record_id: userId,
            old_values: { role: previousRole },
            new_values: { role },
            metadata: { target_user_id: userId, target_user_name: userName },
          });
        } catch (e) {
          console.warn('[QuickRoleEditor] audit log insert failed:', e);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const handleEnableDisable = async (enabled: boolean) => {
    setLoading(true);
    try {
      const { error } = await supabase
        .from('user_roles')
        .update({ enabled: enabled })
        .eq('user_id', userId);

      if (error) {
        console.error('Error updating user status:', error);
        toast({
          title: 'Error',
          description: 'Failed to update user status',
          variant: 'destructive',
        });
      } else {
        setUserRole({ ...userRole, enabled: enabled });
        toast({
          title: 'Success',
          description: `User ${enabled ? 'enabled' : 'disabled'}`,
        });

        // Activating/deactivating an account's role is a high-risk access
        // change, not logged before this. Plain client-side insert so the
        // audit_logs IP-capture trigger sees the real browser IP directly.
        try {
          const { data: { user: actor } } = await supabase.auth.getUser();
          await supabase.from('audit_logs').insert({
            user_id: actor?.id ?? null,
            action_type: enabled ? 'role_enabled' : 'role_disabled',
            table_name: 'user_roles',
            record_id: userId,
            old_values: { enabled: !enabled },
            new_values: { enabled },
            metadata: { target_user_id: userId, target_user_name: userName },
          });
        } catch (e) {
          console.warn('[QuickRoleEditor] audit log insert failed:', e);
        }
        onRoleChange?.();
      }
    } finally {
      setLoading(false);
    }
  };

  const roleLabelMap: Record<string, string> = {
    tenant: 'Tenant', agent: 'Agent', landlord: 'Landlord', supporter: 'Supporter', manager: 'Manager',
    ceo: 'CEO', coo: 'COO', cfo: 'CFO', cto: 'CTO', cmo: 'CMO', crm: 'CRM',
    employee: 'Employee', operations: 'Operations', super_admin: 'Super Admin',
  };
  const roleLabel = roleLabelMap[userRole?.role] || userRole?.role || 'Unknown';
  const enabled = userRole?.enabled === true;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative h-8 w-8 rounded-full">
          <Avatar className="h-8 w-8">
            {userAvatar ? (
              <AvatarImage src={userAvatar} alt={userName} />
            ) : (
              <AvatarFallback>{userName?.substring(0, 2).toUpperCase()}</AvatarFallback>
            )}
          </Avatar>
          <span className="sr-only">Open user menu</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex flex-col space-y-1 font-normal">
          <div className="flex items-center space-x-2">
            <span>{userName}</span>
            {userRole?.role && (
              <Badge variant="secondary">
                {roleLabel}
              </Badge>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            {userId}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={loading} onClick={() => handleRoleUpdate('supporter')}>
          <User className="mr-2 h-4 w-4" />
          <span>Supporter</span>
          {userRole?.role === 'supporter' && (
            <Check className="ml-auto h-4 w-4" />
          )}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={loading} onClick={() => handleRoleUpdate('agent')}>
          <UserCog className="mr-2 h-4 w-4" />
          <span>Agent</span>
          {userRole?.role === 'agent' && (
            <Check className="ml-auto h-4 w-4" />
          )}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={loading} onClick={() => handleRoleUpdate('manager')}>
          <UserCog className="mr-2 h-4 w-4" />
          <span>Manager</span>
          {userRole?.role === 'manager' && (
            <Check className="ml-auto h-4 w-4" />
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={loading} onClick={() => handleEnableDisable(!enabled)}>
          {enabled ? 'Disable' : 'Enable'} User
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
