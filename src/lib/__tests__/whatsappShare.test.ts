import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sharePdfViaWhatsApp } from '@/lib/whatsappShare';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}

function makeBlob() {
  return new Blob(['%PDF-1.4 test'], { type: 'application/pdf' });
}

const opts = {
  filename: 'Welile-Landlord-Registration-Form.pdf',
  caption: 'Welile Landlord Registration Form — please print, fill in, and return. welileapp.com',
};

describe('sharePdfViaWhatsApp', () => {
  let openSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    // jsdom lacks these — provide no-op implementations.
    if (!('createObjectURL' in URL)) {
      (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:mock';
    }
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    if (!('revokeObjectURL' in URL)) {
      (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    }
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // clean up overridden navigator props
    delete (navigator as { share?: unknown }).share;
    delete (navigator as { canShare?: unknown }).canShare;
  });

  it('Android: attaches the file via the native share sheet', async () => {
    setUserAgent(ANDROID_UA);
    const shared: ShareData[] = [];
    (navigator as { canShare?: (d: ShareData) => boolean }).canShare = (d) =>
      Array.isArray(d.files) && d.files.length > 0;
    (navigator as { share?: (d: ShareData) => Promise<void> }).share = async (d) => {
      shared.push(d);
    };

    const result = await sharePdfViaWhatsApp(makeBlob(), opts);

    expect(result).toBe('shared');
    expect(shared).toHaveLength(1);
    expect(shared[0].files?.[0]).toBeInstanceOf(File);
    expect(shared[0].files?.[0].name).toBe(opts.filename);
    expect(shared[0].files?.[0].type).toBe('application/pdf');
    expect(shared[0].text).toBe(opts.caption);
    // No fallback link when the file shared successfully.
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('iOS: attaches the file via the native share sheet', async () => {
    setUserAgent(IOS_UA);
    let receivedFile: File | undefined;
    (navigator as { canShare?: (d: ShareData) => boolean }).canShare = (d) =>
      Array.isArray(d.files) && d.files.length > 0;
    (navigator as { share?: (d: ShareData) => Promise<void> }).share = async (d) => {
      receivedFile = d.files?.[0];
    };

    const result = await sharePdfViaWhatsApp(makeBlob(), opts);

    expect(result).toBe('shared');
    expect(receivedFile?.name).toBe(opts.filename);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('user cancels the share sheet → reports cancelled, no fallback', async () => {
    setUserAgent(ANDROID_UA);
    (navigator as { canShare?: (d: ShareData) => boolean }).canShare = () => true;
    (navigator as { share?: (d: ShareData) => Promise<void> }).share = async () => {
      throw Object.assign(new DOMException('cancelled', 'AbortError'));
    };

    const result = await sharePdfViaWhatsApp(makeBlob(), opts);

    expect(result).toBe('cancelled');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('mobile without file share support → downloads + opens whatsapp:// deep link with caption', async () => {
    setUserAgent(ANDROID_UA);
    // No canShare / share available (older webview).
    const result = await sharePdfViaWhatsApp(makeBlob(), opts);

    expect(result).toBe('deeplink');
    expect(openSpy).toHaveBeenCalledTimes(1);
    const url = openSpy.mock.calls[0][0] as string;
    expect(url.startsWith('whatsapp://send?text=')).toBe(true);
    expect(url).toContain(encodeURIComponent(opts.caption));
  });

  it('desktop without file share support → downloads + opens wa.me link with caption', async () => {
    setUserAgent(DESKTOP_UA);
    const result = await sharePdfViaWhatsApp(makeBlob(), opts);

    expect(result).toBe('deeplink');
    const url = openSpy.mock.calls[0][0] as string;
    expect(url.startsWith('https://wa.me/?text=')).toBe(true);
    expect(url).toContain(encodeURIComponent(opts.caption));
  });

  it('share-sheet error (non-abort) falls back to the deep link', async () => {
    setUserAgent(ANDROID_UA);
    (navigator as { canShare?: (d: ShareData) => boolean }).canShare = () => true;
    (navigator as { share?: (d: ShareData) => Promise<void> }).share = async () => {
      throw new Error('NotAllowedError');
    };

    const result = await sharePdfViaWhatsApp(makeBlob(), opts);

    expect(result).toBe('deeplink');
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('includes the recipient phone in the deep link when provided', async () => {
    setUserAgent(ANDROID_UA);
    const result = await sharePdfViaWhatsApp(makeBlob(), { ...opts, phone: '256700000000' });

    expect(result).toBe('deeplink');
    const url = openSpy.mock.calls[0][0] as string;
    expect(url.startsWith('whatsapp://send?phone=256700000000&text=')).toBe(true);
  });
});