import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Manual CORS headers (project standard — do not import corsHeaders).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const KNOWN_COUNTRY_CODES = [
  "256", "254", "255", "250", "257", "211", "243", "234", "27", "44", "1",
  "91", "86", "33", "49", "81", "82", "61", "55", "7", "966", "971", "20",
  "212", "233", "225", "221", "260", "263", "267", "251",
];

function formatPhoneInternational(rawPhone: string): string {
  let digits = (rawPhone || "").replace(/\D/g, "");
  for (const code of KNOWN_COUNTRY_CODES) {
    if (digits.startsWith(code) && digits.length > code.length + 5) {
      return "+" + digits;
    }
  }
  if (digits.startsWith("0")) digits = "256" + digits.slice(1);
  return "+" + digits;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const raw = (body.phone || "").toString().trim();
    if (!raw || raw.replace(/\D/g, "").length < 9) {
      return new Response(JSON.stringify({ error: "A valid phone number is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const phone = formatPhoneInternational(raw);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { error } = await admin
      .from("sms_opt_outs")
      .upsert(
        { phone, source: "stop-sms-page", reason: "landlord opted out of daily SMS" },
        { onConflict: "phone" },
      );
    if (error) throw error;

    return new Response(JSON.stringify({ success: true, phone }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("sms-opt-out error:", e);
    return new Response(JSON.stringify({ error: e?.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
