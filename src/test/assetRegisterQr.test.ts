import jsPDF from 'jspdf';
import QRCode from 'qrcode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSET_DETAIL_ROUTE, LABEL_FOOTER, LABEL_HEADER, LABEL_LAYOUT, LABEL_SHEET, LABEL_TEXT_WIDTH, LABELS_PER_PAGE, MAX_LABELS_PER_PRINT,
  assetDetailPath, assetLabelsFileName, assetQrFileName,
  assetQrPngDataUrl, assetQrSvg, assetQrUrl, buildAssetLabelsPdf, isAssetId, prepareLabels,
} from '@/lib/assetRegister/qr';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const idN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A full register row: only id (QR URL), asset_code, category and location may reach a label; the rest must never print.
const fullAsset = (n: number) => ({
  id: idN(n), asset_code: `WEL-AST-${String(n).padStart(6, '0')}`, name: `Laptop ${n}`, category: 'furniture',
  location: 'Headquarters', serial_number: `SECRET-SERIAL-${n}`, purchase_cost: 9876543, supplier: 'Confidential Supplier Ltd',
  custodian_display: 'Private Custodian', invoice_reference: 'INV-PRIVATE',
});

afterEach(() => vi.restoreAllMocks());

describe('asset QR payload', () => {
  it('is only the canonical authenticated detail URL built from the uuid', () => {
    expect(assetQrUrl(ID)).toBe(`https://welileapp.com/cfo/assets/${ID}`);
    expect(assetDetailPath(ID)).toBe(`/cfo/assets/${ID}`);
    expect(ASSET_DETAIL_ROUTE).toBe('/cfo/assets/:assetId');
  });

  it('normalises case and ignores a trailing slash on the origin', () => {
    expect(assetQrUrl(ID.toUpperCase(), 'https://welileapp.com/')).toBe(`https://welileapp.com/cfo/assets/${ID}`);
  });

  it.each(['', 'WEL-AST-000001', '../../auth', `${ID}/../x`, `${ID}?x=1`, 'javascript:alert(1)', '123'])(
    'rejects a non-uuid id (%s)', (bad) => {
      expect(isAssetId(bad)).toBe(false);
      expect(() => assetQrUrl(bad)).toThrow('Not a valid asset id');
    },
  );

  it('encodes exactly the URL, with no asset code, name or other register data', async () => {
    const spy = vi.spyOn(QRCode, 'toDataURL');
    await assetQrPngDataUrl(ID);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(`https://welileapp.com/cfo/assets/${ID}`);
  });

  it('generates a real PNG and SVG, deterministically, and different codes per asset', async () => {
    const a1 = await assetQrPngDataUrl(ID);
    const a2 = await assetQrPngDataUrl(ID);
    const b = await assetQrPngDataUrl(idN(1));
    expect(a1).toMatch(/^data:image\/png;base64,/);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    const svg = await assetQrSvg(ID);
    expect(svg).toContain('<svg');
    expect(svg).not.toContain(ID);
  });

  it('names downloads safely from the asset code', () => {
    expect(assetQrFileName('WEL-AST-000123')).toBe('WEL-AST-000123-qr.png');
    expect(assetQrFileName('../../x y')).toBe('x-y-qr.png');
  });
});

describe('asset labels', () => {
  it('validates, de-duplicates and strips labels to id, code, category and location', () => {
    const out = prepareLabels([fullAsset(1), fullAsset(1), fullAsset(2)] as never);
    expect(out).toEqual([
      { id: idN(1), asset_code: 'WEL-AST-000001', category: 'furniture', location: 'Headquarters' },
      { id: idN(2), asset_code: 'WEL-AST-000002', category: 'furniture', location: 'Headquarters' },
    ]);
    expect(() => prepareLabels([])).toThrow('No assets selected');
    expect(() => prepareLabels([{ id: 'nope', asset_code: 'X', category: 'other', location: null }])).toThrow('Not a valid asset id');
    const many = Array.from({ length: MAX_LABELS_PER_PRINT + 1 }, (_, i) => fullAsset(i + 1));
    expect(() => prepareLabels(many as never)).toThrow(`at most ${MAX_LABELS_PER_PRINT}`);
  });

  it('prints one label: company, QR, code, category, location and ownership footer only', async () => {
    const doc = await buildAssetLabelsPdf([fullAsset(7)] as never);
    expect(doc.getNumberOfPages()).toBe(1);
    const pdf = doc.output();
    for (const shown of [LABEL_HEADER, 'WEL-AST-000007', 'Furniture', 'Headquarters', LABEL_FOOTER]) expect(pdf).toContain(shown);
    expect(pdf).toContain('/Subtype /Image');
    for (const secret of ['Laptop 7', 'SECRET-SERIAL-7', '9876543', '9,876,543', 'Confidential Supplier', 'Private Custodian', 'INV-PRIVATE', idN(7)]) {
      expect(pdf).not.toContain(secret);
    }
    expect(assetLabelsFileName(prepareLabels([fullAsset(7)] as never))).toBe('WEL-AST-000007-label.pdf');
  });

  it('omits the location line when an asset has none', async () => {
    const doc = await buildAssetLabelsPdf([{ ...fullAsset(3), location: null }] as never);
    expect(doc.output()).not.toContain('Headquarters');
  });

  it('keeps the stacked layout inside the label', () => {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const width = (font: string, size: number, s: string) => { doc.setFont('helvetica', font); doc.setFontSize(size); return doc.getTextWidth(s); };
    expect(width('bold', 6.5, LABEL_HEADER)).toBeLessThanOrEqual(LABEL_TEXT_WIDTH);
    expect(width('bold', 10, 'WEL-AST-9999999')).toBeLessThanOrEqual(LABEL_TEXT_WIDTH);
    expect(width('normal', 6, LABEL_FOOTER)).toBeLessThanOrEqual(LABEL_TEXT_WIDTH);
    expect(LABEL_LAYOUT.qrTop).toBeGreaterThan(LABEL_LAYOUT.header);
    expect(LABEL_LAYOUT.qrTop + LABEL_SHEET.qrSize).toBeLessThan(LABEL_LAYOUT.code - 2.5);
    expect(LABEL_LAYOUT.footer).toBeLessThan(LABEL_SHEET.labelHeight - 1);
  });

  it('batch-prints a label per asset across pages', async () => {
    const n = LABELS_PER_PAGE + 2;
    const labels = Array.from({ length: n }, (_, i) => fullAsset(i + 1));
    const doc = await buildAssetLabelsPdf(labels as never);
    expect(doc.getNumberOfPages()).toBe(2);
    const pdf = doc.output();
    for (let i = 1; i <= n; i++) expect(pdf).toContain(`WEL-AST-${String(i).padStart(6, '0')}`);
    expect((pdf.match(/\/Subtype \/Image/g) ?? []).length).toBe(n);
    expect(assetLabelsFileName(labels as never)).toBe(`welile-asset-labels-${n}.pdf`);
  });
});
