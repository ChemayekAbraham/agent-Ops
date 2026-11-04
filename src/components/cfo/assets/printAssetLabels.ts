import { toast } from 'sonner';
import { assetLabelsFileName, buildAssetLabelsPdf, downloadUrl, openPdfForPrint, pdfBlobUrl, type AssetLabel } from '@/lib/assetRegister/qr';

/** Prints label sheets for the given assets; falls back to a download when the print tab is blocked. */
export async function printAssetLabels(labels: AssetLabel[]) {
  try {
    const doc = await buildAssetLabelsPdf(labels);
    if (!openPdfForPrint(doc)) {
      downloadUrl(pdfBlobUrl(doc), assetLabelsFileName(labels));
      toast.info('Pop-up blocked — the label sheet was downloaded instead.');
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not prepare the labels.');
  }
}
