import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useProfile } from '@/hooks/useProfile';
import { Loader2, CheckCircle2, Banknote, Smartphone, Wallet } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { CollectionVouchCelebration } from './CollectionVouchCelebration';
import { useNavigate } from 'react-router-dom';
import { generateWelileAiId } from '@/lib/welileAiId';
import { emitVouchUpdated } from '@/lib/vouchEvents';

interface RecordAgentCollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function RecordAgentCollectionDialog({ open, onOpenChange, onSuccess }: RecordAgentCollectionDialogProps) {
  const { profile } = useProfile();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [tokenCode, setTokenCode] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'mobile_money' | 'cash' | 'in_app_wallet'>('cash');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [showCelebration, setShowCelebration] = useState(false);

  const handleClose = () => {
    setTokenCode('');
    setPaymentMethod('cash');
    setResult(null);
    setShowCelebration(false);
    onOpenChange(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenCode.trim() || !profile?.id) return;

    if (tokenCode.trim().length !== 6) {
      toast({ title: 'Enter a valid 6-digit token', variant: 'destructive' });
      return;
    }

    setLoading(true);
    const { data, error } = await supabase.rpc('validate_and_record_collection', {
      p_token_code: tokenCode.trim(),
      p_payment_method: paymentMethod,
      p_agent_id: profile.id,
    });

    setLoading(false);
    if (error) {
      toast({ title: 'Payment failed', description: error.message, variant: 'destructive' });
      return;
    }

    const res = data as any;
    if (!res.success) {
      toast({ title: 'Payment failed', description: res.error, variant: 'destructive' });
      return;
    }

    setResult(res);
    // Show vouch celebration first; the existing summary follows on Continue.
    setShowCelebration(true);
    toast({ title: 'Payment recorded!' });
    // Optimistic broadcast — the celebration will fire a second event with
    // the precise delta once the audit row is read. Listeners debounce.
    emitVouchUpdated({
      agentId: profile.id,
      collectionId: res.collection_id,
      aiId: generateWelileAiId(profile.id),
    });
    onSuccess?.();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-5 w-5 text-success" />
            Record Payment
          </DialogTitle>
        </DialogHeader>

        {result && showCelebration ? (
          <CollectionVouchCelebration
            agentId={profile!.id}
            collectionId={result.collection_id}
            collectedAmount={Number(result.amount)}
            onOpenProfile={() => {
              if (profile?.id) navigate(`/profile/${generateWelileAiId(profile.id)}`);
              handleClose();
            }}
            onContinue={() => setShowCelebration(false)}
          />
        ) : result ? (
          <div className="text-center space-y-4 py-4">
            <div className="w-16 h-16 mx-auto bg-success/20 rounded-full flex items-center justify-center">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
            <h3 className="text-lg font-semibold">Payment Recorded!</h3>
            <div className="bg-secondary/50 rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-mono font-semibold">{formatUGX(result.amount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Method</span>
                <span className="capitalize">{result.payment_method.replace('_', ' ')}</span>
              </div>
              {result.payment_method === 'cash' && (
                <>
                  <div className="border-t pt-2 mt-2">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Float Before</span>
                      <span className="font-mono">{formatUGX(result.float_before)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Float After</span>
                      <span className="font-mono">{formatUGX(result.float_after)}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
            <Button onClick={handleClose} className="w-full h-12">Done</Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Payment Token (6 digits)</Label>
              <Input
                type="text"
                placeholder="e.g. 482913"
                value={tokenCode}
                onChange={(e) => setTokenCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="h-14 text-center text-2xl font-mono tracking-[0.3em]"
                maxLength={6}
                inputMode="numeric"
              />
            </div>

            <div className="space-y-3">
              <Label>Payment Method</Label>
              <RadioGroup
                value={paymentMethod}
                onValueChange={(v) => setPaymentMethod(v as any)}
                className="space-y-2"
              >
                {[
                  { value: 'cash', label: 'Cash', icon: Banknote, color: 'text-amber-600', desc: 'Deducts from float' },
                  { value: 'mobile_money', label: 'Mobile Money', icon: Smartphone, color: 'text-yellow-600', desc: 'MTN / Airtel' },
                  { value: 'in_app_wallet', label: 'In-App Wallet', icon: Wallet, color: 'text-success', desc: 'Welile balance' },
                ].map(opt => (
                  <Label
                    key={opt.value}
                    htmlFor={opt.value}
                    className={`flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${
                      paymentMethod === opt.value ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'
                    }`}
                  >
                    <RadioGroupItem value={opt.value} id={opt.value} className="sr-only" />
                    <opt.icon className={`h-5 w-5 ${opt.color}`} />
                    <div className="flex-1">
                      <p className="font-medium text-sm">{opt.label}</p>
                      <p className="text-xs text-muted-foreground">{opt.desc}</p>
                    </div>
                  </Label>
                ))}
              </RadioGroup>
            </div>

            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={handleClose} className="flex-1 h-12">Cancel</Button>
              <Button type="submit" disabled={loading || tokenCode.length !== 6} className="flex-1 h-12">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Record Payment'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
