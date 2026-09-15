// Reminds proxy agents about promissory notes still waiting to be fulfilled.
//
// ONE MESSAGE PER AGENT, NOT PER NOTE
// 64 notes sit with 35 agents, and one agent holds 12. Texting per note would
// send that person a dozen messages in a morning and teach them to ignore all
// of them. Each agent gets a single SMS.
//
// TWO SHAPES, BECAUSE THE DISTRIBUTION IS LOPSIDED
// 26 of the 35 agents have exactly ONE pending note. Telling them "you have 1
// note waiting" is strictly worse than naming it - they would have to open the
// app to learn who. So a single note names the partner and the amount, and
// several notes give the count, the total and the oldest.
//
// WHO IS SKIPPED
//   * notes created in the last 48 hours - nobody is late yet;
//   * agents who recorded a follow-up in the last 7 days - they are already
//     chasing it, and nagging someone who acted is how a reminder channel
//     loses its meaning.
//
// The signup prompt is suppressed: every recipient is a working proxy agent,
// so "Not on Welile yet?" is nonsense to them, and it costs a second SMS
// segment on a message whose whole point is to be cheap.
//
// Read-only over promissory notes. No wallet, ledger or note state is changed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";
import { suppressSignupPrompt } from "../_shared/smsSignupPrompt.ts";

// Marketing copy has no place on an operational reminder to a working agent.
suppressSignupPrompt();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Do not chase a note younger than this - nobody is late yet. */
const GRACE_HOURS = 48;
/** Do not text an agent who already followed something up this recently. */
const FOLLOW_UP_QUIET_DAYS = 7;
const CONCURRENCY = 5;

interface Note {
  id: string;
  agent_id: string;
  partner_name: string | null;
  amount: number | null;
  created_at: string;
  last_followed_up_on: string | null;
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

/** A long partner name would push the message into a second segment. */
function shortName(name: string | null): string {
  const n = (name ?? "").trim();
  if (!n) return "your partner";
  return n.length <= 28 ? n : `${n.slice(0, 27)}…`;
}

function buildMessage(notes: Note[]): string {
  if (notes.length === 1) {
    const n = notes[0];
    return `Welile: ${shortName(n.partner_name)}'s promissory note of ` +
      `${ugx(Number(n.amount ?? 0))} is still pending. Please follow up with them today.`;
  }
  const total = notes.reduce((s, n) => s + Number(n.amount ?? 0), 0);
  const oldest = notes.reduce((a, b) => (a.created_at <= b.created_at ? a : b));
  return `Welile: You have ${notes.length} promissory notes still pending, ` +
    `${ugx(total)} in total. Oldest: ${shortName(oldest.partner_name)}, ` +
    `${daysOld(oldest.created_at)} days. Please follow them up.`;
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
  // checked against live data without texting 35 people.
  const dryRun = body.dry_run === true;

  const runDate = kampalaDate();
  const summary = {
    date: runDate, dry_run: dryRun,
    agents_with_pending: 0, agents_texted: 0,
    skipped_recent_follow_up: 0, skipped_no_phone: 0,
    notes_considered: 0, errors: [] as string[],
    preview: [] as { agent: string; notes: number; message: string }[],
  };

  try {
    const cutoff = new Date(Date.now() - GRACE_HOURS * 3_600_000).toISOString();

    const { data: rawNotes, error: notesErr } = await admin
      .from("promissory_notes")
      .select("id, agent_id, partner_name, amount, created_at, last_followed_up_on")
      .eq("status", "pending")
      .lt("created_at", cutoff);
    if (notesErr) throw new Error(notesErr.message);

    const notes = (rawNotes ?? []) as Note[];
    summary.notes_considered = notes.length;

    const byAgent = new Map<string, Note[]>();
    for (const n of notes) {
      if (!n.agent_id) continue;
      const list = byAgent.get(n.agent_id) ?? [];
      list.push(n);
      byAgent.set(n.agent_id, list);
    }
    summary.agents_with_pending = byAgent.size;
    if (byAgent.size === 0) {
      return new Response(JSON.stringify({ success: true, ...summary }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: profiles, error: profErr } = await admin
      .from("profiles")
      .select("id, full_name, phone")
      .in("id", [...byAgent.keys()]);
    if (profErr) throw new Error(profErr.message);
    const profileById = new Map((profiles ?? []).map((p) => [p.id as string, p]));

    const quietSince = new Date(Date.now() - FOLLOW_UP_QUIET_DAYS * 86_400_000)
      .toISOString().slice(0, 10);

    const queue = [...byAgent.entries()];
    const worker = async () => {
      while (queue.length) {
        const [agentId, agentNotes] = queue.shift()!;

        // Already chasing it? Leave them alone.
        const chasing = agentNotes.some(
          (n) => n.last_followed_up_on && n.last_followed_up_on >= quietSince,
        );
        if (chasing) { summary.skipped_recent_follow_up++; continue; }

        const profile = profileById.get(agentId);
        const phone = (profile?.phone as string | null) ?? null;
        if (!phone) { summary.skipped_no_phone++; continue; }

        const message = buildMessage(agentNotes);

        if (dryRun) {
          summary.preview.push({
            agent: (profile?.full_name as string) || agentId,
            notes: agentNotes.length,
            message,
          });
          summary.agents_texted++;
          continue;
        }

        try {
          const ok = await sendSMS(phone, message, {
            admin,
            source: "proxy_promissory_note_reminder",
            recipient_user_id: agentId,
            recipient_name: (profile?.full_name as string) || null,
            // One reminder per agent per day, whatever else triggers a run.
            idempotencyKey: `promissory-reminder-${agentId}-${runDate}`,
          });
          if (ok) summary.agents_texted++;
          else summary.errors.push(`${agentId}: send returned false`);
        } catch (e) {
          summary.errors.push(`${agentId}: ${e instanceof Error ? e.message : "send failed"}`);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

    return new Response(JSON.stringify({ success: true, ...summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[proxy-promissory-note-reminders] failed", e instanceof Error ? e.message : e);
    return new Response(
      JSON.stringify({ success: false, error: e instanceof Error ? e.message : "failed", ...summary }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
