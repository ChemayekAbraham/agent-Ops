import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Shield, Bell } from 'lucide-react';
import { AgentRequisitionForm } from '@/components/financial-ops/AgentRequisitionForm';

interface FinancialAgentSectionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FinancialAgentSection({ open, onOpenChange }: FinancialAgentSectionProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[92vh] overflow-y-auto rounded-t-2xl px-4 pb-6 pt-5">
        {/* App Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-purple-600 to-pink-500 flex items-center justify-center">
              <Shield className="h-4 w-4 text-white" />
            </div>
            <span className="text-sm font-bold text-foreground tracking-tight">Sovereign Vault</span>
          </div>
          <div className="rounded-full bg-muted p-2">
            <Bell className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>

        {/* Title */}
        <div className="mb-5">
          <Badge className="bg-primary/15 text-primary border-0 text-[10px] font-bold tracking-widest uppercase mb-2">
            Financial Agent
          </Badge>
          <h1 className="text-2xl font-bold text-foreground">Fund Requisition</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Request liquidity for operational disbursements.
          </p>
        </div>

        {/* Form + History */}
        <AgentRequisitionForm />

        {/* Security Banner */}
        <div className="mt-6 rounded-2xl bg-primary/10 p-4 flex items-start gap-3">
          <div className="rounded-full bg-primary/20 p-2 shrink-0">
            <Shield className="h-4 w-4 text-primary" />
          </div>
          <div>
            <p className="text-xs font-semibold text-primary">Secured Vault Access</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              All fund requisitions are encrypted and audited per Sovereign compliance standards.
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
