import jsPDF from 'jspdf';
import QRCode from 'qrcode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSET_DETAIL_ROUTE, LABEL_FOOTER, LABEL_HEADER, LABEL_LAYOUT, LABEL_SHEET, LABEL_TEXT_WIDTH, LABELS_PER_PAGE, MAX_LABELS_PER_PRINT,
  assetDetailPath, assetLabelsFileName, assetQrFileName,
  assetQrPngDataUrl, assetQrSvg, assetQrUrl, buildAssetLabelsPdf, isAssetId, labelPlaceLine, prepareLabels,
} from '@/lib/assetRegister/qr';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const idN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pad = (n: number, w: number) => String(n).padStart(w, '0');

// A full register row: only id (QR URL), asset_tag, asset_code, category, site and location may reach a label; the rest
// must never print.
const fullAsset = (n: number, over: Record<string, unknown> = {}) => ({
  id: idN(n), asset_code: `WEL-AST-${pad(n, 6)}`, asset_tag: `WEL-FUR-HQ-${pad(n, 3)}`, name: `Laptop ${n}`, category: 'furniture',
  site_key: 'entebbe_hq', site_name: 'Entebbe Head Office', location: 'Headquarters',
  serial_number: `SECRET-SERIAL-${n}`, purchase_cost: 9876543, supplier: 'Confidential Supplier Ltd',
  custodian_display: 'Private Custodian', invoice_reference: 'INV-PRIVATE',
  ...over,
});

// The two codes supplied by the CFO (2026-10-27), on the assets they belong to.
const HQ_LAPTOP = fullAsset(1, { asset_tag: 'WEL-ICT-HQ-001', category: 'it_equipment', site_name: 'Entebbe Head Office', location: null });
const KOL_LAPTOP = fullAsset(2, { asset_tag: 'WEL-ICT-KOL-002', category: 'it_equipment', site_key: 'kololo', site_name: 'Kololo', location: 'Front desk' });

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

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

  it.each(['', 'WEL-AST-000001', 'WEL-ICT-HQ-001', 'WEL-ICT-KOL-002', '../../auth', `${ID}/../x`, `${ID}?x=1`, 'javascript:alert(1)', '123'])(
    'rejects a non-uuid id (%s)', (bad) => {
      expect(isAssetId(bad)).toBe(false);
      expect(() => assetQrUrl(bad)).toThrow('Not a valid asset id');
    },
  );

  it('encodes exactly the URL, with no asset code, tag, name or other register data', async () => {
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

  it('names downloads safely from the code', () => {
    expect(assetQrFileName('WEL-AST-000123')).toBe('WEL-AST-000123-qr.png');
    expect(assetQrFileName('WEL-ICT-KOL-002')).toBe('WEL-ICT-KOL-002-qr.png');
    expect(assetQrFileName('../../x y')).toBe('x-y-qr.png');
  });
});

describe('asset labels', () => {
  it('validates, de-duplicates and strips labels to id, tag, code, category, site and location', () => {
    const out = prepareLabels([fullAsset(1), fullAsset(1), fullAsset(2)] as never);
    expect(out).toEqual([1, 2].map((n) => ({
      id: idN(n), asset_code: `WEL-AST-${pad(n, 6)}`, asset_tag: `WEL-FUR-HQ-${pad(n, 3)}`, category: 'furniture',
      site_name: 'Entebbe Head Office', location: 'Headquarters',
    })));
    expect(() => prepareLabels([])).toThrow('No assets selected');
    expect(() => prepareLabels([{ id: 'nope', asset_code: 'X', asset_tag: null, category: 'other', site_name: null, location: null }])).toThrow('Not a valid asset id');
    const many = Array.from({ length: MAX_LABELS_PER_PRINT + 1 }, (_, i) => fullAsset(i + 1));
    expect(() => prepareLabels(many as never)).toThrow(`at most ${MAX_LABELS_PER_PRINT}`);
  });

  it('joins site and location into one line', () => {
    expect(labelPlaceLine({ site_name: 'Kololo', location: 'Front desk' })).toBe('Kololo · Front desk');
    expect(labelPlaceLine({ site_name: 'Entebbe Head Office', location: null })).toBe('Entebbe Head Office');
    expect(labelPlaceLine({ site_name: null, location: ' Store ' })).toBe('Store');
    expect(labelPlaceLine({ site_name: null, location: null })).toBe('');
  });

  it('prints WEL-ICT-HQ-001 and WEL-ICT-KOL-002 exactly, each with its own permanent code and its own uuid QR', async () => {
    const spy = vi.spyOn(QRCode, 'toDataURL');
    const doc = await buildAssetLabelsPdf([HQ_LAPTOP, KOL_LAPTOP] as never);
    const pdf = doc.output();
    expect(count(pdf, '(WEL-ICT-HQ-001)')).toBe(1);
    expect(count(pdf, '(WEL-ICT-KOL-002)')).toBe(1);
    expect(count(pdf, '(WEL-AST-000001)')).toBe(1);
    expect(count(pdf, '(WEL-AST-000002)')).toBe(1);
    for (const shown of ['IT equipment', 'Entebbe Head Office', 'Kololo', 'Front desk']) expect(pdf).toContain(shown);
    // each QR is generated from that asset's uuid URL, never from the tag or code
    expect(spy.mock.calls.map((c) => c[0])).toEqual([assetQrUrl(idN(1)), assetQrUrl(idN(2))]);
    expect((pdf.match(/\/Subtype \/Image/g) ?? []).length).toBe(2);
  });

  it('prints the tag prominently and the permanent code in smaller text below it', async () => {
    const doc = await buildAssetLabelsPdf([KOL_LAPTOP] as never);
    const pdf = doc.output();
    // jsPDF writes "<size> Tf" before each text run: the tag is set in 10 pt bold, the permanent code in 6 pt
    const tagAt = pdf.indexOf('(WEL-ICT-KOL-002)');
    const codeAt = pdf.indexOf('(WEL-AST-000002)');
    const fontBefore = (at: number) => { const m = [...pdf.slice(0, at).matchAll(/\/(F\d+) (\d+(?:\.\d+)?) Tf/g)].pop(); return m && { font: m[1], size: Number(m[2]) }; };
    expect(fontBefore(tagAt)?.size).toBe(10);
    expect(fontBefore(codeAt)?.size).toBe(6);
    expect(fontBefore(tagAt)?.font).not.toBe(fontBefore(codeAt)?.font); // bold vs regular
    expect(LABEL_LAYOUT.permanentCode).toBeGreaterThan(LABEL_LAYOUT.code);
  });

  it('prints an asset without a tag (registered before tags) with its asset code once, as the main code', async () => {
    const doc = await buildAssetLabelsPdf([fullAsset(5, { asset_tag: null, site_name: null })] as never);
    const pdf = doc.output();
    expect(count(pdf, '(WEL-AST-000005)')).toBe(1);
    expect(pdf).not.toContain('WEL-FUR-');
    expect(assetLabelsFileName(prepareLabels([fullAsset(5, { asset_tag: null })] as never))).toBe('WEL-AST-000005-label.pdf');
  });

  it('prints one label: company, QR, tag, code, category, site · location and ownership footer only', async () => {
    const doc = await buildAssetLabelsPdf([fullAsset(7)] as never);
    expect(doc.getNumberOfPages()).toBe(1);
    const pdf = doc.output();
    for (const shown of [LABEL_HEADER, 'WEL-FUR-HQ-007', 'WEL-AST-000007', 'Furniture', 'Entebbe Head Office', 'Headquarters', LABEL_FOOTER]) {
      expect(pdf).toContain(shown);
    }
    expect(pdf).toContain('/Subtype /Image');
    for (const secret of ['Laptop 7', 'SECRET-SERIAL-7', '9876543', '9,876,543', 'Confidential Supplier', 'Private Custodian', 'INV-PRIVATE', idN(7)]) {
      expect(pdf).not.toContain(secret);
    }
    expect(assetLabelsFileName(prepareLabels([fullAsset(7)] as never))).toBe('WEL-FUR-HQ-007-label.pdf');
  });

  it('omits the place line when an asset has neither site nor location', async () => {
    const doc = await buildAssetLabelsPdf([{ ...fullAsset(3), site_name: null, location: null }] as never);
    const pdf = doc.output();
    expect(pdf).not.toContain('Headquarters');
    expect(pdf).not.toContain('Entebbe Head Office');
  });

  it('keeps the stacked layout inside the label, with tags printed in full', () => {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const width = (font: string, size: number, s: string) => { doc.setFont('helvetica', font); doc.setFontSize(size); return doc.getTextWidth(s); };
    expect(width('bold', 6.5, LABEL_HEADER)).toBeLessThanOrEqual(LABEL_TEXT_WIDTH);
    for (const tag of ['WEL-ICT-HQ-001', 'WEL-ICT-KOL-002', 'WEL-OFE-KOL-123456', 'WEL-AST-9999999']) {
      expect(width('bold', 10, tag)).toBeLessThanOrEqual(LABEL_TEXT_WIDTH); // never shortened with "..."
    }
    expect(width('normal', 6, LABEL_FOOTER)).toBeLessThanOrEqual(LABEL_TEXT_WIDTH);
    const Y = LABEL_LAYOUT;
    expect(Y.qrTop).toBeGreaterThan(Y.header);
    expect(Y.qrTop + LABEL_SHEET.qrSize).toBeLessThan(Y.code - 2.5); // 10 pt cap height clears the QR
    const lines = [Y.code, Y.permanentCode, Y.category, Y.place, Y.footer];
    for (let i = 1; i < lines.length; i++) expect(lines[i] - lines[i - 1]).toBeGreaterThanOrEqual(2.5);
    expect(Y.footer).toBeLessThan(LABEL_SHEET.labelHeight - 1);
    expect(LABEL_SHEET.qrSize).toBeGreaterThanOrEqual(15); // ≈0.39 mm per module for a version-5 code
  });

  it('batch-prints a label per asset across pages', async () => {
    const n = LABELS_PER_PAGE + 2;
    const labels = Array.from({ length: n }, (_, i) => fullAsset(i + 1));
    const doc = await buildAssetLabelsPdf(labels as never);
    expect(doc.getNumberOfPages()).toBe(2);
    const pdf = doc.output();
    for (let i = 1; i <= n; i++) {
      expect(pdf).toContain(`(WEL-FUR-HQ-${pad(i, 3)})`);
      expect(pdf).toContain(`(WEL-AST-${pad(i, 6)})`);
    }
    expect((pdf.match(/\/Subtype \/Image/g) ?? []).length).toBe(n);
    expect(assetLabelsFileName(labels as never)).toBe(`welile-asset-labels-${n}.pdf`);
  });
});
