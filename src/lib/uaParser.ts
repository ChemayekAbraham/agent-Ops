/**
 * Lightweight, zero-dependency User Agent parser for Welile Behaviour Analytics.
 * Extracts OS name/version (e.g. Android 10, iOS 18, Windows 10),
 * Browser name/version (e.g. Chrome 154, Samsung Internet 30, Safari 16, Firefox 158),
 * and Device Class (Mobile, Tablet, Desktop).
 */

export interface ParsedUA {
  os: string;
  osFamily: 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'other';
  browser: string;
  browserFamily: 'chrome' | 'samsung' | 'safari' | 'firefox' | 'edge' | 'other';
  deviceClass: 'mobile' | 'tablet' | 'desktop';
  shortLabel: string;
}

export function parseUserAgent(ua?: string | null): ParsedUA {
  if (!ua || typeof ua !== 'string') {
    return {
      os: 'Unknown OS',
      osFamily: 'other',
      browser: 'Unknown Browser',
      browserFamily: 'other',
      deviceClass: 'desktop',
      shortLabel: 'Unknown Device',
    };
  }

  // 1. Device Class
  let deviceClass: 'mobile' | 'tablet' | 'desktop' = 'desktop';
  if (/iPad|tablet/i.test(ua)) {
    deviceClass = 'tablet';
  } else if (/Mobi|Android|iPhone|iPod/i.test(ua)) {
    deviceClass = 'mobile';
  }

  // 2. OS & Version
  let os = 'Unknown OS';
  let osFamily: ParsedUA['osFamily'] = 'other';

  const androidMatch = ua.match(/Android\s+([0-9]+(?:\.[0-9]+)?)/i);
  const iosMatch = ua.match(/(?:iPhone|iPad|iPod).*?OS\s+([0-9]+(?:[_.][0-9]+)?)/i);
  const windowsMatch = ua.match(/Windows\s+NT\s+([0-9]+(?:\.[0-9]+)?)/i);
  const macMatch = ua.match(/Mac\s+OS\s+X\s+([0-9]+(?:[_.][0-9]+)?)/i);

  if (androidMatch) {
    osFamily = 'android';
    os = `Android ${androidMatch[1]}`;
  } else if (iosMatch) {
    osFamily = 'ios';
    const ver = iosMatch[1].replace(/_/g, '.');
    os = `iOS ${ver}`;
  } else if (windowsMatch) {
    osFamily = 'windows';
    const ntVer = windowsMatch[1];
    if (ntVer === '10.0') os = 'Windows 10/11';
    else if (ntVer === '6.3') os = 'Windows 8.1';
    else if (ntVer === '6.1') os = 'Windows 7';
    else os = `Windows NT ${ntVer}`;
  } else if (macMatch) {
    osFamily = 'macos';
    os = `macOS ${macMatch[1].replace(/_/g, '.')}`;
  } else if (/Linux/i.test(ua)) {
    osFamily = 'linux';
    os = 'Linux';
  }

  // 3. Browser & Version
  let browser = 'Unknown Browser';
  let browserFamily: ParsedUA['browserFamily'] = 'other';

  const operaMatch = ua.match(/(?:OPR|Opera)\/([0-9]+)/i);
  const samsungMatch = ua.match(/SamsungBrowser\/([0-9]+(?:\.[0-9]+)?)/i);
  const ucMatch = ua.match(/UCBrowser\/([0-9]+(?:\.[0-9]+)?)/i);
  const edgeMatch = ua.match(/Edg(?:e|A|iOS)?\/([0-9]+)/i);
  const chromeMatch = ua.match(/(?:Chrome|CriOS)\/([0-9]+)/i);
  const firefoxMatch = ua.match(/(?:Firefox|FxiOS)\/([0-9]+)/i);
  const safariMatch = ua.match(/Version\/([0-9]+(?:\.[0-9]+)?).*?Safari/i);

  if (operaMatch) {
    browserFamily = 'other';
    browser = `Opera ${operaMatch[1]}`;
  } else if (samsungMatch) {
    browserFamily = 'samsung';
    browser = `Samsung Internet ${samsungMatch[1]}`;
  } else if (ucMatch) {
    browserFamily = 'other';
    browser = `UC Browser ${ucMatch[1]}`;
  } else if (edgeMatch) {
    browserFamily = 'edge';
    browser = `Edge ${edgeMatch[1]}`;
  } else if (chromeMatch) {
    browserFamily = 'chrome';
    browser = `Chrome ${chromeMatch[1]}`;
  } else if (firefoxMatch) {
    browserFamily = 'firefox';
    browser = `Firefox ${firefoxMatch[1]}`;
  } else if (safariMatch) {
    browserFamily = 'safari';
    browser = `Safari ${safariMatch[1]}`;
  } else if (/Safari/i.test(ua) && !chromeMatch) {
    browserFamily = 'safari';
    browser = 'Safari';
  }

  return {
    os,
    osFamily,
    browser,
    browserFamily,
    deviceClass,
    shortLabel: `${os} • ${browser}`,
  };
}
