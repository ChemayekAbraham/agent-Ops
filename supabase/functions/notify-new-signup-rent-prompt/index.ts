// Invites new sign-ups to request a Rent Plan from Welile.
//
// Two modes:
//   { mode: "single", user_id }            -> one recipient (called by the sign-up trigger)
//   { mode: "backfill", since?, limit? }   -> resumable batch for existing sign-ups
//   { mode: "backfill", dry_run: true }    -> counts only, sends nothing
//
// Once-ever delivery is enforced by the shared SMS idempotency log
// (key: signup_rent_prompt:<user_id>), so re-running is safe.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { sendSMS, isUgandanPhone } from "../_shared/sendSmsMultiProvider.ts";
import { suppressSignupPrompt } from "../_shared/smsSignupPrompt.ts";

// Everyone reached here already has an account — never append the "sign up" prompt.
suppressSignupPrompt();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_SINCE = "2026-08-01T00:00:00Z";
const SOURCE = "signup_rent_prompt";
const RENT_LINK = "welileapp.com/rent";
const BATCH_SIZE = 200;
const SEND_GAP_MS = 120;

function firstName(full?: string | null): string {
  const n = String(full ?? "").trim().split(/\s+/)[0] ?? "";
  if (!n || n.length < 2) return "";
  return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
}

function buildMessage(fullName?: string | null): string {
  const name = firstName(fullName);
  const greeting = name ? `Hi ${name}, ` : "Hi, ";
  return `${greeting}you can now request rent from Welile and pay it back in small daily amounts. Request your Rent Plan: ${RENT_LINK}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadBlockedPhones(admin: any): Promise<Set<string>> {
  const blocked = new Set<string>();
  const { data } = await admin
    .from("sms_message_exceptions")
    .select("phone, message_type")
    .in("message_type", ["all", "partner_broadcast", SOURCE]);
  for (const row of data ?? []) {
    const digits = String(row?.phone ?? "").replace(/[^0-9]/g, "");
    if (digits) blocked.add(digits.slice(-9));
  }
  return blocked;
}

// Users who already have this message logged — so a resumed run makes real
// progress instead of spending its budget on people already reached.
async function loadAlreadyReached(admin: any): Promise<Set<string>> {
  const reached = new Set<string>();
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const { data, error } = await admin
      .from("sms_delivery_log")
      .select("recipient_user_id")
      .eq("source", SOURCE)
      .not("recipient_user_id", "is", null)
      .range(offset, offset + page - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data) reached.add(String(row.recipient_user_id));
    if (data.length < page) break;
  }
  return reached;
}

async function sendOne(
  admin: any,
  profile: { id: string; phone: string | null; full_name: string | null },
): Promise<boolean> {
  return await sendSMS(String(profile.phone ?? ""), buildMessage(profile.full_name), {
    admin,
    source: SOURCE,
    reference_id: profile.id,
    recipient_user_id: profile.id,
    recipient_name: profile.full_name ?? null,
    idempotencyKey: `${SOURCE}:${profile.id}`,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode ?? "single");

    if (mode === "single") {
      const userId = String(body?.user_id ?? "").trim();
      if (!userId) {
        return new Response(JSON.stringify({ error: "user_id is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: profile } = await admin
        .from("profiles")
        .select("id, phone, full_name")
        .eq("id", userId)
        .maybeSingle();
      if (!profile || !isUgandanPhone(String(profile.phone ?? ""))) {
        return new Response(JSON.stringify({ skipped: true, reason: "no usable phone" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const blocked = await loadBlockedPhones(admin);
      const tail = String(profile.phone ?? "").replace(/[^0-9]/g, "").slice(-9);
      if (blocked.has(tail)) {
        return new Response(JSON.stringify({ skipped: true, reason: "on do-not-text list" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const sent = await sendOne(admin, profile as any);
      return new Response(JSON.stringify({ sent }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (mode === "backfill") {
      const since = String(body?.since ?? DEFAULT_SINCE);
      const dryRun = body?.dry_run === true;
      const maxSends = Number.isFinite(Number(body?.limit)) ? Number(body.limit) : Infinity;
      const blocked = await loadBlockedPhones(admin);
      const alreadySent = await loadAlreadyReached(admin);

      let offset = 0;
      let candidates = 0;
      let sent = 0;
      let failed = 0;
      let skipped = 0;

      while (sent + failed < maxSends) {
        const { data: rows, error } = await admin
          .from("profiles")
          .select("id, phone, full_name, created_at")
          .gte("created_at", since)
          .not("phone", "is", null)
          .order("created_at", { ascending: true })
          .range(offset, offset + BATCH_SIZE - 1);
        if (error) throw error;
        if (!rows || rows.length === 0) break;
        offset += rows.length;

        for (const row of rows) {
          const phone = String(row.phone ?? "");
          if (!isUgandanPhone(phone)) { skipped++; continue; }
          if (blocked.has(phone.replace(/[^0-9]/g, "").slice(-9))) { skipped++; continue; }
          if (alreadySent.has(String(row.id))) { skipped++; continue; }
          candidates++;
          if (dryRun) continue;
          if (sent + failed >= maxSends) break;
          const ok = await sendOne(admin, row as any);
          if (ok) sent++; else failed++;
          await sleep(SEND_GAP_MS);
        }
        if (rows.length < BATCH_SIZE) break;
      }

      return new Response(
        JSON.stringify({ mode, since, dry_run: dryRun, candidates, sent, failed, skipped }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: `unknown mode: ${mode}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("notify-new-signup-rent-prompt failed", err);
    return new Response(JSON.stringify({ error: (err as Error)?.message ?? String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
