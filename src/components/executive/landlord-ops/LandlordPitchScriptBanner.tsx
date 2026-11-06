import { useState } from 'react';
import { ChevronDown, ChevronUp, Copy, PhoneCall } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  LANDLORD_PITCH_PERIOD_MONTHS,
  NEW_LANDLORD_CALLING_STEPS,
  NEW_LANDLORD_HOW_PAYMENT_WORKS_SCRIPT,
  NEW_LANDLORD_PHONE_OPENING_SCRIPT,
  formatLandlordPeriodOffer,
  type LandlordPitchPeriodMonths,
} from '@/lib/landlordPitchScript';

export interface LandlordPitchScriptBannerProps {
  landlordName?: string | null;
  defaultRentUgx?: number | null;
  defaultOpen?: boolean;
  compact?: boolean;
  className?: string;
}

export function LandlordPitchScriptBanner({
  landlordName,
  defaultRentUgx,
  defaultOpen = false,
  compact = false,
  className,
}: LandlordPitchScriptBannerProps) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [periodMonths, setPeriodMonths] = useState<LandlordPitchPeriodMonths>(3);

  const personalizedOpening = landlordName && landlordName !== 'Landlord'
    ? NEW_LANDLORD_PHONE_OPENING_SCRIPT.replace('[Landlord Name]', landlordName)
    : NEW_LANDLORD_PHONE_OPENING_SCRIPT;

  const sampleRent = defaultRentUgx && defaultRentUgx > 0 ? defaultRentUgx : 500_000;

  const handleCopyOpening = async () => {
    try {
      await navigator.clipboard.writeText(personalizedOpening);
      toast.success('Copied landlord opening script');
    } catch {
      toast.error('Could not copy script text');
    }
  };

  return (
    <div
      data-testid="landlord-pitch-script-banner"
      className={cn(
        'rounded-xl border border-primary/25 bg-primary/5 p-3 sm:p-4 space-y-2.5 text-xs',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 font-bold uppercase tracking-wider text-primary text-xs">
              <PhoneCall className="h-3.5 w-3.5 shrink-0" />
              New Landlord Phone Opening Script
            </span>
            <Badge variant="outline" className="text-xs border-primary/30 text-foreground">
              Start with 1 tenant or empty unit
            </Badge>
          </div>
          <p
            data-testid="landlord-pitch-opening-line"
            className="text-xs text-foreground leading-relaxed font-medium"
          >
            "{personalizedOpening}"
          </p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="copy-landlord-pitch-script-btn"
            onClick={handleCopyOpening}
            className="min-h-[44px] text-xs gap-1.5 bg-background"
          >
            <Copy className="h-3.5 w-3.5 text-primary" />
            Copy script
          </Button>
          {!compact && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="toggle-landlord-pitch-steps-btn"
              onClick={() => setExpanded((prev) => !prev)}
              className="min-h-[44px] text-xs gap-1"
            >
              {expanded ? (
                <>
                  Hide steps
                  <ChevronUp className="h-3.5 w-3.5" />
                </>
              ) : (
                <>
                  3-step guide
                  <ChevronDown className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Quick 1-unit period example so callers never quote an abstract 12-month multi-unit figure cold */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-background/90 px-3 py-2">
        <div className="text-xs text-muted-foreground">
          Example for <span className="font-semibold text-foreground">1 unit</span> at{' '}
          <span className="font-semibold text-foreground">
            UGX {sampleRent.toLocaleString('en-UG')}/mo
          </span>
          :{' '}
          <span
            data-testid="landlord-pitch-script-offer-preview"
            className="font-bold text-primary"
          >
            {formatLandlordPeriodOffer(sampleRent, 1, periodMonths)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {LANDLORD_PITCH_PERIOD_MONTHS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setPeriodMonths(m)}
              className={cn(
                'min-h-[44px] px-2.5 rounded-lg border text-xs font-semibold transition-colors',
                periodMonths === m
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card text-foreground hover:bg-muted',
              )}
            >
              {m} mo
            </button>
          ))}
        </div>
      </div>

      {expanded && (
        <div
          data-testid="landlord-pitch-steps-panel"
          className="space-y-2 pt-1 border-t border-border/60"
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {NEW_LANDLORD_CALLING_STEPS.map((step) => (
              <div
                key={step.stepNumber}
                className="rounded-lg border border-border/70 bg-background p-2.5 space-y-1"
              >
                <div className="text-xs font-bold text-foreground">
                  Step {step.stepNumber} · {step.title}
                </div>
                <p className="text-xs text-foreground leading-relaxed">
                  "{step.spokenText.replace('[Landlord Name]', landlordName || 'Landlord')}"
                </p>
                <p className="text-xs text-muted-foreground leading-snug">
                  Tip: {step.coachingNote}
                </p>
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
            <span className="font-semibold text-foreground">How & when payment moves: </span>
            {NEW_LANDLORD_HOW_PAYMENT_WORKS_SCRIPT}
          </div>
        </div>
      )}
    </div>
  );
}
