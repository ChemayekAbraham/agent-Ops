import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Upload, Loader2, Receipt, CheckCircle, Calendar, Clock, AlertCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { validateFormPayload, DEPOSIT_REQUEST_CONTRACT } from '@/lib/formContracts';
import { format, subDays, isAfter, isBefore, startOfDay } from 'date-fns';
import { safeDepositPurpose } from '@/lib/depositPurposeGuard';

interface PaymentConfirmationFormProps {
  dashboardType: 'tenant' | 'supporter';
  onSuccess?: () => void;
}

export default function PaymentConfirmationForm({ dashboardType, onSuccess }: PaymentConfirmationFormProps) {
  const { user } = useAuth();
  const [amount, setAmount] = useState('');
  const [partner, setPartner] = useState<'mtn' | 'airtel' | 'bank' | ''>('');
  const [transactionId, setTransactionId] = useState('');
  const [transactionDate, setTransactionDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [transactionTime, setTransactionTime] = useState(format(new Date(), 'HH:mm'));
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errorDetails, setErrorDetails] = useState<{
    title: string;
    message: string;
    code?: string;
    hint?: string;
    details?: string;
    raw?: string;
  } | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setScreenshot(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setScreenshotPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const validateTransactionDate = () => {
    const transactionDateTime = new Date(`${transactionDate}T${transactionTime}:00`);
    const now = new Date();
    const sevenDaysAgo = startOfDay(subDays(now, 7));
    
    if (isBefore(transactionDateTime, sevenDaysAgo)) {
      return { valid: false, message: 'Transaction date cannot be more than 7 days ago' };
    }
    if (isAfter(transactionDateTime, now)) {
      return { valid: false, message: 'Transaction date cannot be in the future' };
    }
    return { valid: true, message: '' };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorDetails(null);
    
    if (!user || !amount || !partner || !transactionId || !reason.trim()) {
      toast.error('Please fill in all required fields including reason');
      setErrorDetails({ title: 'Missing fields', message: 'Please fill in all required fields including reason.' });
      return;
    }

    const dateValidation = validateTransactionDate();
    if (!dateValidation.valid) {
      toast.error(dateValidation.message);
      return;
    }

    setIsSubmitting(true);

    try {
      let screenshotUrl = null;

      // Upload screenshot if provided
      if (screenshot) {
        const fileExt = screenshot.name.split('.').pop();
        const fileName = `${user.id}/${Date.now()}.${fileExt}`;
        
        const { error: uploadError } = await supabase.storage
          .from('reviews')
          .upload(fileName, screenshot);

        if (uploadError) {
          console.error('Upload error:', uploadError);
        } else {
          const { data: urlData } = supabase.storage
            .from('reviews')
            .getPublicUrl(fileName);
          screenshotUrl = urlData.publicUrl;
        }
      }

      // manager_recorded_transactions table removed - skip auto-verify
      const isAutoVerified = false;
      const foundMatch: any = null;
      const confirmationStatus = 'pending';

      // Combine date and time into a full timestamp
      const transactionDateTime = new Date(`${transactionDate}T${transactionTime}:00`);

      // Build payload with correct types
      const normalizedTransactionId = transactionId.trim().toUpperCase();

      const depositPayload = {
        user_id: user.id,
        amount: parseFloat(amount),
        transaction_id: normalizedTransactionId,
        transaction_date: transactionDateTime.toISOString(),
        provider: partner || null,
        notes: reason.trim(),
        deposit_purpose: safeDepositPurpose(
          dashboardType === 'supporter' ? 'partnership_deposit' : 'other',
        ),
      };

      // Contract-driven pre-submit validation
      const validation = validateFormPayload(DEPOSIT_REQUEST_CONTRACT, depositPayload as Record<string, unknown>);
      if (!validation.valid) {
        const msg = validation.errors.map(e => e.message).join('; ');
        toast.error(`Validation: ${msg}`);
        setErrorDetails({ title: 'Validation failed', message: msg });
        setIsSubmitting(false);
        return;
      }

      // Insert payment confirmation
      const { error } = await supabase
        .from('deposit_requests')
        .insert({
          ...depositPayload,
          status: confirmationStatus,
        } as any);


      if (error) throw error;

      setSubmitted(true);
      toast.success('Payment confirmation submitted! We\'ll verify shortly.');
      
      // Reset form after delay
      setTimeout(() => {
        setAmount('');
        setPartner('');
        setTransactionId('');
        setTransactionDate(format(new Date(), 'yyyy-MM-dd'));
        setTransactionTime(format(new Date(), 'HH:mm'));
        setScreenshot(null);
        setScreenshotPreview(null);
        setReason('');
        setSubmitted(false);
        onSuccess?.();
      }, 3000);

    } catch (error: any) {
      console.error('Error submitting payment:', error);
      const rawDump = (() => {
        try { return JSON.stringify(error, Object.getOwnPropertyNames(error), 2); } catch { return String(error); }
      })();
      const isDuplicateTid =
        error?.code === '23505' ||
        String(error?.message ?? '').toLowerCase().includes('duplicate transaction id');
      const title = isDuplicateTid
        ? 'This transaction ID has already been used'
        : (error?.message || 'Failed to submit payment confirmation');
      const description = isDuplicateTid
        ? 'Each telecom transaction ID can only be submitted once. Double-check the TID on your SMS or use a different payment.'
        : ([error?.code && `Code: ${error.code}`, error?.hint && `Hint: ${error.hint}`, error?.details && `Details: ${error.details}`]
            .filter(Boolean).join(' • ') || undefined);
      toast.error(title, { description, duration: 12000 });
      setErrorDetails({
        title: isDuplicateTid ? 'Duplicate transaction ID' : 'Submission failed',
        message: isDuplicateTid
          ? 'This TID was already submitted on an earlier deposit. Each TID can only be used once.'
          : (error?.message || 'Unknown error occurred while submitting deposit.'),
        code: error?.code,
        hint: error?.hint,
        details: error?.details,
        raw: rawDump,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <Card className="border-success/50 bg-success/5">
        <CardContent className="py-8 text-center">
          <CheckCircle className="w-16 h-16 text-success mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">Payment Submitted!</h3>
          <p className="text-muted-foreground">We'll verify your payment shortly.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Receipt className="w-5 h-5 text-primary" />
          Confirm Your Payment
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {errorDetails && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 space-y-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-destructive">{errorDetails.title}</p>
                  <p className="text-xs text-destructive/90 mt-0.5 break-words">{errorDetails.message}</p>
                  {(errorDetails.code || errorDetails.hint || errorDetails.details) && (
                    <div className="mt-1 text-[11px] text-destructive/80 space-y-0.5 font-mono break-words">
                      {errorDetails.code && <div>code: {errorDetails.code}</div>}
                      {errorDetails.hint && <div>hint: {errorDetails.hint}</div>}
                      {errorDetails.details && <div>details: {errorDetails.details}</div>}
                    </div>
                  )}
                  {errorDetails.raw && (
                    <details className="mt-2">
                      <summary className="text-[11px] text-destructive/80 cursor-pointer">Show raw error</summary>
                      <pre className="mt-1 text-[10px] bg-background/60 p-2 rounded overflow-auto max-h-48 whitespace-pre-wrap break-words">{errorDetails.raw}</pre>
                    </details>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="amount">Amount Paid (UGX) *</Label>
              <Input
                id="amount"
                type="number"
                placeholder="e.g. 50000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                min="1"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="partner">Payment Partner *</Label>
              <Select value={partner} onValueChange={(v) => setPartner(v as 'mtn' | 'airtel' | 'bank')}>
                <SelectTrigger>
                  <SelectValue placeholder="Select..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mtn">🟡 MTN MoMo</SelectItem>
                  <SelectItem value="airtel">🔴 Airtel Money</SelectItem>
                  <SelectItem value="bank">🏦 Bank Transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="transactionId">Transaction ID *</Label>
            <Input
              id="transactionId"
              placeholder="Enter transaction reference"
              value={transactionId}
              onChange={(e) => setTransactionId(e.target.value)}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="transactionDate" className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" />
                Transaction Date *
              </Label>
              <Input
                id="transactionDate"
                type="date"
                value={transactionDate}
                onChange={(e) => setTransactionDate(e.target.value)}
                min={format(subDays(new Date(), 7), 'yyyy-MM-dd')}
                max={format(new Date(), 'yyyy-MM-dd')}
                required
              />
              <p className="text-xs text-muted-foreground">Within last 7 days only</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="transactionTime" className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                Transaction Time *
              </Label>
              <Input
                id="transactionTime"
                type="time"
                value={transactionTime}
                onChange={(e) => setTransactionTime(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reason">Reason / Narration *</Label>
            <Input
              id="reason"
              type="text"
              placeholder="e.g. Rent repayment, Access fee, Wallet top-up"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="screenshot">Screenshot (Optional)</Label>
            <div className="flex items-center gap-3">
              <label className="flex-1 cursor-pointer">
                <div className="border-2 border-dashed rounded-lg p-4 text-center hover:bg-muted/50 transition-colors">
                  {screenshotPreview ? (
                    <img 
                      src={screenshotPreview} 
                      alt="Preview" 
                      className="max-h-24 mx-auto rounded"
                    />
                  ) : (
                    <>
                      <Upload className="w-6 h-6 mx-auto text-muted-foreground mb-1" />
                      <p className="text-xs text-muted-foreground">Tap to upload</p>
                    </>
                  )}
                </div>
                <input
                  id="screenshot"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </label>
              {screenshotPreview && (
                <Button 
                  type="button" 
                  variant="outline" 
                  size="sm"
                  onClick={() => {
                    setScreenshot(null);
                    setScreenshotPreview(null);
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>

          <Button 
            type="submit" 
            className="w-full" 
            size="lg"
            disabled={isSubmitting || !amount || !partner || !transactionId}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Submitting...
              </>
            ) : (
              'Submit Payment Confirmation'
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
