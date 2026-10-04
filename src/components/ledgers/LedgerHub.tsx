import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SuspenseLedger } from './SuspenseLedger';
import { DefaultRecoveryLedger } from './DefaultRecoveryLedger';
import { SupporterCapitalLedger } from './SupporterCapitalLedger';
import { CommissionAccrualLedger } from './CommissionAccrualLedger';
import { FeeRevenueLedger } from './FeeRevenueLedger';
import { SettlementReconciliationLedger } from './SettlementReconciliationLedger';
import { AlertTriangle, ShieldAlert, Users, Coins, Receipt, ArrowLeftRight } from 'lucide-react';

export function LedgerHub() {
  const [tab, setTab] = useState('suspense');

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-bold">Advanced Ledgers</h2>
        <p className="text-[10px] text-muted-foreground">Suspense · Defaults · Capital · Commissions · Revenue · Settlement</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto -mx-3 px-3 scrollbar-none">
          <TabsList className="h-9 w-max justify-start">
            <TabsTrigger value="suspense" className="text-[10px] gap-1 px-2.5 shrink-0 min-h-[36px]">
              <AlertTriangle className="h-3 w-3" /> Suspense
            </TabsTrigger>
            <TabsTrigger value="defaults" className="text-[10px] gap-1 px-2.5 shrink-0 min-h-[36px]">
              <ShieldAlert className="h-3 w-3" /> Defaults
            </TabsTrigger>
            <TabsTrigger value="capital" className="text-[10px] gap-1 px-2.5 shrink-0 min-h-[36px]">
              <Users className="h-3 w-3" /> Capital
            </TabsTrigger>
            <TabsTrigger value="commissions" className="text-[10px] gap-1 px-2.5 shrink-0 min-h-[36px]">
              <Coins className="h-3 w-3" /> Commissions
            </TabsTrigger>
            <TabsTrigger value="revenue" className="text-[10px] gap-1 px-2.5 shrink-0 min-h-[36px]">
              <Receipt className="h-3 w-3" /> Revenue
            </TabsTrigger>
            <TabsTrigger value="settlement" className="text-[10px] gap-1 px-2.5 shrink-0 min-h-[36px]">
              <ArrowLeftRight className="h-3 w-3" /> Settlement
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="suspense" className="mt-2"><SuspenseLedger /></TabsContent>
        <TabsContent value="defaults" className="mt-2"><DefaultRecoveryLedger /></TabsContent>
        <TabsContent value="capital" className="mt-2"><SupporterCapitalLedger /></TabsContent>
        <TabsContent value="commissions" className="mt-2"><CommissionAccrualLedger /></TabsContent>
        <TabsContent value="revenue" className="mt-2"><FeeRevenueLedger /></TabsContent>
        <TabsContent value="settlement" className="mt-2"><SettlementReconciliationLedger /></TabsContent>
      </Tabs>
    </div>
  );
}
