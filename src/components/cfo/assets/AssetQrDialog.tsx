import { useEffect, useState } from 'react';
import { Download, Loader2, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  LABEL_FOOTER, LABEL_HEADER, assetQrFileName, assetQrPngDataUrl, downloadUrl, labelPlaceLine, toAssetLabel, type AssetLabel,
} from '@/lib/assetRegister/qr';
import { assetCodes, categoryLabel } from '@/lib/assetRegister/types';
import { printAssetLabels } from './printAssetLabels';

export function AssetQrDialog({ asset, open, onOpenChange }: {
  asset: AssetLabel | null; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const [png, setPng] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const assetId = asset?.id;
  const codes = asset ? assetCodes(asset) : null;
  const place = asset ? labelPlaceLine(asset) : '';

  useEffect(() => {
    if (!open || !assetId) return;
    let live = true;
    setPng(null);
    assetQrPngDataUrl(assetId).then((u) => { if (live) setPng(u); }).catch(() => toast.error('Could not generate the QR code.'));
    return () => { live = false; };
  }, [open, assetId]);

  return (
    <Dialog open={open && !!asset} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{codes?.primary}</DialogTitle>
          <DialogDescription>
            Scanning opens this asset's record. Only CFO and Super Admin accounts can view it; the code holds no asset details.
          </DialogDescription>
        </DialogHeader>
        <div id="asset-qr-label-preview"
          className="mx-auto flex w-full max-w-[17rem] flex-col items-center rounded-lg border border-border bg-white px-4 py-3 text-center text-neutral-900 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-wide">{LABEL_HEADER}</p>
          <div className="my-2 flex aspect-square w-32 items-center justify-center">
            {png ? <img src={png} alt={`QR code for ${codes?.primary}`} className="h-full w-full" />
              : <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />}
          </div>
          <p className="max-w-full truncate text-lg font-bold leading-tight">{codes?.primary}</p>
          {codes?.secondary && <p className="max-w-full truncate font-mono text-[11px] leading-snug text-neutral-500">{codes.secondary}</p>}
          <p className="max-w-full truncate text-sm leading-snug text-neutral-600">{categoryLabel(asset?.category)}</p>
          {place && <p className="max-w-full truncate text-sm leading-snug text-neutral-600">{place}</p>}
          <p className="mt-0.5 text-[11px] uppercase tracking-wide text-neutral-500">{LABEL_FOOTER}</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button id="asset-qr-download" variant="outline" size="sm" disabled={!png || !asset}
            onClick={() => png && asset && downloadUrl(png, assetQrFileName(assetCodes(asset).primary))}>
            <Download className="mr-1.5 h-3.5 w-3.5" /> Download QR
          </Button>
          <Button id="asset-qr-print" size="sm" disabled={!asset || printing}
            onClick={async () => { if (!asset) return; setPrinting(true); await printAssetLabels([toAssetLabel(asset)]); setPrinting(false); }}>
            {printing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Printer className="mr-1.5 h-3.5 w-3.5" />} Print label
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
