import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Loader2, MessageCircle, Image as ImageIcon, FileText, Copy, CheckCircle2, ExternalLink,
  ArrowLeft, Eye, ShieldCheck, RotateCw, AlertTriangle, Phone, Check, CheckCheck, Send,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { createShortLink } from '@/lib/createShortLink';
import { formatUGX } from '@/lib/rentCalculations';
import type { RentAccessLimitResult } from '@/lib/rentAccessLimit';
import { generateRentAccessLimitPdf, generateRentAccessLimitPng } from '@/lib/rentAccessLimitPdf';
import { supabase } from '@/integrations/supabase/client';
import { recordRentAccessShare } from '@/lib/rentAccessShareAudit';
import { getPublicOrigin } from '@/lib/getPublicOrigin';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tenantId: string;
  tenantName: string;
  tenantPhone: string;
  aiId?: string;
  result: RentAccessLimitResult;
}

function toIntlPhone(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('256')) return digits;
  if (digits.startsWith('0')) return '256' + digits.slice(1);
  return digits;
}

export function RentAccessLimitShareDialog({
  open,
  onOpenChange,
  tenantId,
  tenantName,
  tenantPhone,
  aiId,
  result,
}: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pngLoading, setPngLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // Snapshot of the message at the moment the preview was built, so the send
  // action uses the exact text the user saw — even if shareUrl/result changes.
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendAttempts, setSendAttempts] = useState(0);
  const [smsSending, setSmsSending] = useState(false);

  // Reset preview whenever the dialog closes / inputs change
  useEffect(() => {
    if (!open) {
      setPreviewing(false);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setPreviewBlob(null);
      setPreviewMessage(null);
      setSendError(null);
      setSendAttempts(0);
      setSending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Build the WhatsApp / share short link as soon as the dialog opens
  useEffect(() => {
    if (!open || !user || shareUrl) return;
    let cancelled = false;
    (async () => {
      setLinkLoading(true);
      try {
        const url = await createShortLink(user.id, '/limit', { t: tenantId });
        if (!cancelled) setShareUrl(url);
      } catch {
        // Fallback: direct URL if short-link creation fails
        if (!cancelled) setShareUrl(`${getPublicOrigin()}/limit/${tenantId}`);
      } finally {
        if (!cancelled) setLinkLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, user, tenantId, shareUrl]);

  const pct = result.netAdjustmentPct * 100;
  const message =
    `🏠 *Welile — Rent Money You Can Get*\n\n` +
    `Hello ${tenantName.split(' ')[0]},\n` +
    `Good news! Welile can pay rent for you up to:\n\n` +
    `💜 *${formatUGX(result.limit)}*\n\n` +
    `This is real money you can use for your rent today.\n\n` +
    `📈 You are at ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% because of your daily payments\n` +
    `✅ Days paid on time: ${result.paidDays}\n` +
    `⚠️ Days missed: ${result.missedDays}\n\n` +
    `👉 Pay rent today and tomorrow we can give you *+${formatUGX(Math.abs(result.todayChange))}* more.\n` +
    `The more you pay, the more rent money Welile gives you.\n` +
    (shareUrl ? `\nSee your live limit: ${shareUrl}` : '');

  const openWhatsApp = () => {
    const intl = toIntlPhone(tenantPhone);
    const url = intl
      ? `https://wa.me/${intl}?text=${encodeURIComponent(message)}`
      : `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    if (user) {
      void recordRentAccessShare({
        agentId: user.id,
        tenantId,
        tenantName,
        tenantPhone,
        channel: 'whatsapp',
        limitAmount: result.limit,
        shareUrl,
        messageSnapshot: message,
        metadata: { hasPhone: Boolean(intl) },
      });
    }
  };

  /** Step 1 — generate the card image and show preview. */
  const buildPreview = async () => {
    setPngLoading(true);
    try {
      const blob = await generateRentAccessLimitPng({
        tenantName,
        tenantPhone,
        aiId,
        monthlyRent: result.base / 12,
        result,
        shareUrl,
      });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = URL.createObjectURL(blob);
      setPreviewBlob(blob);
      setPreviewUrl(url);
      setPreviewMessage(message);
      setPreviewing(true);
      if (user) {
        void recordRentAccessShare({
          agentId: user.id,
          tenantId,
          tenantName,
          tenantPhone,
          channel: 'whatsapp_preview',
          limitAmount: result.limit,
          shareUrl,
          messageSnapshot: message,
        });
      }
    } catch (err: any) {
      toast({ title: 'Preview failed', description: err.message, variant: 'destructive' });
    } finally {
      setPngLoading(false);
    }
  };

  /** Step 2 — user confirmed the preview, actually send to WhatsApp. */
  const confirmAndShare = async () => {
    if (!previewBlob || !previewMessage) return;
    setSending(true);
    setSendError(null);
    setSendAttempts(n => n + 1);
    const file = new File(
      [previewBlob],
      `rent-access-${tenantName.replace(/\s+/g, '-').toLowerCase()}.png`,
      { type: 'image/png' },
    );
    try {
      const navAny = navigator as any;
      if (navAny.canShare && navAny.canShare({ files: [file] })) {
        try {
          await navAny.share({
            files: [file],
            title: 'Rent Access Limit',
            text: previewMessage,
          });
          toast({ title: 'Ready to share' });
          if (user) {
            void recordRentAccessShare({
              agentId: user.id,
              tenantId,
              tenantName,
              tenantPhone,
              channel: 'native_share',
              limitAmount: result.limit,
              shareUrl,
              messageSnapshot: previewMessage,
              metadata: { attempt: sendAttempts + 1 },
            });
          }
          return;
        } catch (err: any) {
          // User cancelled — not an error, just stop quietly
          if (err?.name === 'AbortError') return;
          // Genuine share failure — fall through to wa.me fallback
        }
      }

      // Fallback: download the snapshot image and open WhatsApp chat
      const url = URL.createObjectURL(previewBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);

      const intl = toIntlPhone(tenantPhone);
      const waUrl = intl
        ? `https://wa.me/${intl}?text=${encodeURIComponent(previewMessage)}`
        : `https://wa.me/?text=${encodeURIComponent(previewMessage)}`;
      const win = window.open(waUrl, '_blank', 'noopener,noreferrer');
      if (!win) {
        // Popup blocked — surface as a retryable error
        throw new Error('WhatsApp window was blocked. Allow popups and retry.');
      }
      toast({
        title: 'Image saved',
        description: 'Attach it in the WhatsApp chat that just opened.',
      });
      if (user) {
        void recordRentAccessShare({
          agentId: user.id,
          tenantId,
          tenantName,
          tenantPhone,
          channel: 'whatsapp',
          limitAmount: result.limit,
          shareUrl,
          messageSnapshot: previewMessage,
          metadata: { fallback: 'wa.me+download', hasPhone: Boolean(intl), attempt: sendAttempts + 1 },
        });
      }
    } catch (err: any) {
      const msg = err?.message || 'Could not open WhatsApp. Please try again.';
      setSendError(msg);
      toast({ title: 'Share failed', description: msg, variant: 'destructive' });
      if (user) {
        void recordRentAccessShare({
          agentId: user.id,
          tenantId,
          tenantName,
          tenantPhone,
          channel: 'whatsapp',
          limitAmount: result.limit,
          shareUrl,
          messageSnapshot: previewMessage,
          success: false,
          errorMessage: msg,
          metadata: { attempt: sendAttempts + 1 },
        });
      }
    } finally {
      setSending(false);
    }
  };

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast({ title: 'Copied to clipboard' });
      if (user) {
        void recordRentAccessShare({
          agentId: user.id,
          tenantId,
          tenantName,
          tenantPhone,
          channel: 'copy_link',
          limitAmount: result.limit,
          shareUrl,
          messageSnapshot: message,
        });
      }
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  const downloadPng = async () => {
    setPngLoading(true);
    try {
      const blob = await generateRentAccessLimitPng({
        tenantName,
        tenantPhone,
        aiId,
        monthlyRent: result.base / 12,
        result,
        shareUrl,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rent-access-${tenantName.replace(/\s+/g, '-').toLowerCase()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast({ title: 'Image saved', description: 'Share it on WhatsApp from your gallery.' });
      if (user) {
        void recordRentAccessShare({
          agentId: user.id,
          tenantId,
          tenantName,
          tenantPhone,
          channel: 'image_download',
          limitAmount: result.limit,
          shareUrl,
        });
      }
    } catch (err: any) {
      toast({ title: 'Image generation failed', description: err.message, variant: 'destructive' });
      if (user) {
        void recordRentAccessShare({
          agentId: user.id,
          tenantId,
          tenantName,
          tenantPhone,
          channel: 'image_download',
          limitAmount: result.limit,
          shareUrl,
          success: false,
          errorMessage: err?.message ?? 'unknown',
        });
      }
    } finally {
      setPngLoading(false);
    }
  };

  const downloadPdf = async () => {
    setPdfLoading(true);
    try {
      const blob = await generateRentAccessLimitPdf({
        tenantName,
        tenantPhone,
        aiId,
        monthlyRent: result.base / 12,
        result,
        shareUrl,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rent-access-certificate-${tenantName.replace(/\s+/g, '-').toLowerCase()}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast({ title: 'Certificate downloaded' });
      if (user) {
        void recordRentAccessShare({
          agentId: user.id,
          tenantId,
          tenantName,
          tenantPhone,
          channel: 'pdf_download',
          limitAmount: result.limit,
          shareUrl,
        });
      }
    } catch (err: any) {
      toast({ title: 'PDF generation failed', description: err.message, variant: 'destructive' });
      if (user) {
        void recordRentAccessShare({
          agentId: user.id,
          tenantId,
          tenantName,
          tenantPhone,
          channel: 'pdf_download',
          limitAmount: result.limit,
          shareUrl,
          success: false,
          errorMessage: err?.message ?? 'unknown',
        });
      }
    } finally {
      setPdfLoading(false);
    }
  };

  /** Send a short SMS to the tenant linking to their branded card. */
  const sendSms = async () => {
    if (!tenantPhone) {
      toast({
        title: 'No phone on file',
        description: 'Add a phone number for this tenant first.',
        variant: 'destructive',
      });
      return;
    }
    setSmsSending(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'send-rent-access-sms',
        {
          body: {
            tenant_id: tenantId,
            tenant_name: tenantName,
            tenant_phone: tenantPhone,
            share_url: shareUrl,
            limit_amount: result.limit,
            mode: 'manual',
          },
        },
      );
      if (error) throw error;
      if (!data?.success) throw new Error('Carrier did not accept the SMS.');
      toast({
        title: 'SMS sent',
        description: `${tenantName.split(' ')[0]} will get the branded card link by text.`,
      });
      if (user) {
        void recordRentAccessShare({
          agentId: user.id,
          tenantId,
          tenantName,
          tenantPhone,
          channel: 'sms',
          limitAmount: result.limit,
          shareUrl,
          metadata: { mode: 'manual' },
        });
      }
    } catch (err: any) {
      toast({
        title: 'SMS failed',
        description: err?.message || 'Could not send SMS. Please retry.',
        variant: 'destructive',
      });
      if (user) {
        void recordRentAccessShare({
          agentId: user.id,
          tenantId,
          tenantName,
          tenantPhone,
          channel: 'sms',
          limitAmount: result.limit,
          shareUrl,
          success: false,
          errorMessage: err?.message ?? 'unknown',
          metadata: { mode: 'manual' },
        });
      }
    } finally {
      setSmsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {previewing && (
              <button
                type="button"
                onClick={() => setPreviewing(false)}
                className="h-7 w-7 -ml-1 rounded-md hover:bg-muted flex items-center justify-center"
                aria-label="Back to share options"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            {previewing ? 'WhatsApp preview' : 'Share Rent Access Limit'}
          </DialogTitle>
          <DialogDescription>
            {previewing
              ? `This is exactly what ${tenantName.split(' ')[0]} will receive on WhatsApp.`
              : `Send ${tenantName.split(' ')[0]} their current limit and motivate daily payments.`}
          </DialogDescription>
        </DialogHeader>

        {previewing && previewUrl ? (
          <>
            {/* WhatsApp-styled preview pane — mirrors the actual chat layout */}
            <div className="rounded-xl overflow-hidden border border-border/60 shadow-sm">
              {/* Chat header */}
              <div className="flex items-center gap-2.5 bg-[#075E54] text-white px-3 py-2">
                <div className="h-8 w-8 rounded-full bg-white/20 flex items-center justify-center text-sm font-bold">
                  {tenantName.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold leading-tight truncate">{tenantName}</p>
                  <p className="text-[10px] text-white/75 leading-tight flex items-center gap-1">
                    <Phone className="h-2.5 w-2.5" /> {tenantPhone || 'no phone on file'}
                  </p>
                </div>
                <span className="text-[9px] uppercase tracking-wider bg-white/15 rounded px-1.5 py-0.5 font-bold">
                  Preview
                </span>
              </div>

              {/* Chat body — WhatsApp light beige background */}
              <div className="bg-[#ECE5DD] dark:bg-[#0b141a] p-3 space-y-2 max-h-[420px] overflow-y-auto">
                {/* Outgoing bubble: PNG attachment */}
                <div className="flex justify-end">
                  <div className="max-w-[85%] bg-[#DCF8C6] dark:bg-[#005c4b] rounded-lg rounded-tr-sm shadow-sm p-1.5">
                    <img
                      src={previewUrl}
                      alt="Rent access limit card preview"
                      className="rounded-md w-full h-auto"
                    />
                    <div className="flex items-center justify-end gap-1 px-1.5 pt-1 pb-0.5">
                      <span className="text-[9px] text-foreground/50 dark:text-white/60">
                        {new Date().toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <CheckCheck className="h-3 w-3 text-[#34B7F1]" />
                    </div>
                  </div>
                </div>

                {/* Outgoing bubble: text message */}
                <div className="flex justify-end">
                  <div className="max-w-[85%] bg-[#DCF8C6] dark:bg-[#005c4b] rounded-lg rounded-tr-sm shadow-sm px-2.5 py-1.5">
                    <p className="text-[12px] whitespace-pre-line text-foreground dark:text-white leading-snug">
                      {previewMessage ?? message}
                    </p>
                    <div className="flex items-center justify-end gap-1 pt-0.5">
                      <span className="text-[9px] text-foreground/50 dark:text-white/60">
                        {new Date().toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <Check className="h-3 w-3 text-foreground/40 dark:text-white/50" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Snapshot indicator — proves the send action will use this exact text */}
            <div
              className="flex items-center gap-1.5 text-[11px] text-success font-medium"
              role="status"
              aria-live="polite"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {previewMessage
                ? 'Uses preview snapshot — sent text will match exactly'
                : 'Locking snapshot…'}
            </div>

            {/* Retry banner — appears only when the previous send call failed */}
            {sendError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs"
              >
                <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-destructive">Couldn't open WhatsApp</p>
                  <p className="text-destructive/90 leading-snug">{sendError}</p>
                  <p className="text-muted-foreground mt-1">
                    Same snapshot will be reused — nothing is regenerated.
                  </p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-2">
              <Button
                onClick={confirmAndShare}
                disabled={!previewMessage || !previewBlob || sending}
                className="h-12 rounded-xl gap-2 font-bold bg-success hover:bg-success/90 text-success-foreground"
                size="lg"
              >
                {sending ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : sendError ? (
                  <RotateCw className="h-5 w-5" />
                ) : (
                  <MessageCircle className="h-5 w-5" />
                )}
                {sending
                  ? 'Opening WhatsApp…'
                  : sendError
                    ? `Retry send${sendAttempts > 1 ? ` (attempt ${sendAttempts + 1})` : ''}`
                    : 'Looks good — send on WhatsApp'}
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  onClick={() => setPreviewing(false)}
                  className="h-11 rounded-xl gap-2"
                >
                  <ArrowLeft className="h-4 w-4" /> Edit
                </Button>
                <Button
                  variant="outline"
                  onClick={copyMessage}
                  className="h-11 rounded-xl gap-2"
                >
                  {copied ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                  Copy text
                </Button>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Message preview */}
            <div className="rounded-xl border bg-muted/40 p-3 text-xs whitespace-pre-line max-h-40 overflow-y-auto">
              {message}
            </div>

            {/* Link row */}
            <div className="flex items-center gap-2 rounded-xl bg-background border p-2.5 text-xs">
          <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="truncate flex-1 font-mono text-muted-foreground">
            {linkLoading ? 'Generating link…' : shareUrl ?? '—'}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2"
            onClick={copyMessage}
            disabled={!shareUrl}
            aria-label="Copy message with link"
          >
            {copied ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          </Button>
            </div>

            {/* Actions */}
            <div className="grid grid-cols-1 gap-2">
              <Button
                onClick={buildPreview}
                disabled={pngLoading}
                className="h-12 rounded-xl gap-2 font-bold bg-success hover:bg-success/90 text-success-foreground"
                size="lg"
              >
                {pngLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Eye className="h-5 w-5" />}
                {pngLoading ? 'Preparing preview…' : 'Preview & send on WhatsApp'}
              </Button>
              <Button
                variant="outline"
                onClick={openWhatsApp}
                className="h-11 rounded-xl gap-2"
              >
                <MessageCircle className="h-4 w-4" /> Send text only
              </Button>
              <Button
                onClick={sendSms}
                disabled={smsSending || linkLoading || !tenantPhone}
                className="h-12 rounded-xl gap-2 font-bold bg-primary hover:bg-primary/90 text-primary-foreground"
                size="lg"
                aria-label="Send the branded card link to the tenant via SMS"
              >
                {smsSending ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Send className="h-5 w-5" />
                )}
                {smsSending
                  ? 'Sending SMS…'
                  : tenantPhone
                    ? `Send branded card via SMS to ${tenantName.split(' ')[0]}`
                    : 'Add tenant phone to send SMS'}
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  onClick={downloadPng}
                  disabled={pngLoading}
                  className="h-11 rounded-xl gap-2"
                >
                  {pngLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
                  Save image
                </Button>
                <Button
                  variant="outline"
                  onClick={downloadPdf}
                  disabled={pdfLoading}
                  className="h-11 rounded-xl gap-2"
                >
                  {pdfLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                  PDF
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
