import { useState, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Camera, Upload, X, Receipt, Loader2, CheckCircle2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { motion, AnimatePresence } from '@/lib/motion-lite';

interface AgentReceiptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function AgentReceiptDialog({ open, onOpenChange, onSuccess }: AgentReceiptDialogProps) {
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [payerName, setPayerName] = useState('');
  const [payerPhone, setPayerPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [transactionId, setTransactionId] = useState('');
  const [notes, setNotes] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const resetForm = () => {
    setPayerName('');
    setPayerPhone('');
    setAmount('');
    setPaymentMethod('cash');
    setTransactionId('');
    setNotes('');
    setImageFile(null);
    setImagePreview(null);
    setSuccess(false);
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be under 5MB');
      return;
    }
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const handleSubmit = async () => {
    if (!user) return;
    if (!payerName.trim() || !payerPhone.trim() || !amount.trim()) {
      toast.error('Please fill in payer name, phone and amount');
      return;
    }
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      toast.error('Enter a valid amount');
      return;
    }

    setLoading(true);
    try {
      let receiptImageUrl: string | null = null;

      // Upload image if provided
      if (imageFile) {
        const ext = imageFile.name.split('.').pop() || 'jpg';
        const filePath = `${user.id}/${crypto.randomUUID()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from('agent-receipts')
          .upload(filePath, imageFile, { upsert: false });
        if (uploadError) throw new Error('Failed to upload receipt image');
        receiptImageUrl = filePath;
      }

      // Insert receipt record
      const { error } = await supabase.from('agent_receipts').insert({
        agent_id: user.id,
        payer_name: payerName.trim(),
        payer_phone: payerPhone.trim(),
        amount: numAmount,
        payment_method: paymentMethod,
        transaction_id: transactionId.trim() || null,
        receipt_image_url: receiptImageUrl,
        notes: notes.trim() || null,
      });

      if (error) throw error;

      setSuccess(true);
      toast.success('Receipt recorded successfully!');
      onSuccess?.();
      setTimeout(() => {
        resetForm();
        onOpenChange(false);
      }, 1500);
    } catch (err: any) {
      console.error('Receipt error:', err);
      toast.error(err.message || 'Failed to record receipt');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-primary" />
            Issue Cash Receipt
          </DialogTitle>
        </DialogHeader>

        <AnimatePresence mode="wait">
          {success ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="py-12 text-center space-y-3"
            >
              <CheckCircle2 className="h-16 w-16 text-success mx-auto" />
              <p className="font-bold text-lg">Receipt Recorded!</p>
              <p className="text-sm text-muted-foreground">
                UGX {Number(amount).toLocaleString()} from {payerName}
              </p>
            </motion.div>
          ) : (
            <motion.div key="form" className="space-y-4">
              {/* Payer Name */}
              <div className="space-y-1.5">
                <Label htmlFor="payerName">Payer Name *</Label>
                <Input
                  id="payerName"
                  placeholder="Who paid you?"
                  value={payerName}
                  onChange={(e) => setPayerName(e.target.value)}
                  style={{ fontSize: '16px' }}
                />
              </div>

              {/* Payer Phone */}
              <div className="space-y-1.5">
                <Label htmlFor="payerPhone">Payer Phone *</Label>
                <Input
                  id="payerPhone"
                  placeholder="0700000000"
                  value={payerPhone}
                  onChange={(e) => setPayerPhone(e.target.value)}
                  type="tel"
                  style={{ fontSize: '16px' }}
                />
              </div>

              {/* Amount */}
              <div className="space-y-1.5">
                <Label htmlFor="receiptAmount">Amount (UGX) *</Label>
                <Input
                  id="receiptAmount"
                  placeholder="50000"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
                  inputMode="numeric"
                  style={{ fontSize: '16px' }}
                />
              </div>

              {/* Payment Method */}
              <div className="space-y-1.5">
                <Label>Payment Method</Label>
                <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="mobile_money">Mobile Money</SelectItem>
                    <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Transaction ID (optional) */}
              {paymentMethod !== 'cash' && (
                <div className="space-y-1.5">
                  <Label htmlFor="txnId">Transaction ID</Label>
                  <Input
                    id="txnId"
                    placeholder="e.g. MP241234567890"
                    value={transactionId}
                    onChange={(e) => setTransactionId(e.target.value)}
                    style={{ fontSize: '16px' }}
                  />
                </div>
              )}

              {/* Receipt Image Upload */}
              <div className="space-y-1.5">
                <Label>Receipt Photo (optional)</Label>
                {imagePreview ? (
                  <div className="relative rounded-xl overflow-hidden border border-border">
                    <img src={imagePreview} alt="Receipt" className="w-full max-h-48 object-cover" />
                    <button
                      onClick={() => { setImageFile(null); setImagePreview(null); }}
                      className="absolute top-2 right-2 p-1.5 rounded-full bg-background/80 backdrop-blur"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full flex items-center justify-center gap-3 p-6 rounded-xl border-2 border-dashed border-border hover:border-primary/50 transition-colors text-muted-foreground"
                  >
                    <Camera className="h-6 w-6" />
                    <span className="text-sm font-medium">Tap to upload receipt photo</span>
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleImageSelect}
                  className="hidden"
                />
              </div>

              {/* Notes */}
              <div className="space-y-1.5">
                <Label htmlFor="receiptNotes">Notes (optional)</Label>
                <Textarea
                  id="receiptNotes"
                  placeholder="Any additional details..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  style={{ fontSize: '16px' }}
                />
              </div>

              {/* Submit */}
              <Button
                onClick={handleSubmit}
                disabled={loading || !payerName || !payerPhone || !amount}
                className="w-full h-12 text-base font-bold rounded-xl gap-2"
              >
                {loading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Receipt className="h-5 w-5" />
                )}
                {loading ? 'Recording...' : 'Record Receipt'}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
