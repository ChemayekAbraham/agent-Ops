/**
 * CFO — Landlord Payout Float Command Centre.
 *
 * Consolidates the complete Landlord Payout Float lifecycle:
 *   1. Disburse Float (BatchPayoutProcessor) — fund agents from COO-approved requests
 *   2. Active on Cards (LandlordFloatAllocationsPanel) — live float held by agents
 *   3. Idle & Overdue (LandlordFloatIdleQueue) — unreleased float aging and recall
 *   4. Send-Backs (CFOAllocationReturnApprovals) — agent return requests
 *   5. Promissory Bookings (PromissoryBookingsPanel) — 7-day partner note holds
 *   6. Tenant Balance Changes (CFOTenantBalanceApprovals) — proposed rent & balance edits
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Banknote,
  CalendarClock,
  Clock,
  Home,
  Landmark,
  ScrollText,
  ShieldCheck,
  Undo2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CFOTenantBalanceApprovals } from '@/components/cfo/CFOTenantBalanceApprovals';
import { LandlordFloatIdleQueue } from '@/components/shared/LandlordFloatIdleQueue';
import { CFOAllocationReturnApprovals } from '@/components/cfo/CFOAllocationReturnApprovals';
import { PromissoryBookingsPanel } from '@/components/cfo/PromissoryBookingsPanel';
import { BatchPayoutProcessor } from '@/components/cfo/BatchPayoutProcessor';
import { LandlordFloatAllocationsPanel } from '@/components/cfo/LandlordFloatAllocationsPanel';

export default function CfoLandlordPayoutFloatPanel() {
  const [activeTab, setActiveTab] = useState<string>('disburse');

  // Query pending tenant balance edits for live tab counter badge
  const { data: pendingBalanceEdits = [] } = useQuery({
    queryKey: ['cfo-tenant-balance-edits'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('tenant_balance_edits_pending' as any);
      if (error) throw error;
      return (data as any[]) ?? [];
    },
    staleTime: 30_000,
  });

  const pendingBalanceCount = pendingBalanceEdits.length;

  return (
    <div className="space-y-6">
      {/* Executive Command Header */}
      <div className="flex flex-col gap-4 rounded-xl border border-border/80 bg-card p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Home className="h-5 w-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Landlord Payout Float
            </h1>
            <Badge variant="outline" className="border-primary/30 bg-primary/5 text-primary text-xs font-semibold">
              <ShieldCheck className="h-3 w-3 mr-1 inline" /> CFO Authority
            </Badge>
            <Badge variant="secondary" className="text-xs font-medium">
              Ring-Fenced Float
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground sm:text-sm max-w-3xl">
            Fund agents' Landlord Payout Float from COO-approved rent requests. Each disbursement earmarks money
            for a specific tenant's landlord — the agent then pays via MoMo gated by landlord OTP and Financial Ops sign-off.
          </p>
        </div>
      </div>

      {/* Segmented Workspace Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="bg-muted/60 p-1 flex-wrap h-auto gap-1">
          <TabsTrigger value="disburse" className="text-xs font-semibold gap-1.5 py-1.5">
            <Banknote className="h-3.5 w-3.5" />
            Disburse Payout Float
          </TabsTrigger>
          <TabsTrigger value="active" className="text-xs font-semibold gap-1.5 py-1.5">
            <Landmark className="h-3.5 w-3.5" />
            Active on Agent Cards
          </TabsTrigger>
          <TabsTrigger value="idle" className="text-xs font-semibold gap-1.5 py-1.5">
            <Clock className="h-3.5 w-3.5" />
            Idle &amp; Overdue Float
          </TabsTrigger>
          <TabsTrigger value="returns" className="text-xs font-semibold gap-1.5 py-1.5">
            <Undo2 className="h-3.5 w-3.5" />
            Send-Back Requests
          </TabsTrigger>
          <TabsTrigger value="promissory" className="text-xs font-semibold gap-1.5 py-1.5">
            <CalendarClock className="h-3.5 w-3.5" />
            Promissory Bookings
          </TabsTrigger>
          <TabsTrigger value="balance-changes" className="text-xs font-semibold gap-1.5 py-1.5">
            <ScrollText className="h-3.5 w-3.5" />
            Tenant Balance Changes
            {pendingBalanceCount > 0 && (
              <Badge
                variant="outline"
                className="ml-1 px-1.5 py-0 text-[10px] font-mono font-semibold bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300"
              >
                {pendingBalanceCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Batch Disburse Desk */}
        <TabsContent value="disburse" className="space-y-4">
          <BatchPayoutProcessor />
        </TabsContent>

        {/* Tab 2: Active on Cards */}
        <TabsContent value="active" className="space-y-4">
          <LandlordFloatAllocationsPanel />
        </TabsContent>

        {/* Tab 3: Idle & Overdue Float */}
        <TabsContent value="idle" className="space-y-4">
          <LandlordFloatIdleQueue />
        </TabsContent>

        {/* Tab 4: Send-Back Approvals */}
        <TabsContent value="returns" className="space-y-4">
          <CFOAllocationReturnApprovals />
        </TabsContent>

        {/* Tab 5: Promissory Bookings */}
        <TabsContent value="promissory" className="space-y-4">
          <PromissoryBookingsPanel />
        </TabsContent>

        {/* Tab 6: Tenant Balance Changes */}
        <TabsContent value="balance-changes" className="space-y-4">
          <CFOTenantBalanceApprovals />
        </TabsContent>
      </Tabs>
    </div>
  );
}
