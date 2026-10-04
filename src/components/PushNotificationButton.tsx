import { useEffect, useState } from "react";
import { Bell, BellOff, BellRing, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  VAPID_PUBLIC_KEY,
  arrayBufferToBase64,
  isPushSupported,
  subscriptionUsesCurrentVapidKey,
  urlBase64ToUint8Array,
} from "@/lib/webPush";

type PushState = "idle" | "subscribing" | "subscribed" | "denied" | "unsupported";

/**
 * Self-contained Web Push subscription button.
 *
 * Flow on click:
 *  1. Request Notification permission.
 *  2. Register the push-only service worker (`/sw.js`).
 *  3. Create a PushSubscription with the VAPID public key.
 *  4. Upsert the subscription (endpoint + keys) into `push_subscriptions`.
 */
export function PushNotificationButton({ className }: { className?: string }) {
  const { user } = useAuth();
  const [state, setState] = useState<PushState>("idle");

  useEffect(() => {
    if (!isPushSupported()) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    // Reflect an existing subscription on mount.
    navigator.serviceWorker
      .getRegistration("/sw.js")
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => {
        if (sub && subscriptionUsesCurrentVapidKey(sub)) setState("subscribed");
      })
      .catch(() => {
        /* no existing registration — stay idle */
      });
  }, []);

  const subscribe = async () => {
    if (!isPushSupported()) {
      setState("unsupported");
      toast.error("Push notifications aren't supported on this browser.");
      return;
    }
    if (!user) {
      toast.error("Please sign in to enable notifications.");
      return;
    }

    setState("subscribing");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "idle");
        toast.error("Notification permission was not granted.");
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      // Reuse an existing subscription if present, otherwise create one.
      let subscription = await registration.pushManager.getSubscription();
      if (subscription && !subscriptionUsesCurrentVapidKey(subscription)) {
        await supabase
          .from("push_subscriptions")
          .delete()
          .eq("endpoint", subscription.endpoint);
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

      // Take exclusive ownership of this device's endpoint. Without this,
      // a previously signed-in user's row (e.g. a Merchant Agent) stays in
      // push_subscriptions for the same endpoint, and role-scoped pushes
      // (like "New withdrawal to claim") keep firing on this physical
      // device even though a different user is now signed in.
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

      setState("subscribed");
      toast.success("Notifications enabled on this device.");
    } catch (err) {
      console.error("Push subscription failed:", err);
      setState("idle");
      toast.error("Could not enable notifications. Please try again.");
    }
  };

  const unsubscribe = async () => {
    setState("subscribing");
    try {
      const registration = await navigator.serviceWorker.getRegistration("/sw.js");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await supabase
          .from("push_subscriptions")
          .delete()
          .eq("endpoint", subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState("idle");
      toast.success("Notifications turned off on this device.");
    } catch (err) {
      console.error("Push unsubscribe failed:", err);
      setState("subscribed");
      toast.error("Could not turn off notifications.");
    }
  };

  if (state === "unsupported") {
    return (
      <Button variant="outline" className={className} disabled>
        <BellOff className="h-4 w-4" />
        Notifications unavailable
      </Button>
    );
  }

  if (state === "denied") {
    return (
      <Button
        variant="outline"
        className={className}
        onClick={() => {
          toast.info("Notifications are blocked in your browser", {
            description:
              "Tap the lock icon in the address bar → Site settings → set Notifications to Allow, then reload this page.",
            duration: 10000,
          });
        }}
      >
        <BellOff className="h-4 w-4" />
        Notifications blocked — tap for help
      </Button>
    );
  }

  if (state === "subscribed") {
    return (
      <Button variant="secondary" className={className} onClick={unsubscribe}>
        <BellRing className="h-4 w-4" />
        Notifications on
      </Button>
    );
  }

  return (
    <Button
      className={className}
      onClick={subscribe}
      disabled={state === "subscribing"}
    >
      {state === "subscribing" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Bell className="h-4 w-4" />
      )}
      Enable notifications
    </Button>
  );
}

export default PushNotificationButton;