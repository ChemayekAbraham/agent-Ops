import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Users, UserPlus, Share2, ChevronRight } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useUserSnapshot } from '@/hooks/useUserSnapshot';
import { hapticTap } from '@/lib/haptics';

interface RecruitSubAgentCTAProps {
  onRegister: () => void;
  onViewSubAgents: () => void;
  onShareLink: () => void;
}

export function RecruitSubAgentCTA({ onRegister, onViewSubAgents, onShareLink }: RecruitSubAgentCTAProps) {
  const { user } = useAuth();
  const { snapshot } = useUserSnapshot(user?.id);
  const subAgentCount = snapshot.subAgents?.length || 0;

  return (
    <div className="rounded-2xl border-2 border-warning/30 bg-gradient-to-br from-warning/10 via-warning/5 to-transparent p-4 space-y-3 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-warning/20">
            <Users className="h-5 w-5 text-warning" />
          </div>
          <div>
            <p className="font-bold text-sm">Build Your Team</p>
            <p className="text-[11px] text-muted-foreground">Earn <span className="font-bold text-warning">2%</span> from all their collections</p>
          </div>
        </div>
        {subAgentCount > 0 && (
          <button onClick={() => { hapticTap(); onViewSubAgents(); }} className="flex items-center gap-1">
            <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30 text-xs">
              {subAgentCount} agent{subAgentCount !== 1 ? 's' : ''}
            </Badge>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Benefits — ultra compact */}
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          { emoji: '💰', label: 'UGX 500/signup' },
          { emoji: '📈', label: '2% their earnings' },
          { emoji: '🚀', label: 'Unlimited team' },
        ].map(b => (
          <div key={b.label} className="py-2 px-1 rounded-lg bg-background/60 border border-border/40">
            <p className="text-base">{b.emoji}</p>
            <p className="text-[10px] font-medium text-muted-foreground mt-0.5">{b.label}</p>
          </div>
        ))}
      </div>

      {/* Two action buttons */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          onClick={() => { hapticTap(); onRegister(); }}
          className="h-11 gap-1.5 bg-warning text-warning-foreground hover:bg-warning/90 font-semibold text-xs"
        >
          <UserPlus className="h-4 w-4" />
          Register Agent
        </Button>
        <Button
          variant="outline"
          onClick={() => { hapticTap(); onShareLink(); }}
          className="h-11 gap-1.5 border-warning/40 text-warning hover:bg-warning/10 font-semibold text-xs"
        >
          <Share2 className="h-4 w-4" />
          Share Link
        </Button>
      </div>
    </div>
  );
}
