import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { type } = body;

    const AT_API_KEY = Deno.env.get("AT_API_KEY");
    const AT_USERNAME = Deno.env.get("AT_USERNAME");
    const AT_SENDER = Deno.env.get("AT_SENDER_ID") || "";

    if (!AT_API_KEY || !AT_USERNAME) {
      console.warn("[viewing-sms] Africa's Talking not configured, skipping SMS");
      return new Response(JSON.stringify({ skipped: true, reason: "SMS not configured" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const formatPhone = (phone: string) => {
      const clean = phone.replace(/\s/g, '');
      if (clean.startsWith('+')) return clean;
      if (clean.startsWith('0')) return `+256${clean.slice(1)}`;
      return `+256${clean}`;
    };

    const sendSms = async (to: string, message: string) => {
      try {
        // Yoola is the primary SMS provider; fall through to AT only if it fails.
        if (await attemptYoolaPrimary(to, message, { source: "viewing-confirmation-sms" })) return;
        const params = new URLSearchParams({
          username: AT_USERNAME!,
          to: formatPhone(to),          message,
        });

        await fetch("https://api.africastalking.com/version1/messaging", {
          method: "POST",
          headers: {
            "apiKey": AT_API_KEY!,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
          },
          body: params.toString(),
        });
      } catch (e) {
        console.error(`[viewing-sms] Failed to send to ${to}:`, e);
      }
    };

    if (type === "scheduled") {
      const { tenant_name, tenant_phone, agent_name, agent_phone, house_title, house_address, viewing_date, viewing_time } = body;

      // Notify tenant
      await sendSms(tenant_phone,
        `Hi ${tenant_name}, a property viewing has been scheduled for you!\n\n` +
        `🏠 ${house_title}\n📍 ${house_address}\n📅 ${viewing_date} at ${viewing_time}\n\n` +
        `Your agent ${agent_name} will meet you there. Reply YES to confirm. - Welile`
      );

      // Notify agent
      await sendSms(agent_phone,
        `Hi ${agent_name}, you've been assigned a property viewing!\n\n` +
        `🏠 ${house_title}\n📍 ${house_address}\n📅 ${viewing_date} at ${viewing_time}\n` +
        `👤 Tenant: ${tenant_name}\n\n` +
        `Please check in at the property location when you arrive. Reply YES to confirm. - Welile`
      );

      console.log(`[viewing-sms] Scheduled viewing notifications sent for ${house_title}`);

    } else if (type === "confirm") {
      // Three-way confirmation: ask each party to confirm the viewing happened
      const { viewing_id, tenant_name, tenant_phone, agent_name, agent_phone, house_title } = body;

      await sendSms(tenant_phone,
        `Hi ${tenant_name}, did you visit ${house_title} today? Reply YES to confirm the viewing happened, NO if it didn't. - Welile`
      );

      await sendSms(agent_phone,
        `Hi ${agent_name}, did the viewing of ${house_title} happen? Reply YES to confirm, NO if not. - Welile`
      );

      // Mark confirmation SMS as sent
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const admin = createClient(supabaseUrl, supabaseKey);
      if (viewing_id) {
        await admin.from("property_viewings").update({ confirmation_sms_sent: true }).eq("id", viewing_id);
      }

      console.log(`[viewing-sms] Confirmation SMS sent for viewing ${viewing_id}`);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[viewing-sms] Error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
