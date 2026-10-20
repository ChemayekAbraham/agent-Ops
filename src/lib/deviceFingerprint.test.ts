import { describe, it, expect, beforeEach } from 'vitest';
import { coarseUserAgent, getDeviceFingerprint, isValidFingerprintShape } from './deviceFingerprint';

const CHROME_120 = 'Mozilla/5.0 (Linux; Android 13; TECNO KI7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36';
const CHROME_131 = 'Mozilla/5.0 (Linux; Android 13; TECNO KI7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.81 Mobile Safari/537.36';

describe('device fingerprint v2', () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = 'welile_ds=; Max-Age=0; Path=/';
  });

  it('ignores browser version bumps', () => {
    expect(coarseUserAgent(CHROME_120)).toBe('android/chrome');
    expect(coarseUserAgent(CHROME_131)).toBe(coarseUserAgent(CHROME_120));
  });

  it('tells browser families apart', () => {
    expect(coarseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('ios/safari');
    expect(coarseUserAgent('Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0 Mobile Safari/537.36')).toBe('android/samsung');
  });

  it('is stable across calls and valid in shape', async () => {
    const a = await getDeviceFingerprint();
    const b = await getDeviceFingerprint();
    expect(a).toBe(b);
    expect(isValidFingerprintShape(a)).toBe(true);
  });

  it('survives clearing localStorage while the seed cookie remains', async () => {
    const before = await getDeviceFingerprint();
    localStorage.clear();
    expect(await getDeviceFingerprint()).toBe(before);
  });
});
