import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Download,
  MessageCircle,
  Share2,
  CheckCircle2,
  Loader2,
  FileDown,
  FileText,
  RotateCcw,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { toast } from 'sonner';

export interface LandlordPayoutShareData {
  amount: number;
  landlord_name: string;
  landlord_phone: string;
  mobile_money_provider: string;
  tenant_name: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  momo_reference: string;
  paid_at: string; // ISO
  country?: string | null;
}

function formatUGX(n: number) {
  return `UGX ${Number(n).toLocaleString()}`;
}

function formatWhatsAppNumber(phone: string): string {
  let cleaned = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
  if (cleaned.startsWith('0')) cleaned = '256' + cleaned.slice(1);
  else if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  return cleaned;
}

const CAPTION_TEMPLATE_KEY = 'welile.landlordPayout.captionTemplate.v1';

export const DEFAULT_PAYOUT_CAPTION_TEMPLATE =
  `✅ *Welile — Landlord Paid*\n\n` +
  `*{amount}* sent to *{landlord}*\n` +
  `📱 {provider}: {phone}\n` +
  `🏠 Tenant: {tenant}\n` +
  `🧾 MoMo TID: {tid}\n` +
  `🕒 {date}\n\n` +
  `Please confirm with the landlord and upload the receipt in your Welile app.`;

function renderCaption(template: string, d: LandlordPayoutShareData): string {
  const map: Record<string, string> = {
    amount: formatUGX(d.amount),
    landlord: d.landlord_name,
    tenant: d.tenant_name || 'Unallocated',
    tid: d.momo_reference,
    provider: d.mobile_money_provider,
    phone: d.landlord_phone,
    agent: d.agent_name || '',
    date: new Date(d.paid_at).toLocaleString('en-UG'),
  };
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    Object.prototype.hasOwnProperty.call(map, k) ? map[k] : `{${k}}`,
  );
}

// ───────────────────────────────────────────────────────────
// A4 layout constants — single source of truth for the PDF.
// Tweaking these here keeps every device output consistent.
// ───────────────────────────────────────────────────────────
const A4_PAGE_MM = { width: 210, height: 297 };
const PDF_MARGIN_MM = 14;          // outer margin on every side
const PDF_HEADER_MM = 18;          // reserved height for title + meta
const PDF_FOOTER_MM = 14;          // reserved height for footer text
// Capture the card at a fixed CSS width so the snapshot is identical
// on phone, tablet, and desktop. pixelRatio bumps DPI for print.
const CARD_CAPTURE_WIDTH_PX = 480;
const CARD_CAPTURE_PIXEL_RATIO = 2.5;

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  data: LandlordPayoutShareData | null;
}

export function LandlordPayoutShareCard({ open, onOpenChange, data }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<'png' | 'pdf' | 'share' | 'share-pdf' | null>(null);
  const [captionTemplate, setCaptionTemplate] = useState<string>(DEFAULT_PAYOUT_CAPTION_TEMPLATE);
  const [showTemplate, setShowTemplate] = useState(false);
  const [recipient, setRecipient] = useState<'agent' | 'landlord' | 'other'>('agent');
  const [customPhone, setCustomPhone] = useState('');

  useEffect(() => {
    try {
      const stored = localStorage.getItem(CAPTION_TEMPLATE_KEY);
      if (stored && stored.trim()) setCaptionTemplate(stored);
    } catch {
      // ignore
    }
  }, []);

  const persistTemplate = (next: string) => {
    setCaptionTemplate(next);
    try {
      localStorage.setItem(CAPTION_TEMPLATE_KEY, next);
    } catch {
      // ignore
    }
  };

  const resetTemplate = () => {
    persistTemplate(DEFAULT_PAYOUT_CAPTION_TEMPLATE);
    toast.success('Caption reset to default');
  };

  if (!data) return null;

  const captionText = renderCaption(captionTemplate, data);

  const recipientPhone =
    recipient === 'landlord'
      ? data.landlord_phone
      : recipient === 'other'
        ? customPhone
        : data.agent_phone || '';

  const recipientLabel =
    recipient === 'landlord'
      ? `Landlord · ${data.landlord_name}`
      : recipient === 'other'
        ? customPhone || 'Custom number'
        : data.agent_name
          ? `Agent · ${data.agent_name}`
          : 'Agent';

  const renderImage = async () => {
    if (!cardRef.current) return null;
    const { toPng } = await import('html-to-image');
    const node = cardRef.current;
    // Force a fixed render width so output is device-independent.
    return toPng(node, {
      pixelRatio: CARD_CAPTURE_PIXEL_RATIO,
      cacheBust: true,
      skipFonts: true,
      width: CARD_CAPTURE_WIDTH_PX,
      // Let height auto-derive from content
      style: {
        width: `${CARD_CAPTURE_WIDTH_PX}px`,
        maxWidth: `${CARD_CAPTURE_WIDTH_PX}px`,
        // Override transform/scale that the dialog might apply
        transform: 'none',
      },
    });
  };

  const handleDownload = async () => {
    setBusy('png');
    try {
      const dataUrl = await renderImage();
      if (!dataUrl) return;
      const link = document.createElement('a');
      link.download = `welile-landlord-payout-${data.momo_reference}.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      toast.success('Card downloaded');
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to download card');
    } finally {
      setBusy(null);
    }
  };

  const buildPdfBlob = async (): Promise<Blob | null> => {
    const dataUrl = await renderImage();
    if (!dataUrl) return null;
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });

    const pageW = A4_PAGE_MM.width;
    const pageH = A4_PAGE_MM.height;
    const margin = PDF_MARGIN_MM;

    // Header band
    pdf.setFontSize(16);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Welile — Landlord Payout Confirmation', margin, margin + 6);
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 100, 100);
    pdf.text(
      `Generated: ${new Date().toLocaleString('en-UG')}  ·  MoMo TID: ${data.momo_reference}`,
      margin,
      margin + 12,
    );
    pdf.setTextColor(0, 0, 0);

    // Decorative rule under header
    pdf.setDrawColor(220, 220, 220);
    pdf.setLineWidth(0.2);
    pdf.line(margin, margin + PDF_HEADER_MM - 2, pageW - margin, margin + PDF_HEADER_MM - 2);

    // Available content box (between header & footer, inside margins)
    const contentTop = margin + PDF_HEADER_MM;
    const contentBottom = pageH - margin - PDF_FOOTER_MM;
    const contentW = pageW - margin * 2;
    const contentH = contentBottom - contentTop;

    // Decode card image to know its native aspect ratio
    const img = new Image();
    img.src = dataUrl;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to render card image'));
    });

    // Fit image inside contentW x contentH while preserving aspect ratio.
    // Math.min ensures we never crop or overflow either axis.
    const scale = Math.min(contentW / img.width, contentH / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    // Center inside the content box
    const drawX = margin + (contentW - drawW) / 2;
    const drawY = contentTop + (contentH - drawH) / 2;

    pdf.addImage(dataUrl, 'PNG', drawX, drawY, drawW, drawH, undefined, 'FAST');

    // Footer band (anchored to page bottom — never overlaps card)
    const footerY = pageH - margin - PDF_FOOTER_MM + 6;
    pdf.setDrawColor(220, 220, 220);
    pdf.line(margin, footerY - 4, pageW - margin, footerY - 4);
    pdf.setFontSize(9);
    pdf.setTextColor(80, 80, 80);
    pdf.text(
      'This is an internal Welile payout confirmation. Please retain for reconciliation.',
      margin,
      footerY,
    );
    pdf.text('welileapp.com', margin, footerY + 5);

    return pdf.output('blob');
  };

  const handleDownloadPdf = async () => {
    setBusy('pdf');
    try {
      const blob = await buildPdfBlob();
      if (!blob) return;
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `welile-landlord-payout-${data.momo_reference}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      toast.success('PDF downloaded');
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to generate PDF');
    } finally {
      setBusy(null);
    }
  };

  const handleSharePdf = async () => {
    setBusy('share-pdf');
    try {
      const blob = await buildPdfBlob();
      if (!blob) return;
      const fileName = `welile-landlord-payout-${data.momo_reference}.pdf`;
      const file = new File([blob], fileName, { type: 'application/pdf' });
      const text = captionText;
      const nav = navigator as any;
      if (nav.canShare && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], text, title: 'Welile — Landlord Paid' });
        toast.success('PDF shared');
      } else {
        // Fallback: download PDF + open WhatsApp chat with text
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        openWhatsAppText();
        toast.message('PDF downloaded — attach it in WhatsApp');
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast.error(e?.message ?? 'Failed to share PDF');
    } finally {
      setBusy(null);
    }
  };

  const handleNativeShare = async () => {
    setBusy('share');
    try {
      const dataUrl = await renderImage();
      if (!dataUrl) return;
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], `welile-landlord-payout-${data.momo_reference}.png`, {
        type: 'image/png',
      });
      const text = captionText;
      const nav = navigator as any;
      if (nav.canShare && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], text, title: 'Welile — Landlord Paid' });
        toast.success('Shared');
      } else {
        // Fallback: download + open WhatsApp with text
        const link = document.createElement('a');
        link.download = file.name;
        link.href = dataUrl;
        link.click();
        openWhatsAppText();
        toast.message('Image downloaded — attach it in WhatsApp');
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast.error(e?.message ?? 'Failed to share');
    } finally {
      setBusy(null);
    }
  };

  const openWhatsAppText = () => {
    const text = encodeURIComponent(captionText);
    const phone = recipientPhone ? formatWhatsAppNumber(recipientPhone) : '';
    const base = phone ? `https://wa.me/${phone}` : `https://wa.me/`;
    window.open(`${base}?text=${text}`, '_blank');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[95vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader className="text-left">
          <DialogTitle>Share payout with agent</DialogTitle>
          <DialogDescription>
            Send a confirmation card on WhatsApp. On a phone, tap "Share PDF to WhatsApp" — it opens the WhatsApp picker with the file already attached.
          </DialogDescription>
        </DialogHeader>

        {/* Purple gradient card */}
        <div
          ref={cardRef}
          className="rounded-2xl p-5 text-white shadow-xl relative overflow-hidden"
          style={{
            background:
              'linear-gradient(135deg, #3d0066 0%, #7A00CC 55%, #1a0033 100%)',
          }}
        >
          <div
            aria-hidden
            className="absolute -top-10 -right-10 h-40 w-40 rounded-full"
            style={{ background: 'rgba(196,128,255,0.35)', filter: 'blur(30px)' }}
          />
          <div
            aria-hidden
            className="absolute -bottom-10 -left-10 h-40 w-40 rounded-full"
            style={{ background: 'rgba(122,0,204,0.45)', filter: 'blur(40px)' }}
          />

          <div className="relative z-10 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] tracking-[0.2em] uppercase text-purple-200">
                  Welile · Landlord Paid
                </p>
                <p className="text-xs text-purple-100/80 mt-0.5">
                  {new Date(data.paid_at).toLocaleString('en-UG')}
                </p>
              </div>
              <div className="h-9 w-9 rounded-full bg-white/15 flex items-center justify-center">
                <CheckCircle2 className="h-5 w-5 text-emerald-300" />
              </div>
            </div>

            <div>
              <p className="text-[10px] uppercase tracking-wider text-purple-200">Amount sent</p>
              <p className="text-3xl font-bold leading-tight">{formatUGX(data.amount)}</p>
            </div>

            <div className="rounded-xl bg-white/10 border border-white/15 p-3 space-y-2 backdrop-blur-sm">
              <div className="flex justify-between gap-3 text-sm">
                <span className="text-purple-200">Landlord</span>
                <span className="font-semibold text-right truncate">{data.landlord_name}</span>
              </div>
              <div className="flex justify-between gap-3 text-sm">
                <span className="text-purple-200">{data.mobile_money_provider}</span>
                <span className="font-mono font-semibold">{data.landlord_phone}</span>
              </div>
              <div className="flex justify-between gap-3 text-sm">
                <span className="text-purple-200">Tenant</span>
                <span className="font-semibold text-right truncate">
                  {data.tenant_name || 'Unallocated'}
                </span>
              </div>
              <div className="flex justify-between gap-3 text-sm">
                <span className="text-purple-200">MoMo TID</span>
                <span className="font-mono font-semibold text-right break-all">
                  {data.momo_reference}
                </span>
              </div>
              {data.agent_name && (
                <div className="flex justify-between gap-3 text-sm">
                  <span className="text-purple-200">Agent</span>
                  <span className="font-semibold text-right truncate">{data.agent_name}</span>
                </div>
              )}
            </div>

            <p className="text-[10px] text-purple-200/80 text-center pt-1">
              Powered by Welile · welileapp.com
            </p>
          </div>
        </div>

        {/* WhatsApp caption template editor */}
        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
          <button
            type="button"
            onClick={() => setShowTemplate((s) => !s)}
            className="w-full flex items-center justify-between text-xs font-medium text-foreground"
          >
            <span className="flex items-center gap-2">
              <MessageCircle className="h-3.5 w-3.5 text-purple-600" />
              WhatsApp caption {showTemplate ? '(editing)' : '(preview)'}
            </span>
            {showTemplate ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>

          {!showTemplate && (
            <p className="text-[11px] text-muted-foreground whitespace-pre-wrap line-clamp-3 font-mono">
              {captionText}
            </p>
          )}

          {showTemplate && (
            <div className="space-y-2">
              <Label htmlFor="payout-caption" className="text-[11px] text-muted-foreground">
                Use placeholders:{' '}
                <code className="font-mono text-[10px]">
                  {'{landlord} {tenant} {tid} {amount} {provider} {phone} {agent} {date}'}
                </code>
              </Label>
              <Textarea
                id="payout-caption"
                value={captionTemplate}
                onChange={(e) => persistTemplate(e.target.value)}
                rows={7}
                className="font-mono text-xs"
                placeholder={DEFAULT_PAYOUT_CAPTION_TEMPLATE}
              />
              <div className="rounded-md bg-background border border-border/60 p-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                  Preview
                </p>
                <p className="text-[11px] whitespace-pre-wrap font-mono text-foreground">
                  {captionText}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={resetTemplate}
                className="h-7 px-2 text-[11px] gap-1"
              >
                <RotateCcw className="h-3 w-3" />
                Reset to default
              </Button>
            </div>
          )}
        </div>

        {/* Recipient picker — pick who receives the WhatsApp message */}
        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Send to</p>
          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              onClick={() => setRecipient('agent')}
              disabled={!data.agent_phone}
              className={`text-[11px] rounded-md px-2 py-2 border transition ${
                recipient === 'agent'
                  ? 'bg-purple-600 border-purple-600 text-white'
                  : 'bg-background border-border text-foreground hover:bg-muted'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              Agent
              {data.agent_phone && (
                <span className="block font-mono text-[10px] opacity-80 truncate">
                  {data.agent_phone}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setRecipient('landlord')}
              className={`text-[11px] rounded-md px-2 py-2 border transition ${
                recipient === 'landlord'
                  ? 'bg-purple-600 border-purple-600 text-white'
                  : 'bg-background border-border text-foreground hover:bg-muted'
              }`}
            >
              Landlord
              <span className="block font-mono text-[10px] opacity-80 truncate">
                {data.landlord_phone}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setRecipient('other')}
              className={`text-[11px] rounded-md px-2 py-2 border transition ${
                recipient === 'other'
                  ? 'bg-purple-600 border-purple-600 text-white'
                  : 'bg-background border-border text-foreground hover:bg-muted'
              }`}
            >
              Other
              <span className="block text-[10px] opacity-80">custom #</span>
            </button>
          </div>
          {recipient === 'other' && (
            <input
              type="tel"
              inputMode="tel"
              placeholder="e.g. 0772123456"
              value={customPhone}
              onChange={(e) => setCustomPhone(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
            />
          )}
        </div>

        {/* Primary WhatsApp actions — biggest, thumb-friendly buttons for mobile */}
        <div className="space-y-2">
          <Button
            onClick={handleSharePdf}
            disabled={busy !== null}
            className="w-full h-12 gap-2 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white text-base font-semibold shadow-lg"
          >
            {busy === 'share-pdf' ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <MessageCircle className="h-5 w-5" />
            )}
            Share PDF on WhatsApp
          </Button>
          <Button
            onClick={handleNativeShare}
            disabled={busy !== null}
            variant="outline"
            className="w-full h-11 gap-2 border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10"
          >
            {busy === 'share' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Share2 className="h-4 w-4" />
            )}
            Share image on WhatsApp
          </Button>
          <Button
            onClick={openWhatsAppText}
            disabled={!recipientPhone && recipient !== 'other' ? false : recipient === 'other' && !customPhone}
            variant="outline"
            className="w-full h-11 gap-2"
          >
            <MessageCircle className="h-4 w-4 text-emerald-600" />
            Open WhatsApp chat · {recipientLabel}
          </Button>
        </div>

        {/* Secondary: download fallbacks */}
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={handleDownload} variant="ghost" size="sm" disabled={busy !== null} className="gap-2">
            {busy === 'png' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Save PNG
          </Button>
          <Button onClick={handleDownloadPdf} variant="ghost" size="sm" disabled={busy !== null} className="gap-2">
            {busy === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
            Save PDF
          </Button>
        </div>

        <p className="text-[10px] text-muted-foreground text-center">
          Tip: on Android & iPhone, "Share PDF on WhatsApp" attaches the file directly into the WhatsApp chat picker.
        </p>
      </DialogContent>
    </Dialog>
  );
}
