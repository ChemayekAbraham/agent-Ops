import { CheckCircle2, Circle, Clock, Shield, UserCheck, Wallet, Home, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface ProcessStep {
  key: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  status: 'completed' | 'active' | 'pending';
  detail?: string;
}

interface RentProcessTrackerProps {
  requestStatus: string;
  agentVerified?: boolean;
  managerApproved?: boolean;
  supporterFunded?: boolean;
  fundRecipientType?: string | null;
  fundRecipientName?: string | null;
  fundRoutedAt?: string | null;
  compact?: boolean;
}

export default function RentProcessTracker({
  requestStatus,
  agentVerified,
  managerApproved,
  supporterFunded,
  fundRecipientType,
  fundRecipientName,
  fundRoutedAt,
  compact = false,
}: RentProcessTrackerProps) {
  const getStepStatus = (stepKey: string): 'completed' | 'active' | 'pending' => {
    const statusOrder = ['pending', 'approved', 'funded', 'disbursed', 'completed'];
    const currentIdx = statusOrder.indexOf(requestStatus);

    switch (stepKey) {
      case 'agent_verify':
        return agentVerified || currentIdx >= 0 ? 'completed' : 'pending';
      case 'manager_approve':
        return currentIdx >= 1 ? 'completed' : currentIdx === 0 && agentVerified ? 'active' : 'pending';
      case 'supporter_fund':
        return currentIdx >= 2 ? 'completed' : currentIdx === 1 ? 'active' : 'pending';
      case 'fund_route':
        return fundRoutedAt ? 'completed' : currentIdx >= 2 ? 'active' : 'pending';
      case 'repayment':
        return requestStatus === 'completed' ? 'completed' : currentIdx >= 3 ? 'active' : 'pending';
      default:
        return 'pending';
    }
  };

  const steps: ProcessStep[] = [
    {
      key: 'agent_verify',
      label: 'Agent Verification',
      description: 'Agent verifies tenant details',
      icon: <Shield className="h-4 w-4" />,
      status: getStepStatus('agent_verify'),
    },
    {
      key: 'manager_approve',
      label: 'Manager Approval',
      description: 'Manager reviews and approves request',
      icon: <UserCheck className="h-4 w-4" />,
      status: getStepStatus('manager_approve'),
    },
    {
      key: 'supporter_fund',
      label: 'Supporter Funding',
      description: 'Supporter deposits rent amount',
      icon: <Wallet className="h-4 w-4" />,
      status: getStepStatus('supporter_fund'),
    },
    {
      key: 'fund_route',
      label: 'Funds Delivered',
      description: fundRecipientType
        ? `Sent to ${fundRecipientName} (${fundRecipientType})`
        : 'Routed to landlord/caretaker/agent',
      icon: <Home className="h-4 w-4" />,
      status: getStepStatus('fund_route'),
      detail: fundRecipientType
        ? `Via ${fundRecipientType}`
        : undefined,
    },
    {
      key: 'repayment',
      label: 'Tenant Repayment',
      description: 'Daily repayment in progress',
      icon: <Clock className="h-4 w-4" />,
      status: getStepStatus('repayment'),
    },
  ];

  if (compact) {
    return (
      <div className="flex items-center gap-1 overflow-x-auto py-1">
        {steps.map((step, i) => (
          <div key={step.key} className="flex items-center gap-1 shrink-0">
            <div
              className={cn(
                'w-6 h-6 rounded-full flex items-center justify-center',
                step.status === 'completed' && 'bg-success text-success-foreground',
                step.status === 'active' && 'bg-primary text-primary-foreground animate-pulse',
                step.status === 'pending' && 'bg-muted text-muted-foreground'
              )}
            >
              {step.status === 'completed' ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <span className="text-[10px] font-bold">{i + 1}</span>
              )}
            </div>
            {i < steps.length - 1 && (
              <div
                className={cn(
                  'w-4 h-0.5',
                  step.status === 'completed' ? 'bg-success' : 'bg-muted'
                )}
              />
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ArrowRight className="h-4 w-4 text-primary" />
          Rent Process
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="space-y-0">
          {steps.map((step, i) => (
            <div key={step.key} className="flex gap-3">
              {/* Vertical line + icon */}
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    'w-8 h-8 rounded-full flex items-center justify-center shrink-0 border-2',
                    step.status === 'completed' && 'bg-success border-success text-white',
                    step.status === 'active' && 'bg-primary/10 border-primary text-primary',
                    step.status === 'pending' && 'bg-muted border-border text-muted-foreground'
                  )}
                >
                  {step.status === 'completed' ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    step.icon
                  )}
                </div>
                {i < steps.length - 1 && (
                  <div
                    className={cn(
                      'w-0.5 flex-1 min-h-[24px]',
                      step.status === 'completed' ? 'bg-success' : 'bg-border'
                    )}
                  />
                )}
              </div>
              {/* Content */}
              <div className="pb-4 pt-1 flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p
                    className={cn(
                      'text-sm font-medium',
                      step.status === 'completed' && 'text-success',
                      step.status === 'active' && 'text-primary',
                      step.status === 'pending' && 'text-muted-foreground'
                    )}
                  >
                    {step.label}
                  </p>
                  {step.status === 'active' && (
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-primary/10 text-primary border-primary/30 animate-pulse">
                      In Progress
                    </Badge>
                  )}
                  {step.detail && step.status === 'completed' && (
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-success/10 text-success border-success/30">
                      {step.detail}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {step.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
