import { formatUGX } from '@/lib/rentCalculations';
import welileLogoUrl from '@/assets/welile-logo.png';
import type { RentAccessLimitResult } from '@/lib/rentAccessLimit';
import { getShareCardThemeSync } from '@/hooks/useShareCardTheme';
import QRCode from 'qrcode';

/**
 * Bumped whenever the visual layout of the branded share card / PDF changes.
 * Recorded in `rent_access_share_audit.image_version` so reporting can tie a
 * share event back to the exact card variant that the tenant received.
 */
export const RENT_ACCESS_CARD_IMAGE_VERSION = '2026-05-19.qr-v1';

export interface RentAccessLimitPdfData {
  tenantName: string;
  tenantPhone: string;
  aiId?: string;
  monthlyRent: number;
  result: RentAccessLimitResult;
  shareUrl?: string | null;
}

async function loadLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
    return await new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Render a QR code (PNG data URL) for the given URL. Returns null on failure. */
async function generateQrDataUrl(
  url: string,
  size: number,
  opts?: { dark?: string; light?: string },
): Promise<string | null> {
  try {
    return await QRCode.toDataURL(url, {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {
        dark: opts?.dark ?? '#0f172a',
        light: opts?.light ?? '#ffffff',
      },
    });
  } catch {
    return null;
  }
}

/** Render a QR code as an HTMLImageElement for canvas drawing. */
async function loadQrImage(url: string, size: number): Promise<HTMLImageElement | null> {
  const dataUrl = await generateQrDataUrl(url, size);
  if (!dataUrl) return null;
  try {
    const img = new Image();
    img.src = dataUrl;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('qr load failed'));
    });
    return img;
  } catch {
    return null;
  }
}

/** Generate a one-page branded "Rent Access Certificate" PDF as a Blob. */
export async function generateRentAccessLimitPdf(data: RentAccessLimitPdfData): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 16;
  let y = 16;

  const logo = await loadLogoBase64();
  if (logo) pdf.addImage(logo, 'PNG', margin, y - 4, 14, 14);

  const textX = margin + 18;
  pdf.setFontSize(15);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(30, 41, 59);
  pdf.text('Welile Technologies Limited', textX, y + 2);

  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(100, 116, 139);
  pdf.text('Rent Access Certificate', textX, y + 7);
  pdf.text(new Date().toLocaleDateString('en-UG', { year: 'numeric', month: 'long', day: 'numeric' }), pw - margin, y + 7, { align: 'right' });

  y += 18;

  // Accent line
  pdf.setDrawColor(59, 130, 246);
  pdf.setLineWidth(0.8);
  pdf.line(margin, y, pw - margin, y);
  y += 10;

  // Tenant block
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(100, 116, 139);
  pdf.text('Issued to', margin, y);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(14);
  pdf.setTextColor(30, 41, 59);
  pdf.text(data.tenantName, margin, y + 7);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(100, 116, 139);
  pdf.text(`${data.tenantPhone}${data.aiId ? ' · ' + data.aiId : ''}`, margin, y + 12);
  y += 22;

  // BIG NUMBER PANEL
  const panelH = 38;
  pdf.setFillColor(241, 245, 249);
  pdf.roundedRect(margin, y, pw - margin * 2, panelH, 4, 4, 'F');

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(59, 130, 246);
  pdf.text('YOUR RENT ACCESS LIMIT', margin + 6, y + 9);

  pdf.setFontSize(28);
  pdf.setTextColor(15, 23, 42);
  pdf.text(formatUGX(data.result.limit), margin + 6, y + 24);

  const pct = data.result.netAdjustmentPct * 100;
  const pctColor: [number, number, number] = pct >= 0 ? [22, 163, 74] : [220, 38, 38];
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(100, 116, 139);
  pdf.text(
    `Base ${formatUGX(data.result.base)}  ·  `,
    margin + 6,
    y + 32,
  );
  const baseLabelWidth = pdf.getTextWidth(`Base ${formatUGX(data.result.base)}  ·  `);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(...pctColor);
  pdf.text(`${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% from daily payments`, margin + 6 + baseLabelWidth, y + 32);

  y += panelH + 10;

  // Stats row
  const colW = (pw - margin * 2 - 8) / 3;
  const statBox = (i: number, label: string, value: string, color: [number, number, number]) => {
    const x = margin + i * (colW + 4);
    pdf.setFillColor(255, 255, 255);
    pdf.setDrawColor(226, 232, 240);
    pdf.roundedRect(x, y, colW, 18, 3, 3, 'FD');
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(...color);
    pdf.text(value, x + colW / 2, y + 8, { align: 'center' });
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 116, 139);
    pdf.text(label, x + colW / 2, y + 14, { align: 'center' });
  };
  statBox(0, 'On-time days', String(data.result.paidDays), [22, 163, 74]);
  statBox(1, 'Missed days', String(data.result.missedDays), [220, 38, 38]);
  statBox(2, 'Tracked', String(data.result.trackedDays), [30, 41, 59]);

  y += 26;

  // How it works
  pdf.setFillColor(248, 250, 252);
  pdf.roundedRect(margin, y, pw - margin * 2, 32, 3, 3, 'F');
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(30, 41, 59);
  pdf.text('How your limit grows', margin + 5, y + 7);
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(71, 85, 105);
  pdf.text('•  Base limit  =  monthly rent  ×  12', margin + 5, y + 14);
  pdf.setTextColor(22, 163, 74);
  pdf.text('•  +5% of base for every day you pay on time', margin + 5, y + 21);
  pdf.setTextColor(220, 38, 38);
  pdf.text('•  -5% of base for every missed day', margin + 5, y + 28);

  y += 40;

  // Marketing tagline
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(13);
  pdf.setTextColor(59, 130, 246);
  pdf.text('Pay today. Unlock more rent tomorrow.', pw / 2, y, { align: 'center' });
  y += 8;

  if (data.shareUrl) {
    // QR code that links back to the live limit page
    const qrSize = 32; // mm
    const qrDataUrl = await generateQrDataUrl(data.shareUrl, 512);
    const qrX = (pw - qrSize) / 2;
    if (qrDataUrl) {
      pdf.addImage(qrDataUrl, 'PNG', qrX, y + 2, qrSize, qrSize);
    }
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(100, 116, 139);
    pdf.text('Scan to view live limit', pw / 2, y + qrSize + 6, { align: 'center' });
    pdf.setFontSize(7);
    pdf.setTextColor(148, 163, 184);
    pdf.text(data.shareUrl, pw / 2, y + qrSize + 11, { align: 'center' });
  }

  // Footer
  pdf.setFontSize(7);
  pdf.setTextColor(148, 163, 184);
  pdf.text(
    'This certificate is informational. Final access subject to Welile review and applicable terms.',
    pw / 2,
    ph - 10,
    { align: 'center' },
  );

  return pdf.output('blob');
}

/** Load the Welile logo as an HTMLImageElement (best-effort, returns null on failure). */
async function loadLogoImage(): Promise<HTMLImageElement | null> {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = welileLogoUrl;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('logo load failed'));
    });
    return img;
  } catch {
    return null;
  }
}

/** Render a square PNG share card via offscreen <canvas>. Returns a Blob. */
export async function generateRentAccessLimitPng(data: RentAccessLimitPdfData): Promise<Blob> {
  const W = 1080;
  const H = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported');

  // Theme-driven gradient (agent-customizable; default Welile purple)
  const theme = getShareCardThemeSync();
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, theme.gradient[0]);
  grad.addColorStop(0.5, theme.gradient[1]);
  grad.addColorStop(1, theme.gradient[2]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Soft glow orbs from the same theme
  const orb = (x: number, y: number, r: number, color: string) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  orb(880, 180, 380, theme.orbA);
  orb(140, 940, 380, theme.orbB);

  // Top brand row — logo + wordmark
  const logo = await loadLogoImage();
  let brandTextX = 64;
  if (logo) {
    const logoSize = 72;
    // White rounded backdrop so the logo always reads on purple
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    const r = 18;
    const lx = 64;
    const ly = 56;
    ctx.beginPath();
    ctx.moveTo(lx + r, ly);
    ctx.arcTo(lx + logoSize, ly, lx + logoSize, ly + logoSize, r);
    ctx.arcTo(lx + logoSize, ly + logoSize, lx, ly + logoSize, r);
    ctx.arcTo(lx, ly + logoSize, lx, ly, r);
    ctx.arcTo(lx, ly, lx + logoSize, ly, r);
    ctx.closePath();
    ctx.fill();
    ctx.drawImage(logo, lx + 6, ly + 6, logoSize - 12, logoSize - 12);
    brandTextX = lx + logoSize + 18;
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 44px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('Welile', brandTextX, 62);

  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '600 22px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.fillText('Rent Money You Can Get', brandTextX, 112);

  // Tenant
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '600 28px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.fillText('For', 64, 240);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 56px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.fillText(data.tenantName, 64, 280);

  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '500 24px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.fillText(`${data.tenantPhone}${data.aiId ? '  ·  ' + data.aiId : ''}`, 64, 350);

  // Big limit
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = 'bold 28px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.fillText('WELILE CAN PAY YOUR RENT UP TO', 64, 460);

  ctx.fillStyle = '#ffffff';
  ctx.font = '900 110px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  // Auto-shrink if too wide
  let limitText = formatUGX(data.result.limit);
  let size = 110;
  while (ctx.measureText(limitText).width > W - 128 && size > 56) {
    size -= 6;
    ctx.font = `900 ${size}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  }
  ctx.fillText(limitText, 64, 510);

  const pct = data.result.netAdjustmentPct * 100;
  const pctText = `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% from your daily payments`;
  ctx.fillStyle = pct >= 0 ? '#bbf7d0' : '#fecaca';
  ctx.font = '700 28px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.fillText(pctText, 64, 660);

  // Stats pills
  const pillY = 760;
  const pillW = (W - 128 - 32) / 3;
  const drawPill = (i: number, label: string, value: string) => {
    const x = 64 + i * (pillW + 16);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    const r = 24;
    ctx.beginPath();
    ctx.moveTo(x + r, pillY);
    ctx.arcTo(x + pillW, pillY, x + pillW, pillY + 110, r);
    ctx.arcTo(x + pillW, pillY + 110, x, pillY + 110, r);
    ctx.arcTo(x, pillY + 110, x, pillY, r);
    ctx.arcTo(x, pillY, x + pillW, pillY, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(value, x + pillW / 2, pillY + 16);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '600 20px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(label, x + pillW / 2, pillY + 70);
    ctx.textAlign = 'left';
  };
  drawPill(0, 'On-time', String(data.result.paidDays));
  drawPill(1, 'Missed', String(data.result.missedDays));
  drawPill(2, 'Days', String(data.result.trackedDays));

  // Tagline
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 32px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Pay today. Get more rent money tomorrow.', W / 2, 920);

  if (data.shareUrl) {
    // QR code card — bottom-right corner, white backdrop for max scannability
    const qrSize = 180;
    const pad = 18;
    const cardW = qrSize + pad * 2;
    const cardH = qrSize + pad * 2 + 28; // extra space for caption
    const cardX = W - cardW - 48;
    const cardY = H - cardH - 48;
    const r = 22;

    // Rounded white card
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cardX + r, cardY);
    ctx.arcTo(cardX + cardW, cardY, cardX + cardW, cardY + cardH, r);
    ctx.arcTo(cardX + cardW, cardY + cardH, cardX, cardY + cardH, r);
    ctx.arcTo(cardX, cardY + cardH, cardX, cardY, r);
    ctx.arcTo(cardX, cardY, cardX + cardW, cardY, r);
    ctx.closePath();
    ctx.fill();

    const qrImg = await loadQrImage(data.shareUrl, qrSize * 2);
    if (qrImg) {
      ctx.drawImage(qrImg, cardX + pad, cardY + pad, qrSize, qrSize);
    }

    ctx.fillStyle = '#0f172a';
    ctx.font = '700 18px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Scan for live limit', cardX + cardW / 2, cardY + qrSize + pad + 4);

    // URL on the left side so it doesn't collide with the QR card
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '500 20px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(data.shareUrl, 64, H - 72);
  }
  ctx.textAlign = 'left';

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png', 0.95);
  });
}
