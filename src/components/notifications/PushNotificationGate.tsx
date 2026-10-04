import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Bell, BellRing, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  VAPID_PUBLIC_KEY,
  arrayBufferToBase64,
  isInIframe,
  isPushSupported,
  isLegacyPushOrigin,
  purgeLegacyOriginPush,
  subscriptionUsesCurrentVapidKey,
  urlBase64ToUint8Array,
} from "@/lib/webPush";

/**
 * Silent self-heal for rotated VAPID keys. Runs when Notification permission
 * is already "granted" — if the device's current PushSubscription was created
 * with an older VAPID key, unsubscribe, resubscribe with the current key, and
 * upsert the row in `push_subscriptions` so pushes resume automatically.
 */
/**
 * Reclaims the current device's push endpoint for `userId`. Any existing
 * `push_subscriptions` row that ties the same endpoint to a different user is
 * deleted first — otherwise a browser previously signed in as User A keeps
 * receiving pushes meant for User A (withdrawal, house listing, etc.) after
 * User B signs in.
 */
async function reclaimEndpointForUser(
  userId: string,
  endpoint: string,
  p256dh: string,
  auth: string,
): Promise<void> {
  try {
    // Is the endpoint currently owned by someone else on this browser?
    const { data: existing } = await supabase
      .from("push_subscriptions")
      .select("user_id")
      .eq("endpoint", endpoint);
    const ownedByOther =
      Array.isArray(existing) && existing.some((r) => r.user_id !== userId);
    const ownedBySelf =
      Array.isArray(existing) && existing.some((r) => r.user_id === userId);

    if (ownedByOther) {
      // Wipe every row for this endpoint, then re-insert under the current user.
      await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
      const { error } = await supabase.from("push_subscriptions").insert({
        user_id: userId,
        endpoint,
        p256dh,
        auth,
      });
      if (error) {
        console.warn("[push] reclaim endpoint upsert failed:", error);
      } else {
        console.info("[push] reclaimed endpoint for current user");
      }
      return;
    }

    if (!ownedBySelf) {
      // No row exists at all — insert one so pushes start flowing.
      const { error } = await supabase.from("push_subscriptions").insert({
        user_id: userId,
        endpoint,
        p256dh,
        auth,
      });
      if (error) console.warn("[push] initial subscription insert failed:", error);
    }
  } catch (err) {
    console.warn("[push] reclaimEndpointForUser failed:", err);
  }
}

async function refreshSubscriptionIfVapidChanged(userId: string): Promise<void> {
  try {
    if (!isPushSupported()) return;
    if (Notification.permission !== "granted") return;

    const registration =
      (await navigator.serviceWorker.getRegistration("/sw.js")) ||
      (await navigator.serviceWorker.register("/sw.js"));
    await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    // Nothing to migrate if no subscription exists on this device.
    if (!subscription) return;
    // Current key — VAPID rotation is a no-op, but we still need to make sure
    // this device's endpoint is owned by the CURRENT user. Otherwise a browser
    // previously signed in as someone else keeps getting their pushes.
    if (subscriptionUsesCurrentVapidKey(subscription)) {
      const json = subscription.toJSON();
      const p256dh = json.keys?.p256dh ?? arrayBufferToBase64(subscription.getKey("p256dh"));
      const auth = json.keys?.auth ?? arrayBufferToBase64(subscription.getKey("auth"));
      if (p256dh && auth) {
        await reclaimEndpointForUser(userId, subscription.endpoint, p256dh, auth);
      }
      return;
    }

    const staleEndpoint = subscription.endpoint;
    try { await subscription.unsubscribe(); } catch { /* ignore */ }
    try {
      await supabase.from("push_subscriptions").delete().eq("endpoint", staleEndpoint);
    } catch { /* ignore — row may not exist */ }

    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });

    const json = subscription.toJSON();
    const p256dh = json.keys?.p256dh ?? arrayBufferToBase64(subscription.getKey("p256dh"));
    const auth = json.keys?.auth ?? arrayBufferToBase64(subscription.getKey("auth"));
    if (!p256dh || !auth) return;

    // Take exclusive ownership of the new endpoint (same rationale as the
    // manual enable path).
    await supabase.from("push_subscriptions").delete().eq("endpoint", subscription.endpoint);
    const { error } = await supabase.from("push_subscriptions").insert({
      user_id: userId,
      endpoint: subscription.endpoint,
      p256dh,
      auth,
    });
    if (error) {
      console.warn("[push] silent VAPID rotation upsert failed:", error);
    } else {
      console.info("[push] silently rotated subscription to current VAPID key");
    }
  } catch (err) {
    console.warn("[push] refreshSubscriptionIfVapidChanged failed:", err);
  }
}

/**
 * PushNotificationGate — a prominent popup shown to signed-in users who have
 * not yet enabled push notifications. Tapping "Enable notifications" triggers
 * the native browser/system permission prompt (allow/deny); if allowed, the
 * device is subscribed to Web Push. Non-blocking: the user may dismiss it and
 * it re-asks after a snooze window.
 *
 * Mounted once, globally (App.tsx).
 */

// Set once a device has successfully subscribed. Persisted per user so a
// refresh never re-shows the mandatory prompt to someone already enabled.
const ENABLED_KEY_PREFIX = "welile-push-enabled:";
// Timestamp of the last time this user saw the gate (any dismissal path).
const PROMPTED_KEY_PREFIX = "welile-push-prompted:";
// Timestamp of the last time this user explicitly tapped "Not now".
const SNOOZE_KEY_PREFIX = "welile-push-snooze:";

const PROMPTED_COOLDOWN_MS = 24 * 60 * 60 * 1000; // do not re-prompt within 24h
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // re-ask after 7 days if explicitly snoozed

function userKey(prefix: string, userId: string) {
  return `${prefix}${userId}`;
}

function getTs(prefix: string, userId: string): number | null {
  try {
    const raw = localStorage.getItem(userKey(prefix, userId));
    if (!raw) return null;
    const ts = Number(raw);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

function setTs(prefix: string, userId: string) {
  try {
    localStorage.setItem(userKey(prefix, userId), String(Date.now()));
  } catch {
    /* ignore */
  }
}

function isMarkedEnabled(userId: string): boolean {
  try {
    return localStorage.getItem(userKey(ENABLED_KEY_PREFIX, userId)) === "1";
  } catch {
    return false;
  }
}

function markEnabled(userId: string) {
  try {
    localStorage.setItem(userKey(ENABLED_KEY_PREFIX, userId), "1");
  } catch {
    /* ignore */
  }
}

function clearEnabled(userId: string) {
  try {
    localStorage.removeItem(userKey(ENABLED_KEY_PREFIX, userId));
  } catch {
    /* ignore */
  }
}

/**
 * True when this device already has a live push subscription registered to the
 * signed-in user. Used so a page refresh never re-prompts an enabled user.
 */
async function deviceAlreadySubscribed(userId: string): Promise<boolean> {
  try {
    if (!isPushSupported()) return false;
    const registration = await navigator.serviceWorker.getRegistration("/sw.js");
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return false;
    const { data } = await supabase
      .from("push_subscriptions")
      .select("user_id")
      .eq("endpoint", subscription.endpoint)
      .eq("user_id", userId)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

type Status = "idle" | "subscribing" | "success";

export function PushNotificationGate() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  // The prompt is always dismissible ("Not now").
  const required = false;
  const checkedRef = useRef(false);
  const lastUserIdRef = useRef<string | null>(null);

  const isSnoozed = useCallback((userId: string) => {
    const ts = getTs(SNOOZE_KEY_PREFIX, userId);
    return ts !== null && ts > Date.now() - SNOOZE_MS;
  }, []);

  const isPromptedRecently = useCallback((userId: string) => {
    const ts = getTs(PROMPTED_KEY_PREFIX, userId);
    return ts !== null && ts > Date.now() - PROMPTED_COOLDOWN_MS;
  }, []);

  // Decide whether to show the prompt.
  useEffect(() => {
    if (!user) return;
    // Re-evaluate when the signed-in user changes without a page reload.
    if (lastUserIdRef.current !== user.id) {
      lastUserIdRef.current = user.id;
      checkedRef.current = false;
    }
    if (checkedRef.current) return;
    checkedRef.current = true;

    // Never prompt inside the Lovable preview iframe — browsers refuse the
    // permission request there and report "denied", which would train users
    // to think the app is broken.
    if (isInIframe()) return;
    // If the browser can't do push at all, don't nag.
    if (!isPushSupported()) return;
    // Notifications are branded to welileapp.com — never prompt (and clean up)
    // on a legacy hostname, otherwise alerts arrive labelled with the old host.
    if (isLegacyPushOrigin()) {
      void purgeLegacyOriginPush(async (endpoint) => {
        await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
      });
      return;
    }

    if (Notification.permission === "granted") {
      markEnabled(user.id);
      // Silent self-heal: if the stored PushSubscription was created with an
      // older VAPID key, the server can no longer deliver to it. Rotate it
      // transparently so previously-subscribed devices resume receiving
      // notifications without a manual trip to Settings.
      void refreshSubscriptionIfVapidChanged(user.id);
      return;
    }

    const isDenied = Notification.permission === "denied";
    // Permission is no longer granted — any previous "enabled" mark is stale.
    if (isDenied) clearEnabled(user.id);
    // Already enabled on this device (flag or live subscription) → never nag.
    if (!isDenied && isMarkedEnabled(user.id)) return;
    // Once denied the only recovery path is browser settings; don't show the
    // full gate because the native prompt will be blocked.
    if (isDenied) return;
    // Respect explicit "Not now" snooze and the broader 24h "already seen" cooldown.
    if (isSnoozed(user.id) || isPromptedRecently(user.id)) return;

    let cancelled = false;
    // Short delay so it doesn't fight other startup UI (e.g. location gate).
    const t = setTimeout(async () => {
      if (cancelled) return;
      if (await deviceAlreadySubscribed(user.id)) {
        markEnabled(user.id);
        return;
      }
      if (!cancelled) {
        // Record that this user was shown the gate, even if they later close
        // the browser without tapping a button. This stops the "every restart"
        // loop for users who simply dismiss the dialog.
        setTs(PROMPTED_KEY_PREFIX, user.id);
        setOpen(true);
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [user, isSnoozed, isPromptedRecently]);

  // Keep the "prompted" timestamp fresh while the dialog stays open.
  useEffect(() => {
    if (open && user) {
      setTs(PROMPTED_KEY_PREFIX, user.id);
    }
  }, [open, user]);

  const handleSnooze = useCallback(() => {
    if (user) {
      setTs(PROMPTED_KEY_PREFIX, user.id);
      setTs(SNOOZE_KEY_PREFIX, user.id);
    }
    setOpen(false);
  }, [user]);

  const handleEnable = useCallback(async () => {
    if (!user) return;
    if (!isPushSupported()) {
      toast.error("Push notifications aren't supported on this browser.");
      handleSnooze();
      return;
    }

    setStatus("subscribing");
    try {
      // Native browser/system permission prompt (Allow / Block).
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("idle");
        if (permission === "denied") {
          toast.error("Notifications blocked. You can enable them later in Settings.");
        }
        handleSnooze();
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
        });
      }

      const json = subscription.toJSON();
      const p256dh = json.keys?.p256dh ?? arrayBufferToBase64(subscription.getKey("p256dh"));
      const auth = json.keys?.auth ?? arrayBufferToBase64(subscription.getKey("auth"));

      // Take exclusive ownership of this device's endpoint so role-scoped
      // pushes (e.g. Merchant Agent "New withdrawal to claim") never fire on
      // a device now signed in as a different user.
      await supabase
        .from("push_subscriptions")
        .delete()
        .eq("endpoint", subscription.endpoint);

      const { error } = await supabase
        .from("push_subscriptions")
        .insert({
          user_id: user.id,
          endpoint: subscription.endpoint,
          p256dh,
          auth,
        });
      if (error) throw error;

      setStatus("success");
      markEnabled(user.id);
      toast.success("Notifications enabled on this device.");
      setTimeout(() => setOpen(false), 1600);
    } catch (err) {
      console.error("Push subscription failed:", err);
      setStatus("idle");
      toast.error("Could not enable notifications. Please try again.");
    }
  }, [user, handleSnooze]);

  if (!user) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) return setOpen(o);
        // Mandatory: don't let the user dismiss until they've enabled (or the
        // browser blocked it). Snooze only applies to the non-required path.
        if (required && status !== "success") return;
        handleSnooze();
      }}
    >
      <DialogContent
        className={
          "max-w-sm rounded-2xl border-0 p-0 overflow-hidden" +
          (required && status !== "success" ? " [&>button]:hidden" : "")
        }
        overlayClassName="backdrop-blur-0 bg-background/60"
        onEscapeKeyDown={(e) => {
          if (required && status !== "success") e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (required && status !== "success") e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (required && status !== "success") e.preventDefault();
        }}
      >
        {/* Hero */}
        <div className="relative bg-gradient-to-br from-primary to-primary/70 px-6 pt-8 pb-10 text-center">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-primary-foreground/15 ring-4 ring-primary-foreground/10">
            {status === "success" ? (
              <Check className="h-8 w-8 text-primary-foreground" />
            ) : status === "subscribing" ? (
              <Loader2 className="h-8 w-8 text-primary-foreground animate-spin" />
            ) : (
              <BellRing className="h-8 w-8 text-primary-foreground" />
            )}
          </div>
          <DialogHeader className="space-y-1">
            <DialogTitle className="text-primary-foreground text-lg font-bold">
              {status === "success" ? "Notifications on!" : "Stay in the loop"}
            </DialogTitle>
            <DialogDescription className="text-primary-foreground/80 text-sm">
              {status === "success"
                ? "You'll now get instant alerts on this device."
                : required
                  ? "Notifications are required to use Welile. You'll get instant alerts for listing decisions, deposits, withdrawals, payouts and rent updates."
                  : "Get instant alerts for deposits, withdrawals, payouts and rent updates — even when Welile is closed."}
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Body */}
        <div className="px-6 pb-6 -mt-4">
          <div className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
            <p className="text-sm text-muted-foreground">
              Your browser will ask for permission next. Tap{" "}
              <span className="font-medium text-foreground">Allow</span> to turn on
              notifications for this device.
            </p>
            <div className="flex flex-col gap-2">
              <Button
                className="w-full"
                onClick={handleEnable}
                disabled={status === "subscribing" || status === "success"}
              >
                {status === "subscribing" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Bell className="h-4 w-4" />
                )}
                Enable notifications
              </Button>
              {!required && (
                <Button
                  variant="ghost"
                  className="w-full text-muted-foreground"
                  onClick={handleSnooze}
                  disabled={status === "subscribing" || status === "success"}
                >
                  Not now
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default PushNotificationGate;