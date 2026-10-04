import { useCallback, useEffect, useRef, useState } from "react";
import { usePolling } from "@/hooks/usePolling";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Home, User } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

/**
 * RejectionAlertGate — global popup shown to a signed-in user the moment one
 * of their submissions is rejected by Ops:
 *   • a house listing they submitted (agent_listing_rejections INSERT)
 *   • a landlord verification request they raised
 *     (landlord_verification_requests UPDATE → status='rejected')
 *
 * Shows a single responsive warning dialog per rejection with the item and
 * reason, and a Close button. Seen rejection IDs are remembered in
 * localStorage so the same alert never re-fires (e.g. on refresh).
 *
 * Mounted once, globally, from App.tsx alongside PushNotificationGate.
 */

type RejectionKind = "house" | "landlord";

interface RejectionItem {
  key: string; // stable dedupe key: `${kind}:${id}`
  kind: RejectionKind;
  title: string; // "House listing rejected" | "Landlord rejected"
  itemLabel: string; // e.g. "Kireka 2-bedroom" or "Namubiru Jane (0700…)"
  reason: string;
  rejectedAt: string | null;
}

const SEEN_KEY = "welile-rejection-alerts-seen";
// Only surface rejections from the last 7 days on first mount — older ones
// would just be noise for the agent.
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function persistSeen(seen: Set<string>) {
  try {
    // Cap the stored list so it can't grow unbounded.
    const arr = Array.from(seen).slice(-500);
    localStorage.setItem(SEEN_KEY, JSON.stringify(arr));
  } catch {
    /* ignore */
  }
}

export function RejectionAlertGate() {
  const { user } = useAuth();
  const [queue, setQueue] = useState<RejectionItem[]>([]);
  const seenRef = useRef<Set<string>>(loadSeen());

  const enqueue = useCallback((items: RejectionItem[]) => {
    if (items.length === 0) return;
    const fresh = items.filter((it) => !seenRef.current.has(it.key));
    if (fresh.length === 0) return;
    setQueue((prev) => {
      const existing = new Set(prev.map((p) => p.key));
      const merged = [...prev];
      for (const it of fresh) {
        if (!existing.has(it.key)) merged.push(it);
      }
      return merged;
    });
  }, []);

  // Load recent rejections on mount and every 60s (+ on focus), so a user who
  // was offline when the rejection landed still sees it, and new house-listing
  // rejections surface while the app is open. enqueue() de-dupes by key, so
  // re-running the lookback never re-alerts. (House-listing rejections used a
  // Realtime INSERT listener on agent_listing_rejections, which is not in the
  // publication and never fired — doc 147.)
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);
  const loadRecent = useCallback(async () => {
    if (!user) return;
    {
      const sinceIso = new Date(Date.now() - LOOKBACK_MS).toISOString();

      const [listingRes, landlordRes] = await Promise.all([
        supabase
          .from("agent_listing_rejections")
          .select("id, listing_id, reason, rejected_at")
          .eq("agent_id", user.id)
          .gte("rejected_at", sinceIso)
          .order("rejected_at", { ascending: false })
          .limit(20),
        supabase
          .from("landlord_verification_requests")
          .select("id, landlord_name, landlord_phone, reject_comment, resolved_at")
          .eq("requested_by", user.id)
          .eq("status", "rejected")
          .gte("resolved_at", sinceIso)
          .order("resolved_at", { ascending: false })
          .limit(20),
      ]);

      if (cancelledRef.current) return;

      const listingItems: RejectionItem[] = [];
      const listingRows = (listingRes.data ?? []) as Array<{
        id: string; listing_id: string | null; reason: string; rejected_at: string;
      }>;
      const listingIds = listingRows
        .map((r) => r.listing_id)
        .filter((v): v is string => !!v);
      const listingLabelById = new Map<string, string>();
      if (listingIds.length) {
        const { data: houses } = await supabase
          .from("house_listings")
          .select("id, title, region, price")
          .in("id", listingIds);
        for (const h of houses ?? []) {
          const parts = [
            (h as any).title,
            (h as any).region,
          ].filter(Boolean);
          listingLabelById.set(
            (h as any).id,
            parts.join(" — ") || "House listing",
          );
        }
      }
      for (const r of listingRows) {
        listingItems.push({
          key: `house:${r.id}`,
          kind: "house",
          title: "House listing rejected",
          itemLabel: (r.listing_id && listingLabelById.get(r.listing_id)) || "House listing",
          reason: r.reason || "No reason provided.",
          rejectedAt: r.rejected_at,
        });
      }

      const landlordItems: RejectionItem[] = ((landlordRes.data ?? []) as Array<{
        id: string; landlord_name: string | null; landlord_phone: string | null;
        reject_comment: string | null; resolved_at: string | null;
      }>).map((r) => ({
        key: `landlord:${r.id}`,
        kind: "landlord",
        title: "Landlord rejected",
        itemLabel: [r.landlord_name, r.landlord_phone].filter(Boolean).join(" — ") || "Landlord",
        reason: r.reject_comment || "No reason provided.",
        rejectedAt: r.resolved_at,
      }));

      enqueue([...listingItems, ...landlordItems]);
    }
  }, [user, enqueue]);
  usePolling(loadRecent, 60_000, { enabled: !!user, immediate: true });

  // Realtime (landlord rejections only — landlord_verification_requests is
  // published): surface them the moment Ops posts them.
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel(`rejection-alerts-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "landlord_verification_requests",
          filter: `requested_by=eq.${user.id}`,
        },
        (payload) => {
          const row = payload.new as {
            id: string; status: string; landlord_name: string | null;
            landlord_phone: string | null; reject_comment: string | null;
            resolved_at: string | null;
          };
          if (row.status !== "rejected") return;
          enqueue([{
            key: `landlord:${row.id}`,
            kind: "landlord",
            title: "Landlord rejected",
            itemLabel: [row.landlord_name, row.landlord_phone].filter(Boolean).join(" — ") || "Landlord",
            reason: row.reject_comment || "No reason provided.",
            rejectedAt: row.resolved_at,
          }]);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, enqueue]);

  const current = queue[0] ?? null;

  const dismiss = useCallback(() => {
    setQueue((prev) => {
      if (prev.length === 0) return prev;
      const [first, ...rest] = prev;
      seenRef.current.add(first.key);
      persistSeen(seenRef.current);
      return rest;
    });
  }, []);

  if (!user || !current) return null;

  const Icon = current.kind === "house" ? Home : User;

  return (
    <Dialog
      open={!!current}
      onOpenChange={(o) => {
        if (!o) dismiss();
      }}
    >
      <DialogContent
        className="w-[calc(100vw-2rem)] max-w-md rounded-2xl border-0 p-0 overflow-hidden"
        overlayClassName="backdrop-blur-0 bg-background/60"
      >
        {/* Warning hero */}
        <div className="relative bg-gradient-to-br from-destructive to-destructive/70 px-5 pt-7 pb-8 text-center sm:px-6">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-destructive-foreground/15 ring-4 ring-destructive-foreground/10 sm:h-16 sm:w-16">
            <AlertTriangle className="h-7 w-7 text-destructive-foreground sm:h-8 sm:w-8" />
          </div>
          <DialogHeader className="space-y-1">
            <DialogTitle className="text-destructive-foreground text-base font-bold sm:text-lg">
              {current.title}
            </DialogTitle>
            <DialogDescription className="text-destructive-foreground/80 text-xs sm:text-sm">
              Ops reviewed your submission and could not approve it.
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Body */}
        <div className="px-5 pb-5 -mt-4 sm:px-6 sm:pb-6">
          <div className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Icon className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {current.kind === "house" ? "House listing" : "Landlord"}
                </p>
                <p className="text-sm font-semibold text-foreground break-words">
                  {current.itemLabel}
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-destructive">
                Reason for rejection
              </p>
              <p className="mt-1 text-sm text-foreground whitespace-pre-wrap break-words">
                {current.reason}
              </p>
            </div>

            <Button className="w-full" variant="secondary" onClick={dismiss}>
              Close
            </Button>
            {queue.length > 1 && (
              <p className="text-center text-[11px] text-muted-foreground">
                {queue.length - 1} more rejection{queue.length - 1 === 1 ? "" : "s"} to review
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default RejectionAlertGate;