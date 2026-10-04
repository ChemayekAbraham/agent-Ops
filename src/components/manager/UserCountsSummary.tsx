import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Users, UserCheck, Briefcase, Home, Shield, Heart, Loader2, List } from 'lucide-react';

interface RoleCounts {
  total: number;
  tenant: number;
  agent: number;
  landlord: number;
  manager: number;
  supporter: number;
}

interface UserCountsSummaryProps {
  onViewAll: () => void;
}

export default function UserCountsSummary({ onViewAll }: UserCountsSummaryProps) {
  const [counts, setCounts] = useState<RoleCounts | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchCounts();
    const handler = () => fetchCounts();
    window.addEventListener('user-deleted', handler);
    return () => window.removeEventListener('user-deleted', handler);
  }, []);

  const fetchCounts = async () => {
    setLoading(true);
    try {
      // Get total users count (lightweight — just count, no data)
      const { count: totalCount } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true });

      // Get role counts
      const { data: roles } = await supabase
        .from('user_roles')
        .select('role')
        .or('enabled.is.null,enabled.eq.true');

      const roleCounts: Record<string, number> = {};
      roles?.forEach(r => {
        roleCounts[r.role] = (roleCounts[r.role] || 0) + 1;
      });

      setCounts({
        total: totalCount || 0,
        tenant: roleCounts['tenant'] || 0,
        agent: roleCounts['agent'] || 0,
        landlord: roleCounts['landlord'] || 0,
        manager: roleCounts['manager'] || 0,
        supporter: roleCounts['supporter'] || 0,
      });
    } catch (err) {
      console.error('Error fetching user counts:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const cards = [
    { label: 'Total Users', count: counts?.total || 0, icon: Users, color: 'text-primary' },
    { label: 'Tenants', count: counts?.tenant || 0, icon: UserCheck, color: 'text-blue-600' },
    { label: 'Agents', count: counts?.agent || 0, icon: Briefcase, color: 'text-emerald-600' },
    { label: 'Landlords', count: counts?.landlord || 0, icon: Home, color: 'text-amber-600' },
    { label: 'Supporters', count: counts?.supporter || 0, icon: Heart, color: 'text-pink-600' },
    { label: 'Managers', count: counts?.manager || 0, icon: Shield, color: 'text-purple-600' },
  ];

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {cards.map((card) => (
          <Card key={card.label} className="border-border/50">
            <CardContent className="p-4 flex flex-col items-center gap-2 text-center">
              <card.icon className={`h-6 w-6 ${card.color}`} />
              <p className="text-2xl font-bold text-foreground">{card.count.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">{card.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Button
        onClick={onViewAll}
        variant="outline"
        className="w-full gap-2"
        style={{ minHeight: '44px' }}
      >
        <List className="h-4 w-4" />
        View Full User List
      </Button>
    </div>
  );
}
