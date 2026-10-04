import { BadgeCheck, Lock, ChevronRight, Shield, Trophy } from 'lucide-react';
// framer-motion removed — entrance/progress animations are now CSS transitions
// so this always-mounted component no longer pulls the vendor-motion chunk.
import { useState } from 'react';
import { useVerificationStatus } from '@/hooks/useVerificationStatus';
import { cn } from '@/lib/utils';

interface VerificationChecklistProps {
  userId: string | undefined;
  highlightRole?: string;
  compact?: boolean;
}

const roleIcons: Record<string, string> = {
  agent: '🏃',
  tenant: '🏠',
  landlord: '🏢',
  supporter: '💰',
};

const tierLabels = [
  { min: 0, label: 'Ordinary User', color: 'text-muted-foreground', bg: 'bg-muted' },
  { min: 1, label: 'Rising Star', color: 'text-[#9234EA]', bg: 'bg-[#9234EA]/10' },
  { min: 2, label: 'Trusted Member', color: 'text-primary', bg: 'bg-primary/10' },
  { min: 3, label: 'Power User', color: 'text-success', bg: 'bg-success/10' },
  { min: 4, label: 'Welile Champion', color: 'text-primary', bg: 'bg-gradient-to-r from-primary/15 to-success/15' },
];

function getTier(count: number) {
  return [...tierLabels].reverse().find(t => count >= t.min) || tierLabels[0];
}

export function VerificationChecklist({ userId, highlightRole, compact = false }: VerificationChecklistProps) {
  const { verifications, loading, verifiedCount, totalRoles } = useVerificationStatus(userId);
  const [expanded, setExpanded] = useState(false);

  if (loading || verifications.length === 0) return null;

  const tier = getTier(verifiedCount);
  const progress = (verifiedCount / totalRoles) * 100;

  if (compact) {
    return (
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full"
      >
        <div className={cn(
          "flex items-center gap-2.5 px-3 py-2 rounded-xl border border-border/50 transition-all",
          tier.bg
        )}>
          <Trophy className={cn("h-4 w-4 shrink-0", tier.color)} />
          <div className="flex-1 text-left min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn("text-xs font-semibold", tier.color)}>{tier.label}</span>
              <span className="text-[10px] text-muted-foreground">{verifiedCount}/{totalRoles} verified</span>
            </div>
            {/* Mini progress bar */}
            <div className="h-1 w-full bg-border/40 rounded-full mt-1 overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-[width] duration-700 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
          <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        </div>

        {expanded && (
            <div className="overflow-hidden animate-fade-in">
              <div className="pt-2 space-y-1.5">
                {verifications.map((v) => (
                  <div
                    key={v.role}
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-2 rounded-lg text-left",
                      v.role === highlightRole && "ring-1 ring-primary/30",
                      v.verified ? "bg-success/5" : "bg-muted/50"
                    )}
                  >
                    <span className="text-sm">{roleIcons[v.role]}</span>
                    {v.verified ? (
                      <BadgeCheck className="h-3.5 w-3.5 text-success shrink-0" />
                    ) : (
                      <Lock className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className={cn("text-xs font-medium", v.verified ? "text-foreground" : "text-muted-foreground")}>
                        {v.label}
                      </p>
                      <p className="text-[10px] text-muted-foreground truncate">{v.reason}</p>
                    </div>
                    {!v.verified && v.action && (
                      <span className="text-[10px] font-medium text-primary shrink-0">{v.action} →</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
      </button>
    );
  }

  // Full card version
  return (
    <div className="rounded-2xl border border-border/50 bg-card overflow-hidden">
      {/* Header */}
      <div className={cn("flex items-center gap-3 px-4 py-3", tier.bg)}>
        <div className="p-1.5 rounded-lg bg-background/80">
          <Shield className={cn("h-4 w-4", tier.color)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn("text-sm font-bold", tier.color)}>{tier.label}</span>
          </div>
          <p className="text-[10px] text-muted-foreground">{verifiedCount} of {totalRoles} roles verified</p>
        </div>
        <div className="relative h-10 w-10">
          <svg className="h-10 w-10 -rotate-90" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="15.5" fill="none" className="stroke-border/30" strokeWidth="2.5" />
            <circle
              cx="18" cy="18" r="15.5" fill="none"
              className="stroke-primary transition-[stroke-dasharray] duration-1000 ease-out"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${progress} ${100 - progress}`}
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-foreground">
            {verifiedCount}/{totalRoles}
          </span>
        </div>
      </div>

      {/* Checklist items */}
      <div className="px-3 py-2 space-y-1">
        {verifications.map((v) => (
          <div
            key={v.role}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-all",
              v.role === highlightRole && "ring-1 ring-primary/30 bg-primary/5",
              v.verified ? "bg-success/5" : "hover:bg-muted/40"
            )}
          >
            <span className="text-base">{roleIcons[v.role]}</span>
            {v.verified ? (
              <BadgeCheck className="h-4 w-4 text-success fill-success/20 shrink-0" />
            ) : (
              <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30 shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className={cn("text-xs font-semibold", v.verified ? "text-foreground" : "text-muted-foreground")}>
                {v.label}
              </p>
              <p className="text-[10px] text-muted-foreground truncate">{v.reason}</p>
            </div>
            {v.verified && (
              <span className="text-[9px] font-bold text-success bg-success/10 px-1.5 py-0.5 rounded-md">✓</span>
            )}
            {!v.verified && v.action && (
              <span className="text-[10px] font-medium text-primary shrink-0">{v.action} →</span>
            )}
          </div>
        ))}
      </div>

      {verifiedCount < totalRoles && (
        <div className="px-4 py-2.5 border-t border-border/30">
          <p className="text-[10px] text-muted-foreground text-center">
            Complete all roles to become a <span className="font-bold text-primary">Welile Champion</span> 🏆
          </p>
        </div>
      )}
    </div>
  );
}
