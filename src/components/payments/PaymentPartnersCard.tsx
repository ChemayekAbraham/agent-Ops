import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CreditCard, Phone, Copy, CheckCircle2, Banknote, Building2, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import PaymentConfirmationForm from './PaymentConfirmationForm';
import mtnLogoAsset from '@/assets/mtn-logo.png.asset.json';
import airtelLogoAsset from '@/assets/airtel-logo.png.asset.json';
import equityLogoAsset from '@/assets/equity-logo.png.asset.json';

interface PaymentPartnersCardProps {
  dashboardType: 'tenant' | 'supporter';
  onPaymentSubmitted?: () => void;
}

type Channel = 'momo_mtn' | 'momo_airtel' | 'agent_cash' | 'bank';

const PROVIDERS = {
  mtn: {
    name: 'MTN MoMo',
    merchantId: '090777',
    steps: [
      'Dial *165*3#',
      'Choose "Pay with MoMo"',
      'Enter Merchant ID: 090777',
      'Enter amount & confirm with PIN',
    ],
    buildDial: (amount?: string) => amount ? `tel:*165*3*090777*${amount}%23` : `tel:*165*3*090777%23`,
  },
  airtel: {
    name: 'Airtel Money',
    merchantId: '4380664',
    steps: [
      'Dial *185*9#',
      'Select "Pay Merchant"',
      'Enter Merchant ID: 4380664',
      'Enter amount & confirm with PIN',
    ],
    buildDial: (amount?: string) => amount ? `tel:*185*9*4380664*${amount}%23` : `tel:*185*9*4380664%23`,
  },
};

const MERCHANT_NAME = 'WELILE TECHNOLOGIES LIMITTED';

const BANK_DETAILS = {
  bankName: 'Equity Bank Uganda',
  branch: 'Entebbe Branch',
  accountName: 'WELILE TECHNOLOGIES LIMITED',
  accountNumber: '1046203375259',
  currency: 'UGX',
  swiftCode: 'EQBLUGKA',
};

const CHANNELS = [
  { id: 'agent_cash' as Channel, icon: Banknote, label: 'Cash with Agent', desc: 'Pay cash to a Welile agent near you', color: 'border-emerald-500 bg-emerald-500/5' },
  { id: 'momo_mtn' as Channel, icon: Phone, label: 'MTN MoMo', desc: 'Pay via MTN Mobile Money', color: 'border-[hsl(var(--warning))] bg-[hsl(var(--warning))]/5' },
  { id: 'momo_airtel' as Channel, icon: Phone, label: 'Airtel Money', desc: 'Pay via Airtel Money', color: 'border-destructive bg-destructive/5' },
  { id: 'bank' as Channel, icon: Building2, label: 'Bank Transfer', desc: 'Equity Bank Uganda deposit', color: 'border-blue-500 bg-blue-500/5' },
];

export default function PaymentPartnersCard({ dashboardType, onPaymentSubmitted }: PaymentPartnersCardProps) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [amount, setAmount] = useState('');
  const [copied, setCopied] = useState(false);

  const provider = channel === 'momo_mtn' ? 'mtn' : channel === 'momo_airtel' ? 'airtel' : null;
  const data = provider ? PROVIDERS[provider] : null;
  const isMtn = provider === 'mtn';

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(`Copied ${text}`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

  const handlePayNow = () => {
    if (!provider || !data) return;
    const dial = data.buildDial(amount);
    window.location.href = dial;
    setTimeout(() => {
      toast.info(`Merchant ID: ${data.merchantId}`, {
        duration: 10000,
        action: { label: 'Copy', onClick: () => handleCopy(data.merchantId) },
      });
    }, 500);
  };

  // Channel selection step
  if (!channel) {
    return (
      <div className="space-y-4">
        <div>
          <p className="text-sm font-bold text-foreground">Choose how you want to pay</p>
          <p className="text-xs text-muted-foreground mt-0.5">Select a payment method to continue</p>
        </div>
        <div className="grid gap-3">
          {CHANNELS.map((ch) => (
            <button
              key={ch.id}
              onClick={() => setChannel(ch.id)}
              className={cn(
                'flex items-center gap-3.5 p-4 rounded-2xl border-2 text-left transition-all hover:shadow-lg active:scale-[0.97] touch-manipulation',
                ch.color
              )}
            >
              <div className={cn(
                'w-12 h-12 rounded-xl flex items-center justify-center shrink-0 shadow-sm overflow-hidden',
                ch.id === 'agent_cash' && 'bg-emerald-500',
                ch.id === 'momo_mtn' && 'bg-[hsl(var(--warning))]',
                ch.id === 'momo_airtel' && 'bg-destructive',
                ch.id === 'bank' && 'bg-blue-500',
              )}>
                {ch.id === 'momo_mtn' ? (
                  <img src={mtnLogoAsset.url} alt="MTN MoMo" className="w-full h-full object-cover" />
                ) : ch.id === 'momo_airtel' ? (
                  <img src={airtelLogoAsset.url} alt="Airtel Money" className="w-full h-full object-cover" />
                ) : ch.id === 'bank' ? (
                  <img src={equityLogoAsset.url} alt="Equity Bank" className="w-full h-full object-cover" />
                ) : (
                  <ch.icon className="h-5 w-5 text-white" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-sm">{ch.label}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{ch.desc}</p>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Back button */}
      <button onClick={() => setChannel(null)} className="text-xs text-primary font-medium flex items-center gap-1">
        ← Change payment method
      </button>

      {/* MoMo flow */}
      {(channel === 'momo_mtn' || channel === 'momo_airtel') && data && (
        <Card className="bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-primary" />
              Pay via {data.name}
            </CardTitle>
            <CardDescription>Follow the steps below</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Merchant ID */}
            <div className="p-3 bg-muted/60 rounded-xl text-center space-y-0.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Merchant ID</p>
              <div className="flex items-center justify-center gap-2">
                <span className="text-2xl font-mono font-bold tracking-widest">{data.merchantId}</span>
                <button type="button" onClick={() => handleCopy(data.merchantId)} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
                  {copied ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
                </button>
              </div>
              <p className="text-[10px] text-primary font-medium">{MERCHANT_NAME}</p>
            </div>

            {/* Timeline Steps */}
            <div className="pl-2">
              {data.steps.map((step, i) => (
                <div key={i} className="flex gap-2.5 items-start">
                  <div className="flex flex-col items-center">
                    <div className={cn(
                      'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0',
                      isMtn
                        ? 'bg-[hsl(var(--warning))] text-[hsl(var(--warning-foreground))]'
                        : 'bg-destructive text-destructive-foreground'
                    )}>
                      {i + 1}
                    </div>
                    {i < data.steps.length - 1 && <div className="w-px h-3.5 bg-border" />}
                  </div>
                  <p className="text-xs text-muted-foreground pt-0.5 pb-1.5">{step}</p>
                </div>
              ))}
            </div>

            {/* Amount Input */}
            <div className="space-y-1.5">
              <Label className="text-xs">Amount (UGX)</Label>
              <Input
                type="number"
                placeholder="Enter amount to pay"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                min="500"
                className="h-10 text-base font-semibold"
              />
            </div>

            {/* Pay Now */}
            {amount && parseFloat(amount) > 0 && (
              <Button
                type="button"
                className={cn(
                  'w-full h-11 font-semibold',
                  isMtn
                    ? 'bg-[hsl(var(--warning))] text-[hsl(var(--warning-foreground))] hover:bg-[hsl(var(--warning))]/90'
                    : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                )}
                onClick={handlePayNow}
              >
                <Phone className="h-4 w-4 mr-2" />
                Call {isMtn ? `*165*3*${data.merchantId}*${amount}#` : `*185*9*${data.merchantId}*${amount}#`}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Agent Cash flow */}
      {channel === 'agent_cash' && (
        <Card className="border-emerald-500/20 bg-emerald-500/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Banknote className="w-5 h-5 text-emerald-600" />
              Cash with Agent
            </CardTitle>
            <CardDescription>Visit a Welile agent near you and pay cash</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="pl-2">
              {[
                'Find a Welile agent near you',
                'Pay the amount in cash',
                'Get a receipt from the agent',
                'Enter the receipt number below to confirm',
              ].map((step, i, arr) => (
                <div key={i} className="flex gap-2.5 items-start">
                  <div className="flex flex-col items-center">
                    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 bg-emerald-500 text-white">
                      {i + 1}
                    </div>
                    {i < arr.length - 1 && <div className="w-px h-3.5 bg-border" />}
                  </div>
                  <p className="text-xs text-muted-foreground pt-0.5 pb-1.5">{step}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bank Transfer flow */}
      {channel === 'bank' && (
        <Card className="border-blue-500/20 bg-blue-500/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Building2 className="w-5 h-5 text-blue-600" />
              Bank Transfer
            </CardTitle>
            <CardDescription>Transfer to our bank account</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="grid gap-1.5 text-xs">
              {[
                ['Bank', BANK_DETAILS.bankName],
                ['Branch', BANK_DETAILS.branch],
                ['Account Name', BANK_DETAILS.accountName],
                ['Account Number', BANK_DETAILS.accountNumber],
                ['Currency', BANK_DETAILS.currency],
                ['SWIFT Code', BANK_DETAILS.swiftCode],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between items-center py-1.5 border-b border-border/30 last:border-0">
                  <span className="text-muted-foreground">{label}</span>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{value}</span>
                    <button type="button" onClick={() => handleCopy(value)} className="p-1 rounded hover:bg-muted">
                      <Copy className="h-3 w-3 text-muted-foreground" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <PaymentConfirmationForm
        dashboardType={dashboardType}
        onSuccess={onPaymentSubmitted}
      />
    </div>
  );
}
