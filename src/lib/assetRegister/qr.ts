import jsPDF from 'jspdf';
import QRCode from 'qrcode';
import { CANONICAL_ORIGIN } from '@/lib/getPublicOrigin';
import { categoryLabel, type Asset } from './types';

/**
 * Asset Register QR codes and labels.
 *
 * The QR payload is only the asset's authenticated detail URL, built from its permanent uuid — no asset code, name,
 * serial, cost, custodian or location. Scanning it opens /cfo/assets/<uuid>, which requires sign-in, the cfo or
 * super_admin role, and passes the server check in `asset_register_get`; the QR itself grants nothing.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ASSET_DETAIL_ROUTE = '/cfo/assets/:assetId';

export function isAssetId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function requireAssetId(id: string): string {
  if (!isAssetId(id)) throw new Error('Not a valid asset id');
  return id.toLowerCase();
}

/** In-app path of an asset's read-only detail page. */
export function assetDetailPath(id: string): string {
  return `/cfo/assets/${requireAssetId(id)}`;
}

/**
 * The URL encoded in an asset's QR code. Always the canonical origin (not the current host), so a label printed from a
 * preview or local build still opens production.
 */
export function assetQrUrl(id: string, origin: string = CANONICAL_ORIGIN): string {
  return `${origin.replace(/\/+$/, '')}${assetDetailPath(id)}`;
}

const QR_OPTIONS = { errorCorrectionLevel: 'M', margin: 2 } as const;

/** PNG data URL of the asset's QR code. */
export function assetQrPngDataUrl(id: string, width = 512): Promise<string> {
  return QRCode.toDataURL(assetQrUrl(id), { ...QR_OPTIONS, width });
}

/** SVG markup of the asset's QR code. */
export function assetQrSvg(id: string): Promise<string> {
  return QRCode.toString(assetQrUrl(id), { ...QR_OPTIONS, type: 'svg' });
}

const safeFilePart = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset';

export function assetQrFileName(assetCode: string): string {
  return `${safeFilePart(assetCode)}-qr.png`;
}

/**
 * What a printed label carries: asset code, category and location. The id is used solely to build the QR URL and is
 * never printed as text. Serial, cost, supplier, custodian and invoice never reach a label.
 */
export type AssetLabel = Pick<Asset, 'id' | 'asset_code' | 'category' | 'location'>;

/** Strips a register row down to the fields a label may carry. */
export function toAssetLabel(a: AssetLabel): AssetLabel {
  return { id: a.id, asset_code: a.asset_code, category: a.category, location: a.location ?? null };
}

export const MAX_LABELS_PER_PRINT = 500;

/**
 * A4 sheet of 3 × 7 labels, 63.5 × 38.1 mm (the common L7160 / 21-up layout), so labels also print on plain paper
 * for cutting. All values in mm. Text is stacked and centred under the QR code.
 */
export const LABEL_SHEET = {
  pageWidth: 210, pageHeight: 297,
  cols: 3, rows: 7,
  labelWidth: 63.5, labelHeight: 38.1,
  marginLeft: 7.2, marginTop: 15.15,
  pitchX: 66, pitchY: 38.1,
  qrSize: 17.5,
} as const;

export const LABELS_PER_PAGE = LABEL_SHEET.cols * LABEL_SHEET.rows;

/** Width (mm) available for each centred text line. */
export const LABEL_TEXT_WIDTH = LABEL_SHEET.labelWidth - 6;
export const LABEL_HEADER = 'WELILE TECHNOLOGIES LTD';
export const LABEL_FOOTER = 'PROPERTY OF WELILE';

/** Vertical layout (mm from the label top): text baselines and the QR top edge. */
export const LABEL_LAYOUT = {
  header: 4.6, qrTop: 6.0, code: 27.4, category: 30.6, location: 33.5, footer: 36.4,
} as const;

/** Validates, de-duplicates (by id, first wins) and caps the labels to print. */
export function prepareLabels(labels: AssetLabel[]): AssetLabel[] {
  const seen = new Set<string>();
  const out: AssetLabel[] = [];
  for (const l of labels) {
    const id = requireAssetId(l.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(toAssetLabel({ ...l, id }));
  }
  if (out.length === 0) throw new Error('No assets selected');
  if (out.length > MAX_LABELS_PER_PRINT) throw new Error(`Print at most ${MAX_LABELS_PER_PRINT} labels at a time`);
  return out;
}

/** First line of `text` that fits `width`, with an ellipsis when cut. Font must already be set on `doc`. */
function fitLine(doc: jsPDF, text: string, width: number): string {
  const t = text.trim();
  if (!t || doc.getTextWidth(t) <= width) return t;
  let s = t;
  while (s.length > 1 && doc.getTextWidth(`${s}...`) > width) s = s.slice(0, -1);
  return `${s.trimEnd()}...`;
}

/** Label sheet PDF: company name, centred QR code, asset code, category, location and ownership footer. */
export async function buildAssetLabelsPdf(labels: AssetLabel[]): Promise<jsPDF> {
  const items = prepareLabels(labels);
  const L = LABEL_SHEET;
  const Y = LABEL_LAYOUT;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  doc.setProperties({ title: 'Welile asset labels', creator: 'Welile Asset Register' });

  const qrs = await Promise.all(items.map((l) => assetQrPngDataUrl(l.id, 360)));

  items.forEach((l, i) => {
    const slot = i % LABELS_PER_PAGE;
    if (i > 0 && slot === 0) doc.addPage();
    const x = L.marginLeft + (slot % L.cols) * L.pitchX;
    const y = L.marginTop + Math.floor(slot / L.cols) * L.pitchY;
    const cx = x + L.labelWidth / 2;
    const tw = LABEL_TEXT_WIDTH;

    doc.setDrawColor(220);
    doc.setLineWidth(0.1);
    doc.roundedRect(x, y, L.labelWidth, L.labelHeight, 2, 2);

    doc.setTextColor(20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.text(LABEL_HEADER, cx, y + Y.header, { align: 'center' });

    doc.addImage(qrs[i], 'PNG', cx - L.qrSize / 2, y + Y.qrTop, L.qrSize, L.qrSize);

    doc.setFontSize(10);
    doc.text(fitLine(doc, l.asset_code, tw), cx, y + Y.code, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(60);
    doc.setFontSize(7);
    doc.text(fitLine(doc, categoryLabel(l.category), tw), cx, y + Y.category, { align: 'center' });
    if (l.location?.trim()) doc.text(fitLine(doc, l.location, tw), cx, y + Y.location, { align: 'center' });

    doc.setTextColor(110);
    doc.setFontSize(6);
    doc.text(LABEL_FOOTER, cx, y + Y.footer, { align: 'center' });
  });

  return doc;
}

export function assetLabelsFileName(labels: AssetLabel[]): string {
  return labels.length === 1 ? `${safeFilePart(labels[0].asset_code)}-label.pdf` : `welile-asset-labels-${labels.length}.pdf`;
}

/** Saves a data: or blob: URL as a file in the browser. */
export function downloadUrl(url: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function pdfBlobUrl(doc: jsPDF): string {
  return doc.output('bloburl') as unknown as string;
}

/**
 * Opens the label PDF in a new tab with the print dialog armed. Returns false when the browser blocked the tab, so the
 * caller can fall back to downloading it.
 */
export function openPdfForPrint(doc: jsPDF): boolean {
  doc.autoPrint();
  const url = pdfBlobUrl(doc);
  // No 'noopener' here: with it window.open always returns null, hiding a blocked tab. The URL is our own blob.
  const win = window.open(url, '_blank');
  return !!win;
}
