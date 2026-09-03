import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Landmark, ShieldCheck, Phone, CheckCircle2, Clock, Play, RefreshCw } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { AgentFloatPayoutWizard } from '@/components/agent/AgentFloatPayoutWizard';
import { AgentLandlordFloatAllocationsDialog } from '@/components/agent/AgentLandlordFloatAllocationsDialog';
import { LandlordPayoutProgress } from '@/components/agent/LandlordPayoutProgress';
import type { LandlordFloatAllocation } from '@/hooks/useLandlordFloatAllocations';

export default function PayLandlord() {
  const navigate = useNavigate();
  const [allocationsOpen, setAllocationsOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedAllocation, setSelectedAllocation] = useState<LandlordFloatAllocation | null>(null);
  const [testProgressOpen, setTestProgressOpen] = useState(false);

  // Sample allocation for direct preview of Screens 2 & 3
  const sampleAllocation: LandlordFloatAllocation = {
    id: 'alloc-demo-1',
    agent_id: 'agent-123',
    rent_request_id: 'req-demo-1',
    landlord_id: 'll-demo-1',
    tenant_id: 'ten-demo-1',
    allocated_amount: 450000,
    paid_out_amount: 0,
    remaining_amount: 450000,
    status: 'open',
    source: 'cfo_disbursement',
    created_at: new Date().toISOString(),
    landlord_name: 'Ssebunya Robert',
    landlord_phone: '0772419045',
    mobile_money_provider: null,
    tenant_name: 'Nakato Grace',
    inflight_payout: null,
  };

  const handleOpenAllocations = () => {
    setSelectedAllocation(null);
    setAllocationsOpen(true);
  };

  const handleOpenWizardDirect = () => {
    setSelectedAllocation(sampleAllocation);
    setWizardOpen(true);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 glass-card border-b border-border/50 bg-background/80 backdrop-blur-md pt-safe">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div>
                <h1 className="text-lg font-bold flex items-center gap-2">
                  <Landmark className="h-5 w-5 text-[#9234EA]" />
                  Landlord Payout Flow
                </h1>
                <p className="text-xs text-muted-foreground">Interactive Screen Test & Preview on Localhost</p>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 max-w-2xl space-y-6">
        <div className="rounded-2xl border-2 border-[#9234EA]/20 bg-[#9234EA]/5 p-5 space-y-2">
          <Badge className="bg-[#9234EA] text-white hover:bg-[#9234EA]/90 text-[11px]">
            6-Screen Continuous Loop
          </Badge>
          <h2 className="text-xl font-bold">Landlord Float Payout Suite</h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Test the live components built for the 6-screen loop: from tenant float allocation selection (with live locked-row countdowns) to instant OTP dispatch, 6-digit verification, auto-disbursement SLA progress, and continuous loop handoff.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Card 1: Screen 1 */}
          <Card className="border-2 hover:border-[#9234EA]/40 transition-colors">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <Badge variant="outline" className="text-[10px] font-mono">Screen 01</Badge>
                <Clock className="h-4 w-4 text-[#9234EA]" />
              </div>
              <CardTitle className="text-base">Landlord Float List</CardTitle>
              <CardDescription className="text-xs">
                Per-tenant ring-fenced float list with live 10-minute locked row ticker and in-flight merchant tracking.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                className="w-full gap-2 bg-[#9234EA] hover:bg-[#9234EA]/90 text-white"
                onClick={handleOpenAllocations}
              >
                <Play className="h-4 w-4" /> Open Allocations List
              </Button>
            </CardContent>
          </Card>

          {/* Card 2: Screen 2 & 3 */}
          <Card className="border-2 hover:border-[#9234EA]/40 transition-colors">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <Badge variant="outline" className="text-[10px] font-mono">Screens 02 – 03</Badge>
                <Phone className="h-4 w-4 text-[#9234EA]" />
              </div>
              <CardTitle className="text-base">OTP Flow Wizard</CardTitle>
              <CardDescription className="text-xs">
                Instant OTP auto-send, masked phone numbers (0772 4•• •••), 6-digit verification slots, and resend timers.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="outline"
                className="w-full gap-2 border-[#9234EA]/50 text-[#9234EA] hover:bg-[#9234EA]/10"
                onClick={handleOpenWizardDirect}
              >
                <Play className="h-4 w-4" /> Open Payout Wizard
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Status States Reference Card */}
        <Card className="border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[#9234EA]" />
              Designed Status States
            </CardTitle>
            <CardDescription className="text-xs">
              Every status state implemented across Screens 3–6
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between p-2 rounded-lg bg-muted/40 border">
              <span className="font-semibold text-muted-foreground">Screen 3 (OTP Pending)</span>
              <Badge variant="secondary" className="text-[10px]">OTP sent, waiting for landlord</Badge>
            </div>
            <div className="flex items-center justify-between p-2 rounded-lg bg-muted/40 border">
              <span className="font-semibold text-muted-foreground">Screen 4 (Verified / Disbursing)</span>
              <Badge className="text-[10px] bg-primary/20 text-primary border-primary/30">OTP Verified — Disbursing SLA</Badge>
            </div>
            <div className="flex items-center justify-between p-2 rounded-lg bg-muted/40 border">
              <span className="font-semibold text-muted-foreground">Screen 5 (Merchant Queue)</span>
              <Badge className="text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30">Sent to Merchant Payout Queue ✓</Badge>
            </div>
            <div className="flex items-center justify-between p-2 rounded-lg bg-muted/40 border">
              <span className="font-semibold text-muted-foreground">Screen 6 (Completed)</span>
              <Badge className="text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30">Payment Sent ✓ → Pay Another</Badge>
            </div>
          </CardContent>
        </Card>
      </main>

      {/* Screen 1: Allocations Dialog */}
      <AgentLandlordFloatAllocationsDialog
        open={allocationsOpen}
        onOpenChange={setAllocationsOpen}
        onSelectAllocation={(allocation) => {
          setAllocationsOpen(false);
          setSelectedAllocation(allocation);
          setTimeout(() => setWizardOpen(true), 250);
        }}
      />

      {/* Screens 2-6: Payout Wizard */}
      <AgentFloatPayoutWizard
        open={wizardOpen}
        onOpenChange={(open) => {
          setWizardOpen(open);
          if (!open) setSelectedAllocation(null);
        }}
        allocation={selectedAllocation}
        onDone={() => {
          // Loop back to Screen 1 after 250ms
          setTimeout(() => setAllocationsOpen(true), 250);
        }}
      />
    </div>
  );
}