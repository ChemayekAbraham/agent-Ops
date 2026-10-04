import { useState } from 'react';
import { useCanEditAccess } from '@/hooks/useCanEditAccess';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Plus, Home, Users, Wallet, Building2, Shield, Check } from 'lucide-react';
import { AppRole } from '@/hooks/useAuth';

const MANAGER_ACCESS_CODE = 'Manager@welile';

interface AddRoleDialogProps {
  availableRoles: AppRole[];
  onAddRole: (role: AppRole) => Promise<{ error: Error | null }>;
}

const allRoles: { value: AppRole; label: string; description: string; icon: React.ReactNode; requiresCode: boolean }[] = [
  { value: 'tenant', label: 'Tenant', description: 'Request rent facilitation', icon: <Home className="h-4 w-4" />, requiresCode: false },
  { value: 'agent', label: 'Agent', description: 'Connect tenants to the platform', icon: <Users className="h-4 w-4" />, requiresCode: false },
  { value: 'landlord', label: 'Landlord', description: 'Receive rent payments', icon: <Building2 className="h-4 w-4" />, requiresCode: false },
  { value: 'supporter', label: 'Supporter', description: 'Fund rent requests', icon: <Wallet className="h-4 w-4" />, requiresCode: false },
  { value: 'manager', label: 'Manager', description: 'Manage platform operations', icon: <Shield className="h-4 w-4" />, requiresCode: true },
  { value: 'ceo', label: 'CEO', description: 'Chief Executive Officer', icon: <Shield className="h-4 w-4" />, requiresCode: true },
  { value: 'coo', label: 'COO', description: 'Chief Operating Officer', icon: <Shield className="h-4 w-4" />, requiresCode: true },
  { value: 'cfo', label: 'CFO', description: 'Chief Financial Officer', icon: <Wallet className="h-4 w-4" />, requiresCode: true },
  { value: 'cto', label: 'CTO', description: 'Chief Technology Officer', icon: <Shield className="h-4 w-4" />, requiresCode: true },
  { value: 'cmo', label: 'CMO', description: 'Chief Marketing Officer', icon: <Users className="h-4 w-4" />, requiresCode: true },
  { value: 'crm', label: 'CRM', description: 'Customer Relationship Manager', icon: <Users className="h-4 w-4" />, requiresCode: true },
  { value: 'employee', label: 'Employee', description: 'Internal staff member', icon: <Users className="h-4 w-4" />, requiresCode: true },
  { value: 'operations', label: 'Operations', description: 'Operations management', icon: <Shield className="h-4 w-4" />, requiresCode: true },
  { value: 'super_admin', label: 'Super Admin', description: 'Full system access', icon: <Shield className="h-4 w-4" />, requiresCode: true },
  { value: 'hr', label: 'HR', description: 'Human Resources Manager', icon: <Users className="h-4 w-4" />, requiresCode: true },
];

export default function AddRoleDialog({ availableRoles, onAddRole }: AddRoleDialogProps) {
  const [open, setOpen] = useState(false);
  const [selectedRole, setSelectedRole] = useState<AppRole | null>(null);
  const [accessCode, setAccessCode] = useState('');
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();
  const { canEdit } = useCanEditAccess();

  const missingRoles = allRoles.filter(r => !availableRoles.includes(r.value));

  if (missingRoles.length === 0) {
    return null;
  }

  const handleRoleSelect = (role: AppRole) => {
    const roleConfig = allRoles.find(r => r.value === role);
    if (roleConfig?.requiresCode) {
      setSelectedRole(role);
      setShowCodeInput(true);
    } else {
      addRoleDirectly(role);
    }
  };

  const addRoleDirectly = async (role: AppRole) => {
    setIsLoading(true);
    const { error } = await onAddRole(role);
    setIsLoading(false);

    if (error) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive'
      });
    } else {
      toast({
        title: 'Role Added',
        description: `You now have access to the ${role} dashboard`
      });
      setOpen(false);
      setSelectedRole(null);
      setAccessCode('');
      setShowCodeInput(false);
    }
  };

  const confirmManagerAccess = async () => {
    if (accessCode !== MANAGER_ACCESS_CODE) {
      toast({
        title: 'Invalid Code',
        description: 'The access code is incorrect',
        variant: 'destructive'
      });
      return;
    }

    if (selectedRole) {
      await addRoleDirectly(selectedRole);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      setSelectedRole(null);
      setAccessCode('');
      setShowCodeInput(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Add Role
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Another Role</DialogTitle>
          <DialogDescription>
            Expand your capabilities by adding another role to your account.
          </DialogDescription>
        </DialogHeader>
        
        {showCodeInput ? (
          <div className="space-y-4 pt-4">
            <div className="flex items-center gap-2 text-warning">
              <Shield className="h-5 w-5" />
              <span className="font-medium">Manager Access Required</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Enter the manager access code to unlock this role.
            </p>
            <div className="space-y-2">
              <Label>Access Code</Label>
              <Input
                type="password"
                placeholder="Enter access code"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowCodeInput(false)}>
                Back
              </Button>
              <Button onClick={confirmManagerAccess} disabled={isLoading || (!canEdit && !['tenant','agent','landlord','supporter','senior_agent','sub_agent'].includes(selectedRole))} className="flex-1">
                {isLoading ? 'Adding...' : 'Verify & Add Role'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 pt-4">
            {!canEdit && (
              <p className="text-sm text-muted-foreground">
                You can add standard roles here. Only access administrators can add internal and executive roles.
              </p>
            )}
            {missingRoles.map((role) => (
              <button
                key={role.value}
                onClick={() => handleRoleSelect(role.value)}
                disabled={isLoading || (!canEdit && !['tenant','agent','landlord','supporter','senior_agent','sub_agent'].includes(role.value))}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition-all text-left"
              >
                <div className="p-2 rounded-lg bg-secondary">
                  {role.icon}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{role.label}</span>
                    {role.requiresCode && (
                      <span className="text-xs px-2 py-0.5 rounded bg-warning/10 text-warning">
                        Code Required
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{role.description}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
