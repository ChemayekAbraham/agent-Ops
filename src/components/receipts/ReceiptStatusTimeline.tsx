import { CheckCircle, Clock, XCircle, Store, FileCheck } from 'lucide-react';
import { format } from 'date-fns';

interface ReceiptStatusTimelineProps {
  submittedAt: string;
  vendorVerifiedAt: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
}

export function ReceiptStatusTimeline({
  submittedAt,
  vendorVerifiedAt,
  approvedAt,
  rejectedReason
}: ReceiptStatusTimelineProps) {
  const isRejected = !!rejectedReason;
  const isApproved = !!approvedAt;
  const isVendorVerified = !!vendorVerifiedAt;

  const steps = [
    {
      label: 'Submitted',
      date: submittedAt,
      completed: true,
      icon: FileCheck,
      color: 'text-primary'
    },
    {
      label: 'Vendor Verified',
      date: vendorVerifiedAt,
      completed: isVendorVerified,
      icon: Store,
      color: isVendorVerified ? 'text-primary' : 'text-muted-foreground'
    },
    {
      label: isRejected ? 'Rejected' : 'Approved',
      date: isRejected ? null : approvedAt,
      completed: isApproved || isRejected,
      icon: isRejected ? XCircle : CheckCircle,
      color: isRejected ? 'text-destructive' : isApproved ? 'text-success' : 'text-muted-foreground'
    }
  ];

  return (
    <div className="mt-3 pt-3 border-t border-border/50">
      <div className="flex items-center justify-between gap-2">
        {steps.map((step, index) => (
          <div key={step.label} className="flex-1 flex flex-col items-center text-center">
            <div className="flex items-center w-full">
              {/* Left connector line */}
              {index > 0 && (
                <div 
                  className={`flex-1 h-0.5 ${
                    step.completed ? 'bg-primary' : 'bg-border'
                  }`} 
                />
              )}
              
              {/* Icon */}
              <div 
                className={`relative z-10 flex items-center justify-center w-8 h-8 rounded-full border-2 transition-all ${
                  step.completed 
                    ? step.label === 'Rejected' 
                      ? 'bg-destructive/10 border-destructive' 
                      : 'bg-primary/10 border-primary'
                    : 'bg-muted border-border'
                }`}
              >
                {step.completed ? (
                  <step.icon className={`h-4 w-4 ${step.color}`} />
                ) : (
                  <Clock className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              
              {/* Right connector line */}
              {index < steps.length - 1 && (
                <div 
                  className={`flex-1 h-0.5 ${
                    steps[index + 1].completed ? 'bg-primary' : 'bg-border'
                  }`} 
                />
              )}
            </div>
            
            {/* Label and date */}
            <p className={`text-xs font-medium mt-1.5 ${step.color}`}>
              {step.label}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {step.date 
                ? format(new Date(step.date), 'MMM d, HH:mm')
                : step.completed && step.label === 'Rejected'
                  ? 'See reason'
                  : 'Pending'
              }
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
