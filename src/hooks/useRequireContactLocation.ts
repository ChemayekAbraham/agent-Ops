import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { ContactRole } from "@/components/agent/AgentContactLocationGate";

/**
 * Returns helpers to gate any agent action behind a contact's
 * location being captured. Usage:
 *
 *   const { needsCapture, GateElement, requireLocation } =
 *     useRequireContactLocation(tenantId, "tenant");
 *
 *   <Button onClick={() => requireLocation(() => doCollect())}>Collect</Button>
 *   {GateElement}
 */
export function useRequireContactLocation(
  targetId: string | null | undefined,
  targetRole: ContactRole,
  targetName?: string | null,
) {
  const [gateOpen, setGateOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<null | (() => void)>(null);

  const { data: profile, refetch } = useQuery({
    queryKey: ["contact-location-status", targetId],
    enabled: !!targetId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, residence_lat, residence_lng, district, country, address_complete")
        .eq("id", targetId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const needsCapture =
    !!profile &&
    (!profile.country ||
      (profile.country === "Uganda" && !profile.district));

  const requireLocation = useCallback(
    (action: () => void) => {
      if (!targetId) { action(); return; }
      if (needsCapture) {
        setPendingAction(() => action);
        setGateOpen(true);
      } else {
        action();
      }
    },
    [needsCapture, targetId],
  );

  return {
    needsCapture,
    targetId,
    targetRole,
    targetName: targetName ?? profile?.full_name ?? null,
    gateOpen,
    openGate: () => setGateOpen(true),
    closeGate: () => { setGateOpen(false); setPendingAction(null); },
    onCaptured: () => {
      setGateOpen(false);
      refetch();
      const action = pendingAction;
      setPendingAction(null);
      if (action) action();
    },
    requireLocation,
  };
}