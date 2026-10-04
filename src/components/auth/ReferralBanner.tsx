import { Sparkles } from 'lucide-react';

interface ReferralBannerProps {
  referralId: string | null;
  becomeRole: string | null;
}

export function ReferralBanner({ referralId, becomeRole }: ReferralBannerProps) {
  if (!referralId && !becomeRole) return null;

  return (
    <div className={`mb-4 p-4 rounded-xl ${becomeRole === 'agent' ? 'bg-orange-500/10 border border-orange-500/20' : 'bg-success/10 border border-success/20'}`}>
      <div className={`flex items-center justify-center gap-2 ${becomeRole === 'agent' ? 'text-orange-600' : 'text-success'}`}>
        <Sparkles className="h-4 w-4" />
        <span className="text-sm font-medium">
          {becomeRole === 'agent' ? 'Become a Sub-Agent' : 'Referred by an Agent'}
        </span>
      </div>
      <p className="text-xs text-muted-foreground mt-1 text-center">
        {becomeRole === 'agent'
          ? 'Sign up to start earning as an agent!'
          : 'Sign up to get started with rent facilitation'}
      </p>
    </div>
  );
}
