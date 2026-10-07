// Reminds PARTNERS about their own promissory notes still waiting to be
// fulfilled. Companion to proxy-promissory-note-reminders, which chases the
// recording agent; until now the partner was only texted once, on the due
// day, and never again while the promise stayed open.
//
// ONE MESSAGE PER PARTNER, NOT PER NOTE
// A partner with several open promises gets a single SMS naming the count,
// the total and the oldest - one message per note would train people to
// ignore all of them.
//
// WHO IS SKIPPED
//   * notes created in the last 48 hours - nobody is late yet;
//   * notes already funded, fulfilled, cancelled or released (status filter);
//   * partners with no reachable phone (note snapshot, then profile).
//
// The signup prompt is suppressed: recipients are already partners with open
// promises, so "Not on Welile yet?" is nonsense to them and costs a segment.
//
// Read-only over promissory notes. No wallet, ledger or note state is changed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { dropFulfilledNotes } from "../_shared/promissoryFulfilled.ts";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";
import { suppressSignupPrompt } from "../_shared/smsSignupPrompt.ts";

suppressSignupPrompt();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Do not chase a promise younger than this - nobody is late yet. */
const GRACE_HOURS = 48;
const CONCURRENCY = 5;

interface Note {
  id: string;
  partner_user_id: string | null;
  partner_name: string | null;
  phone_number: string | null;
  whatsapp_number: string | null;
  amount: number | null;
  fulfilment_due_on: string | null;
  created_at: string;
}

/** Kampala-local date, so one run per calendar day there. */
function kampalaDate(now = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString("en-US")}`;

function daysOld(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function buildMessage(notes: Note[]): string {
  if (notes.length === 1) {
    const n = notes[0];
    const due = n.fulfilment_due_on ? ` due ${n.fulfilment_due_on}` : "";
    return `Welile: Your funding promise of ${ugx(Number(n.amount ?? 0))}${due} is still unfulfilled. ` +
      `Please fund it from your Welile dashboard, or contact your agent to update the date.`;
  }
  const total = notes.reduce((s, n) => s + Number(n.amount ?? 0), 0);
  const oldest = notes.reduce((a, b) => (a.created_at <= b.created_at ? a : b));
  return `Welile: You have ${notes.length} funding promises still unfulfilled, ` +
    `${ugx(total)} in total. Oldest is ${daysOld(oldest.created_at)} days old. ` +
    `Please fund them from your Welile dashboard.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* cron sends no body */ }
  // A dry run builds every message and sends nothing, so the wording can be
  // checked against live data without texting anyone.
  const dryRun = body.dry_run === true;

  const runDate = kampalaDate();
  const summary = {
    date: runDate, dry_run: dryRun,
    partners_with_pending: 0, partners_texted: 0,
    skipped_no_phone: 0,
    notes_considered: 0, errors: [] as string[],
    preview: [] as { partner: string; notes: number; message: string }[],
  };

  try {
    const cutoff = new Date(Date.now() - GRACE_HOURS * 3_600_000).toISOString();

    const { data: rawNotes, error: notesErr } = await admin
      .from("promissory_notes")
      .select("id, partner_user_id, partner_name, phone_number, whatsapp_number, amount, fulfilment_due_on, created_at")
      .eq("status", "pending")
      .lt("created_at", cutoff);
    if (notesErr) throw new Error(notesErr.message);

    const { open: notes } = await dropFulfilledNotes(admin, (rawNotes ?? []) as Note[]);
    summary.notes_considered = notes.length;

    // Group by the partner's user id when known, else by their note phone, so
    // a partner with several promises still gets exactly one message.
    const byPartner = new Map<string, { userId: string | null; notes: Note[] }>();
    for (const n of notes) {
      const key = n.partner_user_id ?? (n.whatsapp_number || n.phone_number || "");
      if (!key) continue;
      const entry = byPartner.get(key) ?? { userId: n.partner_user_id, notes: [] };
      entry.notes.push(n);
      byPartner.set(key, entry);
    }
    summary.partners_with_pending = byPartner.size;
    if (byPartner.size === 0) {
      return new Response(JSON.stringify({ success: true, ...summary }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Profile phone fallback for partners whose note carried no number.
    const userIds = [...new Set([...byPartner.values()].map((e) => e.userId).filter(Boolean))] as string[];
    const profileById = new Map<string, { full_name: string | null; phone: string | null }>();
    if (userIds.length) {
      const { data: profiles, error: profErr } = await admin
        .from("profiles")
        .select("id, full_name, phone")
        .in("id", userIds);
      if (profErr) throw new Error(profErr.message);
      for (const p of profiles ?? []) {
        profileById.set(p.id as string, { full_name: p.full_name, phone: p.phone });
      }
    }

    const queue = [...byPartner.entries()];
    const worker = async () => {
      while (queue.length) {
        const [partnerKey, entry] = queue.shift()!;
        const { userId, notes: partnerNotes } = entry;

        const profile = userId ? profileById.get(userId) : undefined;
        const phone = partnerNotes.find((n) => n.whatsapp_number)?.whatsapp_number
          ?? partnerNotes.find((n) => n.phone_number)?.phone_number
          ?? profile?.phone
          ?? null;
        if (!phone) { summary.skipped_no_phone++; continue; }

        const partnerName = partnerNotes.find((n) => n.partner_name)?.partner_name
          ?? profile?.full_name
          ?? partnerKey;
        const message = buildMessage(partnerNotes);

        if (dryRun) {
          summary.preview.push({ partner: partnerName, notes: partnerNotes.length, message });
          summary.partners_texted++;
          continue;
        }

        try {
          const ok = await sendSMS(phone, message, {
            admin,
            source: "partner_promissory_note_reminder",
            recipient_user_id: userId,
            recipient_name: partnerName,
            // One reminder per partner per day, whatever else triggers a run.
            idempotencyKey: `partner-promise-reminder-${partnerKey}-${runDate}`,
          });
          if (ok) summary.partners_texted++;
          else summary.errors.push(`${partnerKey}: send returned false`);
        } catch (e) {
          summary.errors.push(`${partnerKey}: ${e instanceof Error ? e.message : "send failed"}`);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

    return new Response(JSON.stringify({ success: true, ...summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[partner-promissory-note-reminders] failed", e instanceof Error ? e.message : e);
    return new Response(
      JSON.stringify({ success: false, error: e instanceof Error ? e.message : "failed", ...summary }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
