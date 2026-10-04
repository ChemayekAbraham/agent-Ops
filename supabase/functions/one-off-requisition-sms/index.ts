// TEMPORARY one-off: 6 hard-coded requisition SMS. Delete after single use.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RECIPIENTS = [
  { id: "cb798acb-68bc-4b4e-a414-a3d374e030b6", name: "JOSHUA WANDA", phone: "+256704825473" },
  { id: "cf561688-b3a2-4f62-b9c1-67ee7b36ff2b", name: "Benjamin Muhanguzi", phone: "+256783673998" },
  { id: "29a0cfa8-1eaf-453c-874c-0fc72fa4f74b", name: "Angwen Sarah", phone: "+256785093196" },
];
const MESSAGES = [
  { reqId: "fe856917-b1d2-40e7-9dc4-33263d071ab0", text: "Welile: Requisition SRQ-00182 (UGX 1,400,000) from PROMROSE KATUSIIME awaits your review." },
  { reqId: "f49f9e17-477d-422e-9f17-0e0868238315", text: "Welile: Requisition SRQ-00184 (UGX 1,240,000) from PROMROSE KATUSIIME awaits your review." },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (!token) return json({ error: "Unauthorized" }, 401);
  if (token !== serviceKey) {
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: "Unauthorized" }, 401);
    const { data: roles } = await admin.from("user_roles").select("role")
      .eq("user_id", user.id).eq("role", "super_admin").eq("enabled", true);
    if (!roles?.length) return json({ error: "Forbidden" }, 403);
  }

  const results = [];
  for (const m of MESSAGES) {
    for (const r of RECIPIENTS) {
      const key = `staff-req-${m.reqId}-coo-${r.id}`;
      let ok = false;
      let err: string | null = null;
      try {
        ok = await sendSMS(r.phone, m.text, {
          admin,
          source: "staff-requisition-submit",
          reference_id: m.reqId,
          recipient_user_id: r.id,
          recipient_name: r.name,
          idempotencyKey: key,
        });
      } catch (e) { err = e instanceof Error ? e.message : String(e); }
      results.push({ recipient: r.name, reference_id: m.reqId, idempotency_key: key, ok, error: err });
    }
  }
  return json({ results });
});
