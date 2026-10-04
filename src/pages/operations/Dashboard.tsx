import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, Users, Home, Building2, Handshake, Banknote, Briefcase } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ScreenLoader from '@/components/common/ScreenLoader';

const departmentConfig = {
  financial: { label: 'Financial Ops', icon: Banknote, route: '/admin/financial-ops' },
  company: { label: 'Company Staff', icon: Briefcase, route: '/executive-hub?tab=company-ops' },
  agent: { label: 'Agent Operations', icon: Users, route: '/executive-hub?tab=agent-ops' },
  tenant: { label: 'Tenant Operations', icon: Home, route: '/executive-hub?tab=tenant-ops' },
  landlord: { label: 'Landlord Operations', icon: Building2, route: '/executive-hub?tab=landlord-ops' },
  partner: { label: 'Partner Operations', icon: Handshake, route: '/executive-hub?tab=partners-ops' },
};

export default function OperationsDashboard() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [departments, setDepartments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const fetchDepartments = async () => {
      const { data, error } = await supabase
        .from('operations_departments')
        .select('department')
        .eq('user_id', user.id);
      if (error) console.error('Failed to load operations departments:', error);
      // DB stores values like `agent_ops`, `tenant_ops`. Strip the `_ops` suffix to match
      // departmentConfig keys (agent, tenant, landlord, partner, financial, company).
      const deps = Array.from(
        new Set(
          (data ?? [])
            .map(d => String(d.department || '').trim().toLowerCase().replace(/_ops$/, ''))
            .filter(Boolean)
        )
      );
      setDepartments(deps);
      setLoading(false);

      if (deps.length === 1) {
        const config = departmentConfig[deps[0] as keyof typeof departmentConfig];
        if (config) navigate(config.route, { replace: true });
      }
    };
    fetchDepartments();
  }, [user, navigate]);

  if (authLoading || loading) {
    return (
      <ScreenLoader />
    );
  }

  return (
    <div className="min-h-screen bg-background p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-black text-foreground">Operations Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">Select a department to manage</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {departments.length === 0 && (
          <p className="text-muted-foreground col-span-full text-center py-8">
            No departments assigned. Contact your administrator.
          </p>
        )}
        {departments.map(dep => {
          const config = departmentConfig[dep as keyof typeof departmentConfig];
          if (!config) return null;
          const Icon = config.icon;
          return (
            <Button
              key={dep}
              variant="outline"
              className="h-auto p-6 flex flex-col items-center gap-3 hover:border-primary/50"
              onClick={() => navigate(config.route)}
            >
              <Icon className="h-8 w-8 text-primary" />
              <span className="font-semibold">{config.label}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
