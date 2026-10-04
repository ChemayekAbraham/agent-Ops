import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Wallet, Users, ArrowDownLeft, ArrowUpRight, Send } from 'lucide-react';
import { formatCurrency } from '@/lib/paymentMethods';
import FundTenantsFlow from './FundTenantsFlow';
import DepositFlow from './DepositFlow';
import WithdrawFlow from './WithdrawFlow';
import SimpleDepositDialog from './SimpleDepositDialog';
import { SendMoneyDialog } from '@/components/wallet/SendMoneyDialog';
import { WelileAITrigger } from '@/components/ai-chat/WelileAIChatButton';

interface PartnerWalletWidgetProps {
  availableBalance?: number;
  lockedBalance?: number;
  roiEarned?: number;
}

export default function PartnerWalletWidget({
  availableBalance = 2500000,
  lockedBalance = 1800000,
  roiEarned = 250000,
}: PartnerWalletWidgetProps) {
  const [showFundTenants, setShowFundTenants] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showQuickDeposit, setShowQuickDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);

  return (
    <>
      <Card className="bg-gradient-to-br from-emerald-500/5 to-emerald-500/10 border-emerald-500/20">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Wallet className="w-5 h-5 text-emerald-600" />
              Rent Money
            </CardTitle>
            <WelileAITrigger />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Primary balance */}
          <div className="p-4 bg-background/50 rounded-lg text-center">
            <p className="text-xs text-muted-foreground mb-1">Total Balance</p>
            <p className="text-2xl font-bold">{formatCurrency(availableBalance, 'UGX')}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Contributed: <span className="font-medium text-blue-600">{formatCurrency(lockedBalance, 'UGX')}</span>
              {' · '}
              Rewards: <span className="font-medium text-emerald-600">+{formatCurrency(roiEarned, 'UGX')}</span>
            </p>
          </div>

          {/* Action buttons */}
          <div className="space-y-2">
            <Button onClick={() => setShowFundTenants(true)} className="w-full gap-2 bg-emerald-600 hover:bg-emerald-700">
              <Users className="w-4 h-4" />
              Fund Tenants
            </Button>
            <div className="grid grid-cols-3 gap-2">
              <Button onClick={() => setShowQuickDeposit(true)} variant="outline" className="gap-2">
                <ArrowDownLeft className="w-4 h-4" />
                Deposit
              </Button>
              <Button onClick={() => setShowWithdraw(true)} variant="outline" className="gap-2">
                <ArrowUpRight className="w-4 h-4" />
                Withdraw
              </Button>
              <Button onClick={() => setShowTransfer(true)} variant="outline" className="gap-2">
                <Send className="w-4 h-4" />
                Transfer
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <FundTenantsFlow open={showFundTenants} onOpenChange={setShowFundTenants} walletBalance={availableBalance} />
      <DepositFlow
        open={showDeposit}
        onOpenChange={setShowDeposit}
        walletBalance={availableBalance}
        allowedPurposes={['personal_deposit']}
        defaultPurpose="personal_deposit"
        lockPurpose
      />
      <SimpleDepositDialog
        open={showQuickDeposit}
        onOpenChange={(o) => {
          setShowQuickDeposit(o);
          // If user clicked the "Use full deposit" escape hatch, open the full flow.
          if (!o) {
            // No-op; the link inside the dialog only closes itself.
          }
        }}
        purpose="personal_deposit"
      />
      <WithdrawFlow open={showWithdraw} onOpenChange={setShowWithdraw} availableBalance={availableBalance} roiBalance={roiEarned} onSuccess={() => setShowWithdraw(false)} />
      <SendMoneyDialog open={showTransfer} onOpenChange={setShowTransfer} />
    </>
  );
}
