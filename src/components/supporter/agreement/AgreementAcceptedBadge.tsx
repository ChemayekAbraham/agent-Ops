import { useState, useEffect } from 'react';
import { CheckCircle2, PartyPopper, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AgreementAcceptedBadgeProps {
  acceptedAt?: string;
  showCelebration?: boolean;
  variant?: 'compact' | 'full';
  className?: string;
}

export function AgreementAcceptedBadge({ 
  acceptedAt, 
  showCelebration = false,
  variant = 'compact',
  className 
}: AgreementAcceptedBadgeProps) {
  const [isAnimating, setIsAnimating] = useState(showCelebration);

  useEffect(() => {
    if (showCelebration) {
      setIsAnimating(true);
      const timer = setTimeout(() => setIsAnimating(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [showCelebration]);

  if (variant === 'compact') {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-300",
          isAnimating 
            ? "bg-gradient-to-r from-emerald-500 to-green-500 text-white shadow-lg shadow-emerald-500/30 animate-pulse"
            : "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20",
          className
        )}
      >
        {isAnimating ? (
          <>
            <PartyPopper className="h-3.5 w-3.5 animate-bounce" />
            <span>Terms Accepted!</span>
            <Sparkles className="h-3 w-3" />
          </>
        ) : (
          <>
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>Terms Accepted</span>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl p-4 transition-all duration-500",
        isAnimating 
          ? "bg-gradient-to-br from-emerald-500 via-green-500 to-teal-500 text-white shadow-xl shadow-emerald-500/30"
          : "bg-emerald-500/5 border border-emerald-500/20",
        className
      )}
    >
      {/* Celebration sparkles background */}
      {isAnimating && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {[...Array(6)].map((_, i) => (
            <Sparkles
              key={i}
              className={cn(
                "absolute h-4 w-4 text-white/40 animate-ping",
                i === 0 && "top-2 left-4",
                i === 1 && "top-4 right-6",
                i === 2 && "bottom-3 left-8",
                i === 3 && "bottom-2 right-4",
                i === 4 && "top-1/2 left-2",
                i === 5 && "top-1/3 right-2"
              )}
              style={{ animationDelay: `${i * 0.2}s` }}
            />
          ))}
        </div>
      )}

      <div className="relative flex items-center gap-3">
        <div className={cn(
          "p-2.5 rounded-xl shrink-0 transition-all duration-300",
          isAnimating 
            ? "bg-white/20" 
            : "bg-emerald-500/10"
        )}>
          {isAnimating ? (
            <PartyPopper className="h-5 w-5 animate-bounce" />
          ) : (
            <CheckCircle2 className={cn(
              "h-5 w-5",
              isAnimating ? "text-white" : "text-emerald-600"
            )} />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className={cn(
            "font-semibold text-sm",
            isAnimating ? "text-white" : "text-emerald-700"
          )}>
            {isAnimating ? '🎉 Agreement Accepted!' : 'Terms & Conditions Accepted'}
          </p>
          <p className={cn(
            "text-xs mt-0.5",
            isAnimating ? "text-white/80" : "text-emerald-600/70"
          )}>
            {isAnimating 
              ? 'You can now start investing and helping tenants!'
              : acceptedAt 
                ? `Accepted on ${new Date(acceptedAt).toLocaleDateString()}`
                : 'You have full access to investment features'
            }
          </p>
        </div>

        {isAnimating && (
          <Sparkles className="h-5 w-5 text-white animate-spin shrink-0" style={{ animationDuration: '2s' }} />
        )}
      </div>
    </div>
  );
}
