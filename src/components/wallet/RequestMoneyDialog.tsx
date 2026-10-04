import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from '@/lib/motion-lite';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import {
  Loader2, HandCoins, Phone, Coins, FileText, Send,
  Contact, Nfc, ScanLine, ShieldCheck, XCircle, KeyRound,
} from 'lucide-react';
import type { Html5Qrcode as Html5QrcodeType } from 'html5-qrcode';
import { NfcTransactionResultDialog, type NfcResultPayload } from './NfcTransactionResultDialog';

interface RequestMoneyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

const formVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08, delayChildren: 0.1 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 15, scale: 0.98 },
  visible: { 
    opacity: 1, 
    y: 0, 
    scale: 1,
    transition: { type: 'spring' as const, stiffness: 300, damping: 25 }
  },
};

type TapStage = 'idle' | 'waiting' | 'processing' | 'pin' | 'success' | 'failed';

export function RequestMoneyDialog({ open, onOpenChange, onSuccess }: RequestMoneyDialogProps) {
  const { user } = useAuth();
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [recipientName, setRecipientName] = useState('');

  // Tap to Pay state
  const [tab, setTab] = useState<'contact' | 'tap'>('contact');
  const [tapMode, setTapMode] = useState<'tap' | 'scan'>('tap');
  const [tapAmount, setTapAmount] = useState('');
  const [tapReason, setTapReason] = useState('');
  const [tapStage, setTapStage] = useState<TapStage>('idle');
  const [tapError, setTapError] = useState<string | null>(null);
  const [tapPin, setTapPin] = useState('');
  const [pendingCard, setPendingCard] = useState<any>(null);
  const nfcAbortRef = useRef<AbortController | null>(null);
  const scannerRef = useRef<Html5QrcodeType | null>(null);
  const scannerElId = 'tap-qr-reader';
  const tapTimeoutRef = useRef<number | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [resultPayload, setResultPayload] = useState<NfcResultPayload | null>(null);

  const showResult = (payload: NfcResultPayload) => {
    setResultPayload(payload);
    setResultOpen(true);
  };

  const clearTapTimeout = () => {
    if (tapTimeoutRef.current) {
      clearTimeout(tapTimeoutRef.current);
      tapTimeoutRef.current = null;
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-UG', {
      style: 'currency',
      currency: 'UGX',
      minimumFractionDigits: 0,
    }).format(value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!user) {
      toast.error('Not authenticated');
      return;
    }

    const amountNum = parseFloat(amount);
    if (!phone || isNaN(amountNum) || amountNum <= 0) {
      toast.error('Please enter valid phone number and amount');
      return;
    }

    setLoading(true);

    const { data: recipientProfile, error: profileError } = await supabase
      .from('profiles')
      .select('id, full_name')
      .eq('phone', phone)
      .maybeSingle();

    if (profileError || !recipientProfile) {
      toast.error('User not found with this phone number');
      setLoading(false);
      return;
    }

    if (recipientProfile.id === user.id) {
      toast.error('Cannot request money from yourself');
      setLoading(false);
      return;
    }

    const { error } = await supabase
      .from('money_requests')
      .insert({
        requester_id: user.id,
        recipient_id: recipientProfile.id,
        amount: amountNum,
        description: description || `Money request from ${user.user_metadata?.full_name || 'a user'}`,
      });

    setLoading(false);

    if (error) {
      toast.error('Failed to create request');
      return;
    }

    setRecipientName(recipientProfile.full_name);
    setSuccess(true);
    toast.success(`Requested ${formatCurrency(amountNum)} from ${recipientProfile.full_name}`);
    
    setTimeout(() => {
      setPhone('');
      setAmount('');
      setDescription('');
      setSuccess(false);
      setRecipientName('');
      onOpenChange(false);
      onSuccess?.();
    }, 1500);
  };

  const stopScanner = async () => {
    try {
      if (scannerRef.current) {
        try { await scannerRef.current.stop(); } catch { /* ignore */ }
        try { scannerRef.current.clear(); } catch { /* ignore */ }
        scannerRef.current = null;
      }
    } catch { /* ignore */ }
  };

  const stopNfc = () => {
    try { nfcAbortRef.current?.abort(); } catch { /* ignore */ }
    nfcAbortRef.current = null;
    clearTapTimeout();
  };

  const resetTap = async () => {
    await stopScanner();
    stopNfc();
    setTapStage('idle');
    setTapError(null);
    setTapPin('');
    setPendingCard(null);
  };

  const processCard = async (card: any, pinValue?: string) => {
    const amt = Math.floor(Number(tapAmount));
    if (!amt || amt <= 0) {
      setTapError('Enter a valid amount first');
      setTapStage('failed');
      return;
    }
    setTapStage('processing');
    setTapError(null);
    try {
      const { data, error } = await supabase.functions.invoke('verify-nfc-card', {
        body: { card, amount: amt, pin: pinValue ?? null, reason: tapReason || null },
      });
      const payload: any = data;
      // Insufficient balance is returned with HTTP 402, surface as friendly popup
      if (payload?.error === 'INSUFFICIENT_BALANCE') {
        setTapStage('idle');
        showResult({
          status: 'insufficient',
          amount: amt,
          available: Number(payload.available ?? 0),
        });
        return;
      }
      if (error) throw error;
      if (payload?.pin_required) {
        setPendingCard(card);
        setTapStage('pin');
        return;
      }
      if (!payload?.success) {
        throw new Error(payload?.error || 'Payment failed');
      }
      setTapStage('idle');
      showResult({
        status: 'success',
        amount: amt,
        recipientName: payload.recipient_name,
        requestId: payload.request_id,
      });
      await resetTap();
      setTapAmount('');
      setTapReason('');
      onSuccess?.();
    } catch (e: any) {
      const msg = e?.context?.error || e?.message || 'Card verification failed';
      // If edge function returned 401 with pin_required in body
      if (typeof msg === 'string' && msg.toLowerCase().includes('pin required')) {
        setPendingCard(card);
        setTapStage('pin');
        setTapError(null);
        return;
      }
      const errText = typeof msg === 'string' ? msg : 'Card verification failed';
      setTapError(errText);
      setTapStage('idle');
      showResult({ status: 'failed', amount: amt, errorMessage: errText });
    }
  };

  const startNfcTap = async () => {
    const amt = Math.floor(Number(tapAmount));
    if (!amt || amt <= 0) {
      toast.error('Enter a valid amount first');
      return;
    }
    setTapError(null);
    setTapStage('waiting');

    // @ts-ignore — NDEFReader is experimental
    const NDEF = (window as any).NDEFReader;
    if (!NDEF) {
      // Fallback: simulate after delay so the flow is still testable on non-NFC devices
      setTimeout(() => {
        setTapError('NFC not supported on this device. Use Scan to Pay instead.');
        setTapStage('failed');
      }, 1200);
      return;
    }
    try {
      const reader = new NDEF();
      const ctrl = new AbortController();
      nfcAbortRef.current = ctrl;
      await reader.scan({ signal: ctrl.signal });
      // 30s safety timeout — surface a clear "no card detected" instead of spinning forever
      tapTimeoutRef.current = window.setTimeout(() => {
        stopNfc();
        setTapStage('idle');
        showResult({
          status: 'failed',
          amount: amt,
          errorMessage: 'No card detected. Hold the card flat against the back of your phone and try again.',
        });
      }, 30000);
      reader.onreading = (event: any) => {
        try {
          const decoder = new TextDecoder();
          let text = '';
          // Iterate ALL records and accept text / mime / unknown / url payloads
          for (const record of event.message.records) {
            try {
              const decoded = decoder.decode(record.data);
              if (!decoded) continue;
              if (record.recordType === 'text' || record.recordType === 'mime' || record.recordType === 'unknown') {
                text = decoded; break;
              }
              if (record.recordType === 'url' && decoded.startsWith('{')) {
                text = decoded; break;
              }
            } catch { /* try next record */ }
          }
          if (!text) throw new Error('No readable record on card');
          // Strip any UTF-8 BOM / language prefix bytes that some text records prepend
          const firstBrace = text.indexOf('{');
          if (firstBrace > 0) text = text.slice(firstBrace);
          console.log('[NFC] decoded payload:', text);
          const card = JSON.parse(text);
          stopNfc();
          processCard(card);
        } catch {
          stopNfc();
          setTapStage('idle');
          showResult({
            status: 'failed',
            amount: amt,
            errorMessage: 'Could not read this card. It may not be a Welile card or the payload is corrupted.',
          });
        }
      };
      reader.onreadingerror = () => {
        stopNfc();
        setTapStage('idle');
        showResult({ status: 'failed', amount: amt, errorMessage: 'Failed to read card. Try tapping again.' });
      };
    } catch (e: any) {
      setTapError(e?.message || 'NFC permission denied');
      setTapStage('failed');
      showResult({ status: 'failed', amount: amt, errorMessage: e?.message || 'NFC permission denied' });
    }
  };

  const startQrScan = async () => {
    const amt = Math.floor(Number(tapAmount));
    if (!amt || amt <= 0) {
      toast.error('Enter a valid amount first');
      return;
    }
    setTapError(null);
    setTapStage('waiting');
    // Wait next tick so the reader element is in the DOM
    setTimeout(async () => {
      try {
        const el = document.getElementById(scannerElId);
        if (!el) throw new Error('Scanner not ready');
        // Loaded on demand — keeps the ~330 KB scanner bundle out of the
        // wallet's initial chunk.
        const { Html5Qrcode } = await import('html5-qrcode');
        const scanner = new Html5Qrcode(scannerElId);
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 220, height: 220 } },
          async (decoded) => {
            try {
              const card = JSON.parse(decoded);
              await stopScanner();
              processCard(card);
            } catch {
              await stopScanner();
              setTapError('Invalid QR code');
              setTapStage('failed');
            }
          },
          () => { /* ignore frame errors */ }
        );
      } catch (e: any) {
        setTapError(e?.message || 'Camera permission denied');
        setTapStage('failed');
      }
    }, 100);
  };

  const submitPin = async () => {
    if (!/^\d{4,6}$/.test(tapPin)) {
      setTapError('PIN must be 4-6 digits');
      return;
    }
    if (!pendingCard) return;
    await processCard(pendingCard, tapPin);
  };

  useEffect(() => {
    if (!open) {
      resetTap();
    }
    return () => { stopScanner(); stopNfc(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleClose = (value: boolean) => {
    if (!value) {
      setPhone('');
      setAmount('');
      setDescription('');
      setSuccess(false);
      setRecipientName('');
      setTapAmount('');
      setTapReason('');
      resetTap();
    }
    onOpenChange(value);
  };

  return (
    <>
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto border-border/50 glass-card">
        <div className="absolute inset-0 bg-gradient-to-br from-accent/5 via-transparent to-primary/5 pointer-events-none" />
        
        <AnimatePresence mode="wait">
          {success ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="py-12 flex flex-col items-center justify-center relative"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring' as const, stiffness: 300, damping: 20, delay: 0.1 }}
                className="w-20 h-20 rounded-full bg-primary/20 flex items-center justify-center mb-4"
              >
                <Send className="h-10 w-10 text-primary" />
              </motion.div>
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="text-lg font-semibold"
              >
                Request Sent!
              </motion.p>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="text-muted-foreground text-sm text-center"
              >
                {recipientName} will be notified to approve your request
              </motion.p>
            </motion.div>
          ) : (
            <motion.div
              key="form"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="relative"
            >
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <motion.div
                    className="p-2 rounded-lg bg-accent/10"
                    whileHover={{ scale: 1.1, rotate: -5 }}
                    transition={{ type: 'spring' as const, stiffness: 400, damping: 17 }}
                  >
                    <HandCoins className="h-5 w-5 text-accent" />
                  </motion.div>
                  Request Money
                </DialogTitle>
                <DialogDescription>
                  Request from a contact, or charge a Welile NFC card directly.
                </DialogDescription>
              </DialogHeader>

              <Tabs value={tab} onValueChange={(v) => setTab(v as 'contact' | 'tap')} className="mt-4">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="contact" className="gap-2">
                    <Contact className="h-4 w-4" /> Contact
                  </TabsTrigger>
                  <TabsTrigger value="tap" className="gap-2">
                    <Nfc className="h-4 w-4" /> Tap to Pay
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="contact" className="mt-4">
              <motion.form 
                onSubmit={handleSubmit} 
                className="space-y-4"
                variants={formVariants}
                initial="hidden"
                animate="visible"
              >
                <motion.div variants={itemVariants} className="space-y-2">
                  <Label htmlFor="phone" className="flex items-center gap-2">
                    <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                    Their Phone Number
                  </Label>
                  <Input
                    id="phone"
                    type="tel"
                    placeholder="e.g. 0783673998"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="bg-background/50 border-border/50 focus:border-primary/50 transition-all"
                    required
                  />
                </motion.div>

                <motion.div variants={itemVariants} className="space-y-2">
                  <Label htmlFor="amount" className="flex items-center gap-2">
                    <Coins className="h-3.5 w-3.5 text-muted-foreground" />
                    Amount (UGX)
                  </Label>
                  <Input
                    id="amount"
                    type="number"
                    placeholder="Enter amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="bg-background/50 border-border/50 focus:border-primary/50 transition-all text-lg font-medium"
                    min="1"
                    required
                  />
                </motion.div>

                <motion.div variants={itemVariants} className="space-y-2">
                  <Label htmlFor="description" className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    Reason (Optional)
                  </Label>
                  <Textarea
                    id="description"
                    placeholder="What's this for?"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="bg-background/50 border-border/50 focus:border-primary/50 transition-all resize-none"
                    rows={2}
                  />
                </motion.div>

                <motion.div variants={itemVariants}>
                  <DialogFooter className="gap-2 sm:gap-0">
                    <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                      <Button type="button" variant="outline" onClick={() => handleClose(false)}>
                        Cancel
                      </Button>
                    </motion.div>
                    <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                      <Button type="submit" disabled={loading} className="gap-2">
                        {loading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <HandCoins className="h-4 w-4" />
                        )}
                        Send Request
                      </Button>
                    </motion.div>
                  </DialogFooter>
                </motion.div>
              </motion.form>
                </TabsContent>

                <TabsContent value="tap" className="mt-4 space-y-4">
                  {/* Amount + reason */}
                  <div className="space-y-2">
                    <Label htmlFor="tap-amount" className="flex items-center gap-2">
                      <Coins className="h-3.5 w-3.5 text-muted-foreground" />
                      Amount (UGX)
                    </Label>
                    <Input
                      id="tap-amount"
                      type="number"
                      min={1}
                      placeholder="Enter amount"
                      value={tapAmount}
                      onChange={(e) => setTapAmount(e.target.value)}
                      disabled={tapStage !== 'idle' && tapStage !== 'failed'}
                      className="bg-background/50 border-border/50 text-lg font-medium"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tap-reason" className="flex items-center gap-2">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                      Reason (Optional)
                    </Label>
                    <Input
                      id="tap-reason"
                      placeholder="What's this for?"
                      value={tapReason}
                      onChange={(e) => setTapReason(e.target.value)}
                      disabled={tapStage !== 'idle' && tapStage !== 'failed'}
                      className="bg-background/50 border-border/50"
                    />
                  </div>

                  {/* Mode selector */}
                  {(tapStage === 'idle' || tapStage === 'failed') && (
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        type="button"
                        variant={tapMode === 'tap' ? 'default' : 'outline'}
                        onClick={async () => {
                          await resetTap();
                          setTapMode('tap');
                        }}
                        className="gap-2"
                      >
                        <Nfc className="h-4 w-4" /> Tap to Pay
                      </Button>
                      <Button
                        type="button"
                        variant={tapMode === 'scan' ? 'default' : 'outline'}
                        onClick={async () => {
                          await resetTap();
                          setTapMode('scan');
                        }}
                        className="gap-2"
                      >
                        <ScanLine className="h-4 w-4" /> Scan to Pay
                      </Button>
                    </div>
                  )}

                  {/* Stage UI */}
                  <div className="rounded-lg border border-border/50 bg-background/40 p-4 min-h-[180px] flex flex-col items-center justify-center text-center">
                    {tapStage === 'idle' && (
                      <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">
                          {tapMode === 'tap'
                            ? 'Hold the NFC card against the back of your phone after starting.'
                            : 'Point your camera at the card QR code after starting.'}
                        </p>
                        <Button
                          type="button"
                          onClick={tapMode === 'tap' ? startNfcTap : startQrScan}
                          className="gap-2"
                        >
                          {tapMode === 'tap' ? <Nfc className="h-4 w-4" /> : <ScanLine className="h-4 w-4" />}
                          Start {tapMode === 'tap' ? 'Tap' : 'Scan'}
                        </Button>
                      </div>
                    )}

                    {tapStage === 'waiting' && tapMode === 'tap' && (
                      <div className="space-y-3 flex flex-col items-center">
                        <motion.div
                          animate={{ scale: [1, 1.15, 1], opacity: [0.6, 1, 0.6] }}
                          transition={{ repeat: Infinity, duration: 1.4 }}
                          className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center"
                        >
                          <Nfc className="h-8 w-8 text-primary" />
                        </motion.div>
                        <p className="text-sm font-medium">Waiting for card…</p>
                        <p className="text-xs text-muted-foreground">Tap the card to the back of your phone</p>
                      </div>
                    )}

                    {tapStage === 'waiting' && tapMode === 'scan' && (
                      <div className="w-full space-y-2">
                        <div id={scannerElId} className="w-full rounded-md overflow-hidden" />
                        <p className="text-xs text-muted-foreground">Align the QR inside the frame</p>
                      </div>
                    )}

                    {tapStage === 'processing' && (
                      <div className="space-y-3 flex flex-col items-center">
                        <Loader2 className="h-10 w-10 text-primary animate-spin" />
                        <p className="text-sm font-medium">Processing payment…</p>
                      </div>
                    )}

                    {tapStage === 'pin' && (
                      <div className="w-full space-y-3">
                        <div className="flex items-center justify-center gap-2 text-warning">
                          <KeyRound className="h-5 w-5" />
                          <p className="text-sm font-medium">PIN required for this amount</p>
                        </div>
                        <Input
                          inputMode="numeric"
                          pattern="\d*"
                          maxLength={6}
                          autoFocus
                          placeholder="Enter card PIN"
                          value={tapPin}
                          onChange={(e) => setTapPin(e.target.value.replace(/\D/g, ''))}
                          className="text-center text-lg tracking-[0.5em]"
                        />
                        {tapError && <p className="text-xs text-destructive">{tapError}</p>}
                        <Button type="button" onClick={submitPin} className="w-full gap-2">
                          <ShieldCheck className="h-4 w-4" /> Verify & Pay
                        </Button>
                      </div>
                    )}

                    {tapStage === 'success' && (
                      <div className="space-y-3 flex flex-col items-center">
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          transition={{ type: 'spring' as const, stiffness: 300, damping: 18 }}
                          className="w-16 h-16 rounded-full bg-success/20 flex items-center justify-center"
                        >
                          <ShieldCheck className="h-8 w-8 text-success" />
                        </motion.div>
                        <p className="text-sm font-semibold">Payment Successful</p>
                        <p className="text-xs text-muted-foreground">
                          Charged {formatCurrency(Math.floor(Number(tapAmount) || 0))}
                        </p>
                      </div>
                    )}

                    {tapStage === 'failed' && (
                      <div className="space-y-3 flex flex-col items-center">
                        <div className="w-16 h-16 rounded-full bg-destructive/20 flex items-center justify-center">
                          <XCircle className="h-8 w-8 text-destructive" />
                        </div>
                        <p className="text-sm font-semibold">Payment Failed</p>
                        {tapError && <p className="text-xs text-muted-foreground">{tapError}</p>}
                        <Button type="button" variant="outline" size="sm" onClick={resetTap}>
                          Try Again
                        </Button>
                      </div>
                    )}
                  </div>

                  <DialogFooter className="gap-2 sm:gap-0">
                    <Button type="button" variant="outline" onClick={() => handleClose(false)}>
                      Close
                    </Button>
                  </DialogFooter>
                </TabsContent>
              </Tabs>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
    <NfcTransactionResultDialog
      open={resultOpen}
      onOpenChange={setResultOpen}
      result={resultPayload}
      onRetry={() => { setTapStage('idle'); }}
    />
    </>
  );
}
