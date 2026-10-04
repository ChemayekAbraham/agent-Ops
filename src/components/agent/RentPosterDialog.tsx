import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Megaphone, Share2, Download, Printer, Loader2, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { shareImageViaWhatsApp } from '@/lib/whatsappShare';
import posterAsset from '@/assets/available-for-rent-poster.jpg.asset.json';

interface RentPosterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type PaperSize = 'A4' | 'Letter';
type Orientation = 'portrait' | 'landscape';

// Portrait page dimensions in millimetres.
const PAPER_MM: Record<PaperSize, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  Letter: { w: 215.9, h: 279.4 },
};

// Allowed ranges for the printer-fit controls.
const MARGIN_OPTIONS = [0, 5, 10, 15, 20] as const;
const SCALE_MIN = 50;
const SCALE_MAX = 100;

const POSTER_FILENAME = 'Welile-Available-For-Rent.jpg';
const POSTER_CAPTION =
  'Available for rent on Welile! Move in and get your first week FREE. Visit welile.com';

/**
 * Shows the branded "Available for Rent" poster so agents can print it or
 * share it on WhatsApp with prospective tenants.
 */
export default function RentPosterDialog({ open, onOpenChange }: RentPosterDialogProps) {
  const [sharing, setSharing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [paper, setPaper] = useState<PaperSize>('A4');
  const [orientation, setOrientation] = useState<Orientation>('landscape');
  // Page margin in millimetres and image scale as a percentage of the
  // printable area — let agents nudge the layout to fit their printer.
  const [margin, setMargin] = useState<number>(10);
  const [scale, setScale] = useState<number>(100);
  const [phone, setPhone] = useState('');

  const fetchPosterBlob = async () => {
    const res = await fetch(posterAsset.url);
    if (!res.ok) throw new Error('Failed to load poster');
    return res.blob();
  };

  const loadImage = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load poster image'));
      img.src = src;
    });

  const handleShare = async () => {
    setSharing(true);
    try {
      const blob = await fetchPosterBlob();
      const result = await shareImageViaWhatsApp(blob, {
        filename: POSTER_FILENAME,
        caption: POSTER_CAPTION,
        phone: phone.trim() || undefined,
      });
      if (result === 'deeplink') {
        toast.success('Poster saved — attach it in WhatsApp');
      }
    } catch {
      toast.error('Could not share the poster', { description: 'Please try again in a moment.' });
    } finally {
      setSharing(false);
    }
  };

  // Return page dimensions respecting the chosen orientation.
  const getPageSize = () => {
    const p = PAPER_MM[paper];
    return orientation === 'landscape'
      ? { w: p.h, h: p.w }
      : { w: p.w, h: p.h };
  };

  // Download a print-ready PDF sized to the chosen paper (A4 / Letter)
  // and orientation, with the poster centred and scaled to fit.
  const handleDownload = async () => {
    setDownloading(true);
    try {
      const img = await loadImage(posterAsset.url);
      const { jsPDF } = await import('jspdf');
      const page = getPageSize();
      const pdf = new jsPDF({
        orientation,
        unit: 'mm',
        format: paper.toLowerCase() as 'a4' | 'letter',
        compress: true,
      });

      // Printable area after subtracting margins on all sides.
      const safeMargin = Math.max(0, Math.min(margin, page.w / 2 - 5, page.h / 2 - 5));
      const areaW = page.w - safeMargin * 2;
      const areaH = page.h - safeMargin * 2;

      // Fit the image inside the printable area preserving aspect ratio,
      // then apply the chosen scale and centre it.
      const imgRatio = img.width / img.height;
      const areaRatio = areaW / areaH;
      let drawW: number;
      let drawH: number;
      if (imgRatio > areaRatio) {
        drawW = areaW;
        drawH = areaW / imgRatio;
      } else {
        drawH = areaH;
        drawW = areaH * imgRatio;
      }
      const factor = scale / 100;
      drawW *= factor;
      drawH *= factor;
      const x = (page.w - drawW) / 2;
      const y = (page.h - drawH) / 2;
      pdf.addImage(img, 'JPEG', x, y, drawW, drawH, undefined, 'FAST');
      pdf.save(`Welile-Available-For-Rent-${paper}-${orientation}.pdf`);
    } catch {
      toast.error('Could not download the poster');
    } finally {
      setDownloading(false);
    }
  };

  const handlePrint = () => {
    const w = window.open('', '_blank');
    if (!w) {
      toast.error('Allow pop-ups to print the poster');
      return;
    }
    const pageSize = paper === 'A4' ? 'A4' : 'letter';
    const safeScale = Math.max(SCALE_MIN, Math.min(scale, SCALE_MAX));
    w.document.write(`
      <html>
        <head>
          <title>Available for Rent</title>
          <style>
            @page { size: ${pageSize} ${orientation}; margin: ${margin}mm; }
            html, body { margin: 0; padding: 0; height: 100%; }
            body { display: flex; align-items: center; justify-content: center; }
            img {
              max-width: ${safeScale}%;
              max-height: ${safeScale}%;
              width: auto;
              height: auto;
              display: block;
            }
          </style>
        </head>
        <body>
          <img src="${posterAsset.url}" onload="window.focus();window.print();" />
        </body>
      </html>
    `);
    w.document.close();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[92vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-primary" />
            Available for Rent poster
          </DialogTitle>
          <DialogDescription>
            Print this poster or share it on WhatsApp to advertise an available property.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 rounded-lg border bg-muted/30 overflow-auto">
          <img
            src={posterAsset.url}
            alt="Welile — Available for Rent poster"
            className="w-full h-auto"
          />
        </div>

        {/* Paper size & orientation selectors — apply to both Download and Print */}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Paper:</span>
            {(['A4', 'Letter'] as PaperSize[]).map((size) => (
              <Button
                key={size}
                type="button"
                size="sm"
                variant={paper === size ? 'default' : 'outline'}
                onClick={() => setPaper(size)}
                className="h-8 px-4 touch-manipulation select-none"
              >
                {size}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Orientation:</span>
            {(['portrait', 'landscape'] as Orientation[]).map((o) => (
              <Button
                key={o}
                type="button"
                size="sm"
                variant={orientation === o ? 'default' : 'outline'}
                onClick={() => setOrientation(o)}
                className="h-8 px-4 touch-manipulation select-none capitalize"
              >
                {o}
              </Button>
            ))}
          </div>
        </div>

        {/* Printer-fit controls — margin & scale apply to Download and Print */}
        <div className="flex flex-wrap items-center gap-4 pt-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Margin:</span>
            {MARGIN_OPTIONS.map((m) => (
              <Button
                key={m}
                type="button"
                size="sm"
                variant={margin === m ? 'default' : 'outline'}
                onClick={() => setMargin(m)}
                className="h-8 px-3 touch-manipulation select-none"
              >
                {m === 0 ? 'None' : `${m}mm`}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2 min-w-[200px] flex-1">
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              Scale: {scale}%
            </span>
            <input
              type="range"
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={5}
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
              className="flex-1 accent-primary touch-manipulation"
              aria-label="Poster scale percentage"
            />
          </div>
        </div>

        {/* WhatsApp recipient — pre-fill so the agent goes straight to a contact */}
        <div className="flex items-center gap-2 pt-1">
          <span className="text-sm text-muted-foreground whitespace-nowrap">Send to:</span>
          <div className="flex items-center gap-1 flex-1">
            <span className="text-sm text-muted-foreground select-none">+</span>
            <Input
              type="tel"
              placeholder="256 7XX XXX XXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/[^0-9]/g, ''))}
              className="h-9 flex-1 touch-manipulation"
              aria-label="Recipient phone number"
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 pt-1">
          <Button
            type="button"
            onClick={handleShare}
            disabled={sharing}
            className="flex-1 h-12 gap-2 touch-manipulation select-none bg-[#25D366] hover:bg-[#1da851] text-white border-0"
          >
            {sharing ? <Loader2 className="h-5 w-5 animate-spin" /> : <MessageCircle className="h-5 w-5" />}
            {sharing ? 'Opening WhatsApp…' : 'Share on WhatsApp'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleDownload}
            disabled={downloading}
            className="h-12 gap-2 touch-manipulation select-none"
          >
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Download {paper} {orientation}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handlePrint}
            className="h-12 gap-2 touch-manipulation select-none"
          >
            <Printer className="h-4 w-4" /> Print {paper} {orientation}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
