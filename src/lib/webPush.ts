// Web Push helpers shared by the subscription UI.
//
// The VAPID *public* key is safe to ship in client code — it is the public half
// of the keypair. The matching private key lives only in the
// `send-push-notification` edge function (VAPID_PRIVATE_KEY secret).
export const VAPID_PUBLIC_KEY =
  "BGBr-FpnY4VrB-Whq9rXDTjeiH7vGXCquZk1kmkET87x12qkW073Tx-J8qJHcLW-8j4534x05f80WdLHPmnsKz0";

/**
 * Notifications are branded to the canonical app domain. A subscription that
 * was created on a legacy host makes the browser label every notification with
 * that old hostname, so we refuse to create new ones there and clean up any
 * that already exist.
 */
const LEGACY_PUSH_HOSTS = [
  "welilereceipts.com", // legacy-domain-guard-allow
  "welilereciept.com", // legacy-domain-guard-allow
];

/** True when the current host must not own a push subscription. */
export function isLegacyPushOrigin(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.replace(/^www\./, "").toLowerCase();
  return LEGACY_PUSH_HOSTS.includes(host);
}

/**
 * Removes any push subscription registered on a legacy host so notifications
 * are only ever delivered — and branded — from welileapp.com. Safe no-op on
 * the canonical domain.
 */
export async function purgeLegacyOriginPush(
  deleteByEndpoint?: (endpoint: string) => Promise<void>,
): Promise<boolean> {
  if (!isPushSupported() || !isLegacyPushOrigin()) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/sw.js");
    if (!registration) return false;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      if (deleteByEndpoint) {
        try { await deleteByEndpoint(subscription.endpoint); } catch { /* ignore */ }
      }
      try { await subscription.unsubscribe(); } catch { /* ignore */ }
    }
    try { await registration.unregister(); } catch { /* ignore */ }
    return true;
  } catch (err) {
    console.warn("purgeLegacyOriginPush failed:", err);
    return false;
  }
}

/**
 * Converts a base64url VAPID public key into the Uint8Array the
 * PushManager.subscribe() `applicationServerKey` option requires.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");

  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** Returns the base64-encoded value of a PushSubscription key (p256dh / auth). */
export function arrayBufferToBase64(buffer: BufferSource | null): string {
  if (!buffer) return "";
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Returns true when a browser PushSubscription was created with the current public VAPID key. */
export function subscriptionUsesCurrentVapidKey(subscription: PushSubscription): boolean {
  const key = subscription.options?.applicationServerKey;
  if (!key) return false;

  const encodedKey = arrayBufferToBase64(key)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return encodedKey === VAPID_PUBLIC_KEY;
}

/** True when the current browser can register a SW and subscribe to push. */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export type EnsurePushResult =
  | { ok: true; endpoint: string; p256dh: string; auth: string }
  | {
      ok: false;
      reason: "unsupported" | "blocked" | "dismissed" | "error" | "iframe" | "legacy-origin";
      message: string;
    };

/**
 * True when the app is running inside an iframe (e.g. the Lovable preview).
 * Browsers refuse Notification.requestPermission() inside a cross-origin iframe
 * and return "denied" immediately — which looks like the user blocked the site
 * even though they never did. Push must be tested in a full browser tab.
 */
export function isInIframe(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin access to window.top throws — that only happens in an iframe.
    return true;
  }
}

/**
 * Short, browser-aware instructions for re-allowing notifications after the user
 * has *blocked* them. Once permission is "denied" the browser silently refuses
 * every requestPermission() call — the only path back is the site settings, so
 * we tell the user exactly where to look.
 */
export function getUnblockInstructions(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  const isFirefox = /firefox|fxios/i.test(ua);

  if (isIOS) {
    return "Open iOS Settings → Notifications → find this app/Safari, then allow notifications and reload.";
  }
  if (isSafari) {
    return "Safari → Settings → Websites → Notifications → set this site to Allow, then reload.";
  }
  if (isFirefox) {
    return "Tap the lock icon in the address bar → clear the Notifications block → reload, then tap Test again.";
  }
  // Chrome / Edge / most Chromium browsers
  return "Tap the lock icon (left of the address bar) → Site settings → Notifications → Allow, then reload and tap Test again.";
}

/**
 * Ensures the current device has a valid, up-to-date web push subscription and
 * that it is saved to `push_subscriptions` for the given user.
 *
 * Flow:
 *  1. Requests Notification permission (prompts the browser if not decided yet).
 *  2. Registers the push service worker (`/sw.js`).
 *  3. Reuses a valid subscription, or replaces a stale-key / missing one.
 *  4. Upserts endpoint + keys via the provided saver.
 *
 * Returns a discriminated result so callers can react without duplicating the
 * permission / subscription plumbing.
 */
export async function ensurePushSubscription(
  saveSubscription: (sub: { endpoint: string; p256dh: string; auth: string }) => Promise<void>,
  deleteByEndpoint?: (endpoint: string) => Promise<void>,
): Promise<EnsurePushResult> {
  if (!isPushSupported()) {
    return {
      ok: false,
      reason: "unsupported",
      message: "This browser or device does not support web push notifications.",
    };
  }

  // Only the canonical app domain may own a subscription, so notifications are
  // always branded welileapp.com.
  if (isLegacyPushOrigin()) {
    await purgeLegacyOriginPush(deleteByEndpoint);
    return {
      ok: false,
      reason: "legacy-origin",
      message:
        "Open the app at welileapp.com to enable notifications — this old address can't send branded alerts.",
    };
  }

  try {
    // Inside the preview iframe the permission prompt is silently denied by the
    // browser's Permissions Policy. Detect that up front so we don't mislabel it
    // as "blocked" — the user needs to open the app in a real browser tab.
    if (isInIframe() && Notification.permission !== "granted") {
      return {
        ok: false,
        reason: "iframe",
        message:
          "Notifications can't be enabled inside the in-app preview. Open the app in a full browser tab (or the published/installed app), then tap Test again.",
      };
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return {
        ok: false,
        reason: permission === "denied" ? "blocked" : "dismissed",
        message:
          permission === "denied"
            ? `Notifications are blocked for this site. ${getUnblockInstructions()}`
            : "Notification permission wasn't granted. Tap Test again and choose Allow.",
      };
    }

    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !subscriptionUsesCurrentVapidKey(subscription)) {
      if (deleteByEndpoint) await deleteByEndpoint(subscription.endpoint);
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
      });
    }

    const json = subscription.toJSON();
    const p256dh = json.keys?.p256dh ?? arrayBufferToBase64(subscription.getKey("p256dh"));
    const auth = json.keys?.auth ?? arrayBufferToBase64(subscription.getKey("auth"));
    if (!p256dh || !auth) {
      return {
        ok: false,
        reason: "error",
        message: "This device subscription is incomplete. Turn notifications off and on again, then test.",
      };
    }

    await saveSubscription({ endpoint: subscription.endpoint, p256dh, auth });
    return { ok: true, endpoint: subscription.endpoint, p256dh, auth };
  } catch (err) {
    console.error("ensurePushSubscription failed:", err);
    return {
      ok: false,
      reason: "error",
      message: "Could not enable notifications on this device. Please try again.",
    };
  }
}

/**
 * Revokes the current device's web push subscription and removes the matching
 * `push_subscriptions` row so the previously signed-in user no longer receives
 * notifications on this device. Must be called while the user is still
 * authenticated (before `supabase.auth.signOut()`), otherwise RLS blocks the
 * DELETE.
 */
export async function revokeCurrentDevicePush(
  deleteByEndpoint: (endpoint: string) => Promise<void>,
): Promise<void> {
  if (!isPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/sw.js");
    if (!registration) return;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    try { await deleteByEndpoint(subscription.endpoint); } catch (err) {
      console.warn("revokeCurrentDevicePush: delete row failed", err);
    }
    try { await subscription.unsubscribe(); } catch (err) {
      console.warn("revokeCurrentDevicePush: unsubscribe failed", err);
    }
  } catch (err) {
    console.warn("revokeCurrentDevicePush failed:", err);
  }
}