import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Users, ChevronRight } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useReferralCount } from '@/hooks/wallet/useReferrals';

export function MyReferralsCount() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { count, isLoading: loading } = useReferralCount(user?.id);

  return (
    <Button
      variant="ghost"
      onClick={() => navigate('/referrals')}
      className="w-full justify-between h-auto py-3 px-4 bg-primary/5 hover:bg-primary/10 rounded-xl border border-primary/20"
    >
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/15">
          <Users className="h-5 w-5 text-primary" />
        </div>
        <div className="text-left">
          <p className="text-sm font-semibold text-foreground">My Referrals</p>
          <p className="text-xs text-muted-foreground">Invite friends to earn</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="bg-primary/20 text-primary font-bold text-sm px-2.5">
          {loading ? '—' : count}
        </Badge>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>
    </Button>
  );
}
