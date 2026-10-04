import { formatUGX } from '@/lib/rentCalculations';
import welileLogoUrl from '@/assets/welile-logo.png';

export interface PayoutCardData {
  /** Partner / beneficiary full name. */
  partnerName: string;
  /** Portfolio label (account name or code). */
  portfolioName?: string;
  /** Human-readable payout date, e.g. "15 Jun 2026". */
  payoutDate?: string;
  /** Amount to be paid out, in UGX. */
  amount: number;
  mode?: 'mobile_money' | 'bank_transfer' | 'cash' | null;
  /** MTN / Airtel etc. */
  provider?: string | null;
  /** The name the mobile money account shows. */
  momoName?: string | null;
  momoNumber?: string | null;
  bankName?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  /** Optional reference / note rendered at the bottom. */
  reference?: string | null;
}

const PURPLE = '#6c21c4';
const PURPLE_DARK = '#4c1696';
const INK = '#0f172a';
const MUTED = '#64748b';

function loadLogo(): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = welileLogoUrl;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Build the destination (payment) lines for the card. */
function paymentLines(data: PayoutCardData): { title: string; lines: string[] } {
  if (data.mode === 'bank_transfer') {
    return {
      title: `${(data.bankName || 'Bank').toUpperCase()} · BANK TRANSFER`,
      lines: [
        data.bankAccountName || data.partnerName || '—',
        `A/C ${data.bankAccountNumber || '—'}`,
      ],
    };
  }
  if (data.mode === 'cash') {
    return { title: 'CASH PICKUP', lines: ['Collect in person'] };
  }
  // Default: mobile money
  return {
    title: `${(data.provider || 'Mobile Money').toUpperCase()} MOBILE MONEY`,
    lines: [
      data.momoName || data.partnerName || 'Name not set',
      data.momoNumber || '—',
    ],
  };
}

/**
 * Render a branded, WhatsApp-ready payout card to a PNG Blob.
 * Welile logo sits top-left; the card shows the beneficiary name, payout date,
 * the mobile-money registered name + number (or bank details) and the amount.
 */
export async function generatePayoutCardImage(data: PayoutCardData): Promise<Blob> {
  const W = 1080;
  const H = 1080;
  const scale = 2; // crisp on retina / when shared
  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Header band
  ctx.fillStyle = PURPLE;
  ctx.fillRect(0, 0, W, 170);
  ctx.fillStyle = PURPLE_DARK;
  ctx.fillRect(0, 170, W, 8);

  // Logo (top-left), on a white rounded chip for contrast
  const logo = await loadLogo();
  const chip = 96;
  const chipX = 56;
  const chipY = 40;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, chipX, chipY, chip, chip, 20);
  ctx.fill();
  if (logo) {
    const pad = 12;
    const maxDim = chip - pad * 2;
    const ratio = Math.min(maxDim / logo.width, maxDim / logo.height);
    const dw = logo.width * ratio;
    const dh = logo.height * ratio;
    ctx.drawImage(logo, chipX + (chip - dw) / 2, chipY + (chip - dh) / 2, dw, dh);
  }

  // Company text next to logo
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 38px Helvetica, Arial, sans-serif';
  ctx.fillText('Welile', chipX + chip + 28, chipY + 44);
  ctx.font = '400 22px Helvetica, Arial, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText('Payout Notification', chipX + chip + 28, chipY + 78);

  // "PAYOUT" pill on the right of header
  ctx.font = '700 20px Helvetica, Arial, sans-serif';
  const pillText = 'PAYOUT';
  const pillW = ctx.measureText(pillText).width + 44;
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  roundRect(ctx, W - 56 - pillW, 60, pillW, 48, 24);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(pillText, W - 56 - pillW + 22, 91);

  let y = 250;
  const left = 64;

  // Partner name (big)
  ctx.fillStyle = MUTED;
  ctx.font = '600 22px Helvetica, Arial, sans-serif';
  ctx.fillText('BENEFICIARY', left, y);
  y += 44;
  ctx.fillStyle = INK;
  ctx.font = '700 52px Helvetica, Arial, sans-serif';
  ctx.fillText(truncate(ctx, data.partnerName || '—', W - left * 2, '700 52px Helvetica, Arial, sans-serif'), left, y);
  y += 36;
  if (data.portfolioName) {
    ctx.fillStyle = MUTED;
    ctx.font = '400 26px Helvetica, Arial, sans-serif';
    ctx.fillText(truncate(ctx, `📁 ${data.portfolioName}`, W - left * 2, '400 26px Helvetica, Arial, sans-serif'), left, y);
    y += 24;
  }

  // Amount highlight box
  y += 28;
  const boxH = 150;
  ctx.fillStyle = '#f5f0fc';
  roundRect(ctx, left, y, W - left * 2, boxH, 24);
  ctx.fill();
  ctx.fillStyle = MUTED;
  ctx.font = '600 24px Helvetica, Arial, sans-serif';
  ctx.fillText('AMOUNT', left + 36, y + 50);
  ctx.fillStyle = PURPLE;
  ctx.font = '800 64px Helvetica, Arial, sans-serif';
  ctx.fillText(formatUGX(data.amount || 0), left + 36, y + 118);
  y += boxH + 48;

  // Payout date row
  if (data.payoutDate) {
    ctx.fillStyle = MUTED;
    ctx.font = '600 22px Helvetica, Arial, sans-serif';
    ctx.fillText('PAYOUT DATE', left, y);
    ctx.fillStyle = INK;
    ctx.font = '700 30px Helvetica, Arial, sans-serif';
    ctx.fillText(data.payoutDate, left, y + 38);
    y += 84;
  }

  // Destination / mobile money details
  const pay = paymentLines(data);
  ctx.fillStyle = MUTED;
  ctx.font = '600 22px Helvetica, Arial, sans-serif';
  ctx.fillText('SEND TO', left, y);
  y += 38;
  ctx.fillStyle = PURPLE_DARK;
  ctx.font = '700 28px Helvetica, Arial, sans-serif';
  ctx.fillText(pay.title, left, y);
  y += 44;
  ctx.fillStyle = INK;
  for (const ln of pay.lines) {
    ctx.font = '700 38px Helvetica, Arial, sans-serif';
    ctx.fillText(truncate(ctx, ln, W - left * 2, '700 38px Helvetica, Arial, sans-serif'), left, y);
    y += 50;
  }

  // Footer
  ctx.fillStyle = PURPLE;
  ctx.fillRect(0, H - 80, W, 80);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = '400 22px Helvetica, Arial, sans-serif';
  const footer = data.reference
    ? `Ref: ${data.reference}  ·  Welile Technologies Limited`
    : 'Welile Technologies Limited  ·  www.welile.com';
  ctx.fillText(footer, left, H - 32);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to render payout card'));
    }, 'image/png');
  });
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, font: string): string {
  const prev = ctx.font;
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.font = prev;
    return text;
  }
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) {
    t = t.slice(0, -1);
  }
  ctx.font = prev;
  return t + '…';
}

function buildShareText(data: PayoutCardData): string {
  const pay = paymentLines(data);
  return [
    `💸 *Welile Payout*`,
    ``,
    `👤 ${data.partnerName}`,
    data.portfolioName ? `📁 ${data.portfolioName}` : null,
    `💰 Amount: ${formatUGX(data.amount || 0)}`,
    data.payoutDate ? `📅 Date: ${data.payoutDate}` : null,
    ``,
    `*Send to:* ${pay.title}`,
    ...pay.lines.map((l) => `   ${l}`),
    data.reference ? `\nRef: ${data.reference}` : null,
    ``,
    `_Welile Technologies Limited_`,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** Trigger a browser download of the card image. */
function downloadImage(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export interface ShareResult {
  /** 'shared' = native share sheet used; 'downloaded' = image saved + WhatsApp opened with text. */
  method: 'shared' | 'downloaded';
}

/**
 * Share the branded payout card on WhatsApp.
 * On supporting devices (mobile) it uses the native share sheet with the image
 * attached. Otherwise it downloads the image and opens WhatsApp pre-filled with
 * the same details as text so the operator can attach the saved image.
 */
export async function sharePayoutCardViaWhatsApp(data: PayoutCardData): Promise<ShareResult> {
  const blob = await generatePayoutCardImage(data);
  const safeName = (data.partnerName || 'payout').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const filename = `welile-payout-${safeName}.png`;
  const text = buildShareText(data);

  // Native share with file (best on mobile — lands straight in WhatsApp).
  try {
    const file = new File([blob], filename, { type: 'image/png' });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
      await nav.share({ files: [file], text, title: 'Welile Payout' });
      return { method: 'shared' };
    }
  } catch {
    // User cancelled or share failed — fall back to download path.
  }

  // Fallback: save the image and open WhatsApp with the text details.
  downloadImage(blob, filename);
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  return { method: 'downloaded' };
}