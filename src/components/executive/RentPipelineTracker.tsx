import { cn } from '@/lib/utils';
import { CheckCircle2, Clock, ArrowRight, Coins, Shield, UserCheck, FileCheck, Banknote, Wallet, MapPin } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

const STAGES = [
  {
    key: 'pending',
    label: 'Agent Ops',
    agentBenefit: 'assigned',
    agentDesc: 'Agent Ops triage — submission validated',
    earningAmount: 0,
    icon: UserCheck,
  },
  {
    key: 'agent_ops_approved',
    label: 'Tenant Ops',
    agentBenefit: 'verification',
    agentDesc: 'Tenant Ops review — agent assigned by proximity',
    earningAmount: 0,
    icon: Shield,
  },
  {
    key: 'tenant_ops_approved',
    label: 'Landlord Ops',
    agentBenefit: 'landlord_verification',
    agentDesc: 'Landlord location verified → UGX 5,000 verification bonus',
    earningAmount: 5000,
    icon: MapPin,
  },
  {
    key: 'landlord_ops_approved',
    label: 'COO',
    agentBenefit: 'pipeline',
    agentDesc: 'Operational sign-off — bonuses locked and pending',
    earningAmount: 0,
    icon: FileCheck,
  },
  {
    key: 'coo_approved',
    label: 'CFO',
    agentBenefit: 'pipeline',
    agentDesc: 'Awaiting payout authorization — bonus queued on disbursement',
    earningAmount: 0,
    icon: Banknote,
  },
  {
    key: 'funded',
    label: 'Disbursed',
    agentBenefit: 'rent_funded',
    agentDesc: 'UGX 5,000 rent-funded bonus + 5% on every future repayment',
    earningAmount: 5000,
    icon: Wallet,
  },
];

const STAGE_ORDER: Record<string, number> = {};
STAGES.forEach((s, i) => { STAGE_ORDER[s.key] = i; });

/**
 * Short pipeline for tenants registered with an outstanding balance.
 * They are already living in the property — no landlord disbursement,
 * no Landlord Ops / COO / CFO. Two human steps then auto-complete.
 */
const OUTSTANDING_STAGES = [
  {
    key: 'pending',
    label: 'Agent Ops',
    icon: UserCheck,
  },
  {
    key: 'agent_ops_approved',
    label: 'Tenant Ops',
    icon: Shield,
  },
  {
    key: 'completed',
    label: 'Recorded',
    icon: CheckCircle2,
  },
];
const OUTSTANDING_ORDER: Record<string, number> = {};
OUTSTANDING_STAGES.forEach((s, i) => { OUTSTANDING_ORDER[s.key] = i; });

interface RentPipelineTrackerProps {
  currentStatus: string;
  compact?: boolean;
  rentAmount?: number;
  showAgentBenefits?: boolean;
  /** When 'outstanding_balance', renders the short 2-step pipeline. */
  registrationType?: string;
}

export function RentPipelineTracker({ currentStatus, compact, rentAmount, showAgentBenefits, registrationType }: RentPipelineTrackerProps) {
  const isOutstanding = registrationType === 'outstanding_balance';

  if (isOutstanding) {
    const currentIndex = OUTSTANDING_ORDER[currentStatus] ?? -1;
    return (
      <div className="space-y-2">
        <div className={cn('flex items-center gap-1', compact ? 'flex-wrap' : 'overflow-x-auto')}>
          {OUTSTANDING_STAGES.map((stage, i) => {
            const completed = i < currentIndex;
            const active = i === currentIndex;
            const isFinal = stage.key === 'completed';
            return (
              <div key={stage.key} className="flex items-center gap-1">
                <div
                  className={cn(
                    'flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium transition-all',
                    completed && 'bg-primary/10 text-primary',
                    active && 'bg-primary text-primary-foreground',
                    !completed && !active && 'bg-muted text-muted-foreground',
                    isFinal && completed && 'bg-success/20 text-success'
                  )}
                >
                  {completed ? <CheckCircle2 className="h-3 w-3" /> : active ? <Clock className="h-3 w-3" /> : null}
                  {stage.label}
                </div>
                {i < OUTSTANDING_STAGES.length - 1 && (
                  <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                )}
              </div>
            );
          })}
        </div>
        {showAgentBenefits && (
          <div className="mt-2 px-2.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-foreground">
            <p className="font-semibold text-amber-700">Outstanding balance — short approval</p>
            <p className="text-muted-foreground mt-0.5">
              Existing tenant. No landlord disbursement, no agent bonus.
              {rentAmount ? ` Recording UGX ${formatUGX(rentAmount).replace('UGX ', '')} owed.` : ''}
            </p>
          </div>
        )}
      </div>
    );
  }

  const currentIndex = STAGE_ORDER[currentStatus] ?? -1;
  const landlordVerificationBonus = 5000;
  const rentFundedBonus = 5000;
  const listingBonus = 5000;

  return (
    <div className="space-y-2">
      {/* Pipeline Steps */}
      <div className={cn('flex items-center gap-1', compact ? 'flex-wrap' : 'overflow-x-auto')}>
        {STAGES.map((stage, i) => {
          const completed = i < currentIndex;
          const active = i === currentIndex;
          const isDisbursed = stage.key === 'funded';
          return (
            <div key={stage.key} className="flex items-center gap-1">
              <div
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium transition-all',
                  completed && 'bg-primary/10 text-primary',
                  active && 'bg-primary text-primary-foreground',
                  !completed && !active && 'bg-muted text-muted-foreground',
                  isDisbursed && completed && 'bg-success/20 text-success'
                )}
              >
                {completed ? <CheckCircle2 className="h-3 w-3" /> : active ? <Clock className="h-3 w-3" /> : null}
                {stage.label}
              </div>
              {i < STAGES.length - 1 && (
                <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
              )}
            </div>
          );
        })}
      </div>

      {/* Agent Benefits Breakdown */}
      {showAgentBenefits && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
            <Coins className="h-3.5 w-3.5 text-success" />
            Agent Earnings at Each Stage
          </p>
          <div className="space-y-1">
            {STAGES.map((stage, i) => {
              const completed = i < currentIndex;
              const active = i === currentIndex;
              const StageIcon = stage.icon;

              let earningLabel = '';
              let earningColor = 'text-muted-foreground';

              if (stage.agentBenefit === 'assigned') {
                earningLabel = 'Task assigned';
                earningColor = completed || active ? 'text-primary' : 'text-muted-foreground';
              } else if (stage.agentBenefit === 'verification') {
                earningLabel = 'Verifying…';
                earningColor = completed ? 'text-primary/70' : active ? 'text-primary' : 'text-muted-foreground';
              } else if (stage.agentBenefit === 'landlord_verification') {
                earningLabel = `+${formatUGX(landlordVerificationBonus)} bonus`;
                earningColor = completed ? 'text-success' : active ? 'text-primary' : 'text-muted-foreground';
              } else if (stage.agentBenefit === 'rent_funded') {
                earningLabel = `+${formatUGX(rentFundedBonus)} + 5%/repayment`;
                earningColor = completed ? 'text-success font-bold' : 'text-muted-foreground';
              } else {
                earningLabel = 'Processing…';
                earningColor = completed ? 'text-primary/70' : 'text-muted-foreground';
              }

              return (
                <div
                  key={stage.key}
                  className={cn(
                    'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-all',
                    completed && 'bg-primary/5',
                    active && 'bg-primary/10 ring-1 ring-primary/20',
                    !completed && !active && 'opacity-50'
                  )}
                >
                  <StageIcon className={cn('h-3.5 w-3.5 shrink-0', completed ? 'text-success' : active ? 'text-primary' : 'text-muted-foreground')} />
                  <span className="flex-1 text-foreground">{stage.agentDesc}</span>
                  <span className={cn('font-semibold whitespace-nowrap', earningColor)}>
                    {earningLabel}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Total Potential + Recurring */}
          {rentAmount && (
            <div className="space-y-1.5 mt-2">
              <div className="flex items-center justify-between px-2.5 py-2 rounded-lg bg-primary/5 border border-primary/20">
                <span className="text-xs font-semibold text-primary flex items-center gap-1.5">
                  <Coins className="h-4 w-4" />
                  One-Time Bonuses
                </span>
                <span className="font-bold text-primary">
                  {formatUGX(landlordVerificationBonus + rentFundedBonus + listingBonus)}
                </span>
              </div>
              <div className="flex items-center justify-between px-2.5 py-2 rounded-lg bg-success/10 border border-success/20">
                <span className="text-xs font-semibold text-success flex items-center gap-1.5">
                  <Wallet className="h-4 w-4" />
                  Recurring: 5% of Every Repayment
                </span>
                <span className="font-bold text-success">
                  ∞ (per collection)
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
