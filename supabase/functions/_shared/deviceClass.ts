// User-agent classification for dashboard-link opens (Stage 4D).
//
// The only question that matters here: does this open PROVE the tenant has a
// smartphone? Getting that wrong in either direction is costly --
// under-counting leaves tenants stuck on SMS forever, over-counting routes
// people to a dashboard they cannot open and marks the data useless.
//
// Deliberately conservative. Only an Android phone or an iPhone browser counts.
// Everything else is logged as engagement but leaves smartphone_status alone:
//
//   * link-preview bots -- WhatsApp, Facebook and Telegram fetch every URL
//     they are sent, so a forwarded link would otherwise "confirm" a
//     smartphone the tenant never touched. This is the single most likely
//     source of false positives, because these SMS links get forwarded.
//   * tablets -- an iPad or Android tablet is not the phone the tenant
//     carries, and routing payment notices to it would miss them.
//   * desktop -- the tenant may be at an agent's or a friend's computer.
//   * anything unrecognised -- absence of evidence is not evidence.

export type DeviceClass =
  | "android_phone"
  | "iphone"
  | "tablet"
  | "desktop"
  | "bot"
  | "unknown";

export interface DeviceInfo {
  deviceClass: DeviceClass;
  browser: string;
  os: string;
  /** True only for android_phone and iphone. Drives smartphone confirmation. */
  isSmartphoneEvidence: boolean;
}

// Preview fetchers and crawlers. WhatsApp is first because SMS links are
// routinely forwarded into WhatsApp chats, which fetches them unprompted.
const BOT_PATTERNS = [
  /WhatsApp/i,
  /facebookexternalhit/i,
  /Facebot/i,
  /TelegramBot/i,
  /Twitterbot/i,
  /Slackbot/i,
  /LinkedInBot/i,
  /Discordbot/i,
  /SkypeUriPreview/i,
  /Google-?bot/i,
  /bingbot/i,
  /YandexBot/i,
  /DuckDuckBot/i,
  /AhrefsBot/i,
  /SemrushBot/i,
  /HeadlessChrome/i,
  /PhantomJS/i,
  /\bbot\b/i,
  /crawler/i,
  /spider/i,
  /preview/i,
  /curl\//i,
  /wget/i,
  /python-requests/i,
  /axios\//i,
  /node-fetch/i,
  /Go-http-client/i,
  /okhttp/i,
];

function detectBrowser(ua: string): string {
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\/|Opera/i.test(ua)) return "Opera";
  if (/SamsungBrowser/i.test(ua)) return "Samsung Internet";
  if (/UCBrowser/i.test(ua)) return "UC Browser";
  if (/Firefox\//i.test(ua)) return "Firefox";
  // Chrome must be tested before Safari: Chrome's UA contains "Safari".
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua)) return "Safari";
  return "Other";
}

function detectOs(ua: string): string {
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPod/i.test(ua)) return "iOS";
  if (/iPad/i.test(ua)) return "iPadOS";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Other";
}

export function classifyDevice(userAgent: string | null | undefined): DeviceInfo {
  const ua = String(userAgent ?? "").trim();

  if (!ua) {
    return { deviceClass: "unknown", browser: "Other", os: "Other", isSmartphoneEvidence: false };
  }

  const browser = detectBrowser(ua);
  const os = detectOs(ua);

  if (BOT_PATTERNS.some((re) => re.test(ua))) {
    return { deviceClass: "bot", browser, os, isSmartphoneEvidence: false };
  }

  // iPad reports "Macintosh" in desktop mode, so check the explicit tablet
  // markers before anything else.
  if (/iPad/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) || /Tablet/i.test(ua)) {
    return { deviceClass: "tablet", browser, os, isSmartphoneEvidence: false };
  }

  // Android phones carry both "Android" and "Mobile"; tablets omit "Mobile".
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) {
    return { deviceClass: "android_phone", browser, os, isSmartphoneEvidence: true };
  }

  if (/iPhone|iPod/i.test(ua)) {
    return { deviceClass: "iphone", browser, os, isSmartphoneEvidence: true };
  }

  if (/Windows|Macintosh|Mac OS X|X11|Linux/i.test(ua)) {
    return { deviceClass: "desktop", browser, os, isSmartphoneEvidence: false };
  }

  return { deviceClass: "unknown", browser, os, isSmartphoneEvidence: false };
}

/** SHA-256 hex. Used for both link tokens and IP addresses. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * URL-safe opaque token. 32 bytes of CSPRNG output, so the tenant UUID never
 * appears in the link and the token cannot be guessed or enumerated.
 */
export function generateLinkToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
