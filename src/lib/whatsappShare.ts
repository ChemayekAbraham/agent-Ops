/**
 * Shared WhatsApp deep-link flow for sharing a generated PDF.
 *
 * Strategy (best → graceful fallback):
 * 1. If the platform supports sharing files (Web Share API level 2 — most
 *    Android Chrome + iOS Safari), open the native share sheet with the PDF
 *    file attached. The user taps WhatsApp and the document is already there.
 * 2. Otherwise (desktop browsers, in-app webviews without file share), download
 *    the PDF locally and open a WhatsApp deep link pre-filled with a caption
 *    that tells the user to attach the file that was just saved.
 *
 * WhatsApp deep links cannot carry a file payload by spec, so step 1 is the
 * only path that auto-attaches the document — step 2 hands the user the file
 * plus a ready-to-send message.
 */

function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || '');
}

/** Build the right WhatsApp link for the current device. */
function buildWhatsAppLink(caption: string, phone?: string): string {
  const text = encodeURIComponent(caption);
  // `whatsapp://` deep link opens the installed app directly (mobile);
  // `wa.me` is the universal web fallback (desktop / no app installed).
  if (isMobileDevice()) {
    return phone
      ? `whatsapp://send?phone=${phone}&text=${text}`
      : `whatsapp://send?text=${text}`;
  }
  return phone
    ? `https://wa.me/${phone}?text=${text}`
    : `https://wa.me/?text=${text}`;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export interface WhatsAppShareOptions {
  /** File name used for the attachment / download. */
  filename: string;
  /** Caption / message text sent alongside the file. */
  caption: string;
  /** Optional recipient phone in international format, e.g. 2567... */
  phone?: string;
}

/**
 * Share a PDF blob through WhatsApp. Returns the path that was taken so callers
 * can show an appropriate toast.
 * - `'shared'`   → native share sheet succeeded (file attached).
 * - `'deeplink'` → file downloaded + WhatsApp deep link opened (attach manually).
 * - `'cancelled'`→ user dismissed the native share sheet.
 */
export async function sharePdfViaWhatsApp(
  blob: Blob,
  { filename, caption, phone }: WhatsAppShareOptions,
): Promise<'shared' | 'deeplink' | 'cancelled'> {
  const file = new File([blob], filename, { type: 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };

  // 1) Preferred: native share sheet with the file attached.
  if (typeof navigator !== 'undefined' && navigator.share && nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename, text: caption });
      return 'shared';
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return 'cancelled';
      // fall through to the deep-link fallback on any other error
    }
  }

  // 2) Fallback: download the file, then open WhatsApp with the caption so the
  //    user can attach the freshly-saved document.
  downloadBlob(blob, filename);
  const link = buildWhatsAppLink(caption, phone);
  window.open(link, '_blank', 'noopener,noreferrer');
  return 'deeplink';
}

/**
 * Share an image blob through WhatsApp. Mirrors {@link sharePdfViaWhatsApp} but
 * attaches an image file (so WhatsApp previews it inline) and falls back to a
 * local download + WhatsApp deep link when file sharing isn't supported.
 */
export async function shareImageViaWhatsApp(
  blob: Blob,
  { filename, caption, phone }: WhatsAppShareOptions,
): Promise<'shared' | 'deeplink' | 'cancelled'> {
  const type = blob.type || 'image/jpeg';
  const file = new File([blob], filename, { type });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };

  if (typeof navigator !== 'undefined' && navigator.share && nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename, text: caption });
      return 'shared';
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return 'cancelled';
    }
  }

  downloadBlob(blob, filename);
  const link = buildWhatsAppLink(caption, phone);
  window.open(link, '_blank', 'noopener,noreferrer');
  return 'deeplink';
}