// Treasury Guard — Layer-2 defense. Edge functions MUST call this before
// any money movement (credit, debit, transfer, payout, disbursement).
// Returns null if OK, or a Response (403) if the operation is paused.

type GuardOp = "credit" | "debit" | "any";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

export async function checkTreasuryGuard(
  adminClient: any,
  op: GuardOp = "any",
  callerUserIdOrAuthHeader?: string | null,
): Promise<Response | null> {
  // CTO / super_admin bypass — they need full capability during maintenance
  // to diagnose and resolve the very issue that triggered the lock.
  // Accepts a raw user id (UUID) OR an Authorization header ("Bearer <jwt>").
  if (callerUserIdOrAuthHeader) {
    try {
      const v = callerUserIdOrAuthHeader.trim();
      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
      let userId: string | null = null;
      if (isUuid) {
        userId = v;
      } else {
        const token = v.replace(/^Bearer\s+/i, "");
        const { data: userData } = await adminClient.auth.getUser(token);
        userId = userData?.user?.id ?? null;
      }
      if (userId) {
        const { data: roles } = await adminClient
          .from("user_roles")
          .select("role")
          .eq("user_id", userId)
          .in("role", ["cto", "super_admin"]);
        if (roles && roles.length > 0) {
          console.log("[treasuryGuard] bypass granted for", userId);
          return null;
        }
      }
    } catch (e) {
      console.warn("[treasuryGuard] bypass lookup failed", e);
    }
  }

  const { data, error } = await adminClient
    .from("treasury_controls")
    .select("control_key, enabled, value")
    .in("control_key", [
      "maintenance_mode",
      "maintenance_until",
      "withdrawals_paused",
      "credits_paused",
    ]);

  if (error) {
    console.error("[treasuryGuard] failed to load controls", error);
    return new Response(
      JSON.stringify({ error: "TREASURY_GUARD_UNAVAILABLE" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const map = new Map<string, { enabled: boolean; value: string | null }>();
  for (const row of data || []) {
    map.set(row.control_key, { enabled: !!row.enabled, value: row.value });
  }

  const maintenance = map.get("maintenance_mode");
  const until = map.get("maintenance_until")?.value;
  const maintenanceActive =
    !!maintenance?.enabled &&
    (!until || new Date(until).getTime() > Date.now());

  if (maintenanceActive) {
    return new Response(
      JSON.stringify({
        error: "MAINTENANCE_MODE",
        message: "Platform is under maintenance. Money movement is temporarily frozen.",
        maintenance_until: until,
      }),
      { status: 423, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const withdrawalsPaused = !!map.get("withdrawals_paused")?.enabled;
  const creditsPaused = !!map.get("credits_paused")?.enabled;

  // Wallet Ops Maintenance = withdrawals ONLY. Credits, rent collections,
  // deposits, transfers-in etc. must keep flowing. So we scope this gate to
  // explicit debit operations — callers using op="any" (which covers a lot
  // of mixed-flow edge functions like rent allocation) are NOT blocked here.
  if (op === "debit" && withdrawalsPaused) {
    return new Response(
      JSON.stringify({
        error: "WITHDRAWALS_PAUSED",
        message: "Withdrawals are temporarily paused for reconciliation.",
      }),
      { status: 423, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if ((op === "credit" || op === "any") && creditsPaused) {
    return new Response(
      JSON.stringify({
        error: "CREDITS_PAUSED",
        message: "Credits are temporarily paused for reconciliation.",
      }),
      { status: 423, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  return null;
}
