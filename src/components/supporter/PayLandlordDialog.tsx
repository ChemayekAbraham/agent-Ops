import { useState, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  CreditCard, Phone, Upload, CheckCircle2, 
  Loader2, Building, AlertCircle, Camera
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX, calculateSupporterReward } from '@/lib/rentCalculations';
import { useToast } from '@/hooks/use-toast';
import { useConfetti } from '@/components/Confetti';

interface PayLandlordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: {
    id: string;
    rent_amount: number;
    duration_days: number;
    landlord: {
      id: string;
      name: string;
      phone: string;
      mobile_money_number: string | null;
    };
  } | null;
  onSuccess: () => void;
}

type PaymentMethod = 'mtn' | 'airtel';

export function PayLandlordDialog({ 
  open, 
  onOpenChange, 
  request,
  onSuccess 
}: PayLandlordDialogProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { fireSuccess } = useConfetti();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [step, setStep] = useState<'method' | 'details' | 'success'>('method');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const [transactionId, setTransactionId] = useState('');
  const [proofImage, setProofImage] = useState<File | null>(null);
  const [proofPreview, setProofPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reward = request ? calculateSupporterReward(Number(request.rent_amount)) : 0;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setProofImage(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setProofPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = async () => {
    if (!request || !user || !paymentMethod || !transactionId) return;
    
    setSubmitting(true);
    
    try {
      let proofImageUrl: string | null = null;
      
      // Upload proof image if provided
      if (proofImage) {
        const fileExt = proofImage.name.split('.').pop();
        const fileName = `${user.id}/${request.id}/${Date.now()}.${fileExt}`;
        
        const { error: uploadError } = await supabase.storage
          .from('payment-proofs')
          .upload(fileName, proofImage);
        
        if (uploadError) throw uploadError;
        
        const { data: signedUrlData } = await supabase.storage
          .from('payment-proofs')
          .createSignedUrl(fileName, 86400); // 24 hour expiry
        
        proofImageUrl = signedUrlData?.signedUrl || null;
      }
      
      // landlord_payment_proofs table removed - skip proof creation
      // Just update rent request status directly
      
      // Update rent request status
      await supabase
        .from('rent_requests')
        .update({
          supporter_id: user.id,
          status: 'funded',
          funded_at: new Date().toISOString()
        })
        .eq('id', request.id);
      
      // investment_accounts table removed - skip account creation
      
      // Notification removed - table dropped
      
      setStep('success');
      fireSuccess();
      
    } catch (error: any) {
      toast({
        title: 'Submission Failed',
        description: error.message,
        variant: 'destructive'
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (step === 'success') {
      onSuccess();
    }
    setStep('method');
    setPaymentMethod(null);
    setTransactionId('');
    setProofImage(null);
    setProofPreview(null);
    onOpenChange(false);
  };

  if (!request) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold">
            {step === 'success' ? 'Support Submitted!' : 'Pay Landlord'}
          </DialogTitle>
        </DialogHeader>

        {step === 'method' && (
          <div className="space-y-4">
            {/* Landlord Info */}
            <Card className="border-0 bg-primary/5">
              <CardContent className="p-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-full bg-primary/20">
                    <Building className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-bold">{request.landlord.name}</p>
                    <p className="text-sm text-muted-foreground">{request.landlord.mobile_money_number || request.landlord.phone}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Amount */}
            <div className="text-center py-3">
              <p className="text-sm text-muted-foreground">Amount to Pay</p>
              <p className="text-3xl font-black text-primary">{formatUGX(Number(request.rent_amount))}</p>
              <Badge variant="outline" className="mt-2 bg-success/10 text-success border-success/30">
                You'll earn {formatUGX(reward)}/month (15% ROI)
              </Badge>
            </div>

            {/* Payment Method Selection */}
            <div>
              <Label className="text-sm font-medium mb-2 block">Select Payment Method</Label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => setPaymentMethod('mtn')}
                  className={`p-4 rounded-xl border-2 transition-all ${
                    paymentMethod === 'mtn' 
                      ? 'border-yellow-500 bg-yellow-500/10' 
                      : 'border-border hover:border-yellow-500/50'
                  }`}
                >
                  <div className="text-center">
                    <div className="w-12 h-12 mx-auto mb-2 rounded-full bg-yellow-500 flex items-center justify-center">
                      <span className="text-black font-black text-lg">MTN</span>
                    </div>
                    <p className="font-bold text-sm">MTN MoMo</p>
                  </div>
                </button>
                <button
                  onClick={() => setPaymentMethod('airtel')}
                  className={`p-4 rounded-xl border-2 transition-all ${
                    paymentMethod === 'airtel' 
                      ? 'border-red-500 bg-red-500/10' 
                      : 'border-border hover:border-red-500/50'
                  }`}
                >
                  <div className="text-center">
                    <div className="w-12 h-12 mx-auto mb-2 rounded-full bg-red-500 flex items-center justify-center">
                      <span className="text-white font-black text-xs">Airtel</span>
                    </div>
                    <p className="font-bold text-sm">Airtel Money</p>
                  </div>
                </button>
              </div>
            </div>

            <Button 
              className="w-full h-11"
              disabled={!paymentMethod}
              onClick={() => setStep('details')}
            >
              Continue
            </Button>
          </div>
        )}

        {step === 'details' && (
          <div className="space-y-4">
            {/* Instructions */}
            <Card className="border-0 bg-warning/10">
              <CardContent className="p-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
                  <div className="text-xs">
                    <p className="font-bold text-warning">Payment Instructions</p>
                    <p className="text-muted-foreground mt-1">
                      1. Send {formatUGX(Number(request.rent_amount))} to <span className="font-mono font-bold">{request.landlord.mobile_money_number || request.landlord.phone}</span> via {paymentMethod?.toUpperCase()}
                    </p>
                    <p className="text-muted-foreground">
                      2. Enter your transaction ID below
                    </p>
                    <p className="text-muted-foreground">
                      3. Upload a screenshot of the payment confirmation
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Transaction ID */}
            <div>
              <Label className="text-sm font-medium">Transaction ID</Label>
              <Input
                value={transactionId}
                onChange={(e) => setTransactionId(e.target.value.toUpperCase())}
                placeholder="e.g. TXN123456789"
                className="mt-1 font-mono"
              />
            </div>

            {/* Proof Upload */}
            <div>
              <Label className="text-sm font-medium">Payment Proof (Screenshot)</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFileChange}
                className="hidden"
              />
              
              {proofPreview ? (
                <div className="mt-2 relative">
                  <img 
                    src={proofPreview} 
                    alt="Payment proof" 
                    className="w-full h-40 object-cover rounded-lg border"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="absolute bottom-2 right-2"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Camera className="h-4 w-4 mr-1" />
                    Change
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="w-full mt-2 h-24 border-dashed"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div className="text-center">
                    <Upload className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Tap to upload screenshot</p>
                  </div>
                </Button>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <Button 
                variant="outline" 
                className="flex-1"
                onClick={() => setStep('method')}
              >
                Back
              </Button>
              <Button 
                className="flex-1 bg-success hover:bg-success/90"
                disabled={!transactionId || submitting}
                onClick={handleSubmit}
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Submit Proof
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {step === 'success' && (
          <div className="text-center py-6">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-success/20 flex items-center justify-center">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
            <h3 className="text-xl font-bold mb-2">Support Submitted!</h3>
            <p className="text-muted-foreground text-sm mb-4">
              Your payment is being verified by our team. Once confirmed, you'll start earning 15% monthly returns on the {formatUGX(Number(request.rent_amount))} you supported.
            </p>
            
            {/* Support portfolio info */}
            <Card className="border-0 bg-primary/5 mb-3">
              <CardContent className="p-3">
                <p className="text-xs text-muted-foreground">Support Portfolio</p>
                <p className="font-bold text-primary">
                  Rent Funding - {new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  This support has been added to your portfolio
                </p>
              </CardContent>
            </Card>

            
            <Card className="border-0 bg-success/10">
              <CardContent className="p-3">
                <p className="text-sm font-medium text-success">Expected Monthly Reward</p>
                <p className="text-2xl font-black text-success">{formatUGX(reward)}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  First reward: 30 days from payment verification
                </p>
              </CardContent>
            </Card>
            <Button className="w-full mt-4" onClick={handleClose}>
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
