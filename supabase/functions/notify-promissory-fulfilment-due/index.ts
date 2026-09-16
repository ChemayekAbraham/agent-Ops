import "../_shared/smsFooterInterceptor.ts";
// Fulfilment-day reminders for promissory notes.
//
// NOT DIRECT: nothing is texted at the moment a note is created or edited.
// A daily run asks the database to queue a notice for every note whose
// promised fulfilment day is today and which is still unfulfilled, then this
// worker drains that queue. Queue rows are unique per (note, due day,
// recipient), so a re-run never doubles a message.
//
// Both sides are reminded: the proxy agent who recorded the note, and the
// partner who promised the funding. Read-only over notes - no wallet, ledger
// or note state is changed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";
import { suppressSignupPrompt } from "../_shared/smsSignupPrompt.ts";

// Recipients are a working agent and a partner who already pledged: the
// "not on Welile yet?" tail is nonsense to them and costs a second segment.
suppressSignupPrompt();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const ugx = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

const firstName = (name: string | null | undefined, fallback: string) => {
  const n = String(name || "").trim();
  return n ? n.split(/\s+/)[0] : fallback;
};

/** A long name would push the message into a second SMS segment. */
const shortName = (name: string | null | undefined, fallback: string) => {
  const n = String(name || "").trim() || fallback;
  return n.length <= 28 ? n : `${n.slice(0, 27)}…`;
};

interface Notice {
  id: string;
  note_id: string;
  due_on: string;
  recipient_role: "agent" | "partner";
  recipient_user_id: string | null;
  recipient_name: string | null;
  phone: string | null;
  partner_name: string | null;
  agent_name: string | null;
  amount: number | null;
  outstanding: number | null;
  attempts: number | null;
}

function buildMessage(n: Notice): string {
  const amount = ugx(Number(n.outstanding ?? n.amount ?? 0));
  if (n.recipient_role === "agent") {
    return (
      `Welile: Today is the fulfilment day for ${shortName(n.partner_name, "your partner")}'s ` +
      `promissory note of ${amount}. Please follow up with them today.`
    );
  }
  return (
    `Welile: ${firstName(n.recipient_name ?? n.partner_name, "Hello")}, today is the fulfilment ` +
    `day for your rent funding pledge of ${amount}. ` +
    `${shortName(n.agent_name, "Your Welile agent")} will follow up with you.`
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* cron sends no body */ }
  // A dry run queues nothing and sends nothing - it only shows what today's
  // messages would say, so wording can be checked against live data.
  const dryRun = body.dry_run === true;
  const limit = Math.min(Number(body.limit) || 200, 500);

  const summary = {
    dry_run: dryRun,
    queued: 0,
    processed: 0,
    sms_sent: 0,
    skipped_no_phone: 0,
    errors: [] as string[],
    preview: [] as { role: string; to: string | null; message: string }[],
  };

  try {
    if (!dryRun) {
      const { data: queued, error: queueErr } = await admin.rpc(
        "psm_queue_promissory_fulfilment_notices",
        {},
      );
      if (queueErr) throw new Error(queueErr.message);
      summary.queued = Number(queued) || 0;
    }

    const { data: rows, error } = await admin
      .from("promissory_note_fulfilment_notices")
      .select(
        "id, note_id, due_on, recipient_role, recipient_user_id, recipient_name, phone, partner_name, agent_name, amount, outstanding, attempts",
      )
      .eq("sms_status", "pending")
      .lt("attempts", 5)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(error.message);

    const notices = (rows ?? []) as Notice[];

    for (const notice of notices) {
      summary.processed++;
      const message = buildMessage(notice);

      if (dryRun) {
        summary.preview.push({ role: notice.recipient_role, to: notice.phone, message });
        continue;
      }

      const patch: Record<string, unknown> = { attempts: (notice.attempts || 0) + 1 };

      if (!notice.phone) {
        patch.sms_status = "skipped";
        patch.last_error = "missing_phone";
        summary.skipped_no_phone++;
      } else {
        try {
          const ok = await sendSMS(notice.phone, message, {
            admin,
            source: "promissory_fulfilment_due_reminder",
            recipient_user_id: notice.recipient_user_id ?? undefined,
            recipient_name: notice.recipient_name ?? undefined,
            // One message per note, per due day, per side - whatever re-runs.
            idempotencyKey: `promissory-fulfilment-${notice.note_id}-${notice.due_on}-${notice.recipient_role}`,
          });
          if (ok) {
            patch.sms_status = "sent";
            patch.sent_at = new Date().toISOString();
            summary.sms_sent++;
          } else {
            patch.last_error = "send_returned_false";
            summary.errors.push(`${notice.id}: send returned false`);
          }
        } catch (e) {
          patch.last_error = e instanceof Error ? e.message : "send_failed";
          summary.errors.push(`${notice.id}: ${patch.last_error}`);
        }
      }

      const { error: updErr } = await admin
        .from("promissory_note_fulfilment_notices")
        .update(patch)
        .eq("id", notice.id);
      if (updErr) summary.errors.push(`${notice.id}: ${updErr.message}`);

      // In-app companion, only for recipients who have an account.
      if (patch.sms_status === "sent" && notice.recipient_user_id) {
        await admin.from("notifications").insert({
          user_id: notice.recipient_user_id,
          title: "Promissory note fulfilment day",
          message,
          link_path: notice.recipient_role === "agent" ? "/agent/proxy-agents" : "/dashboard",
          metadata: { note_id: notice.note_id, due_on: notice.due_on, role: notice.recipient_role },
        });
      }
    }

    return json(200, { success: true, ...summary });
  } catch (e) {
    console.error("[notify-promissory-fulfilment-due] failed", e);
    return json(500, {
      success: false,
      error: e instanceof Error ? e.message : "failed",
      ...summary,
    });
  }
});
