import "../_shared/smsFooterInterceptor.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ALLOWED_ROLES = ['coo', 'ceo', 'cto', 'super_admin', 'manager'];

// -----------------------------------------------------------------------------
// Full-name validator — MUST stay in sync with src/lib/authValidation.ts so the
// signup gate, in-app NameCompletionGate and this SMS warning campaign all agree
// on what counts as a malformed name.
// -----------------------------------------------------------------------------
const DUMMY = new Set([
  'test','testing','tester','demo','sample','example','dummy','fake','user','users',
  'admin','name','fullname','firstname','lastname','unknown','none','null','undefined',
  'na','nan','xxx','abc','abcd','asdf','asdfg','asdfgh','qwerty','qwe','qwer','zxc',
  'zxcv','aaa','bbb','ccc','ddd','lorem','ipsum','anonymous','nobody',
]);

function isGibberish(token: string): boolean {
  const t = token.toLowerCase().replace(/[^a-z]/g, '');
  if (t.length < 2) return false;
  if (DUMMY.has(t)) return true;
  const vowels = (t.match(/[aeiou]/g) || []).length;
  if (t.length >= 4 && vowels === 0) return true;
  if (t.length >= 5 && vowels / t.length < 0.2) return true;
  if (/^(.)\1+$/.test(t)) return true;
  if (/(.)\1{3,}/.test(t)) return true;
  if (/[bcdfghjklmnpqrstvwxz]{4,}/.test(t)) return true;
  return false;
}

type NameIssue = 'empty' | 'one_name' | 'too_short' | 'gibberish';

function classifyName(raw: string | null | undefined): NameIssue | null {
  const trimmed = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (trimmed.length < 2) return 'empty';
  const parts = trimmed.split(' ').filter((p) => p.replace(/[^a-zA-Z]/g, '').length > 0);
  if (parts.length < 2) return 'one_name';
  if (parts.some((p) => p.replace(/[^a-zA-Z]/g, '').length < 2)) return 'too_short';
  if (parts.some((p) => isGibberish(p))) return 'gibberish';
  return null;
}

// ---- SMS plumbing (Yoola primary, Africa's Talking / Lana fallback) ---------
function formatPhoneInternational(phone: string): string {
  let digits = (phone || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('2560') && digits.length >= 13) digits = `256${digits.slice(4)}`;
  if (digits.startsWith('256')) return `+${digits}`;
  if (digits.startsWith('0')) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}
function isValidPhone(p: string | null | undefined): boolean {
  if (!p) return false;
  return /^\+256\d{9}$/.test(formatPhoneInternational(String(p).trim()));
}
const toBareDigits = (p: string) => formatPhoneInternational(p).replace(/^\+/, '');

async function sendViaYoola(phone: string, message: string) {
  const apiKey = Deno.env.get('YOOLA_SMS_API_KEY')?.trim();
  if (!apiKey) return { accepted: false, reason: 'yoola_not_configured' };
  try {
    // WELILE is the registered sender ID on Yoola and must be set explicitly.
    const res = await fetch('https://yoolasms.com/api/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ phone: toBareDigits(phone), message, api_key: apiKey, sender: "WELILE" }),
    });
    const text = await res.text();
    let data: any = {}; try { data = JSON.parse(text); } catch { /* */ }
    const status = String(data?.status ?? '').toLowerCase();
    if (res.ok && (status === 'success' || status === 'ok' || status === 'sent' || status === 'queued' || (!data?.error && status === ''))) {
      return { accepted: true };
    }
    return { accepted: false, reason: `yoola_${res.status}` };
  } catch (e) { return { accepted: false, reason: (e as Error).message }; }
}

async function sendSMS(phone: string, message: string) {
  if (!isValidPhone(phone)) return { accepted: false, reason: 'invalid_ugandan_phone' };
  const y = await sendViaYoola(phone, message);
  if (y.accepted) return y;
  return y;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing auth' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: userData, error: userErr } = await admin.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const { data: roles } = await admin.from('user_roles').select('role').eq('user_id', userData.user.id);
    if (!(roles || []).some((r: any) => ALLOWED_ROLES.includes(r.role))) {
      return new Response(JSON.stringify({ error: 'Insufficient permissions' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const body = await req.json().catch(() => ({}));
    const dryRun = !!body.dry_run;
    const limit = Math.max(1, Math.min(5000, Number(body.limit) || 2000));

    // Page profiles that have an email (per user request: everyone with an email).
    const PAGE = 1000;
    let from = 0;
    const targets: { id: string; phone: string; issue: NameIssue }[] = [];
    while (targets.length < limit) {
      const { data, error } = await admin
        .from('profiles')
        .select('id, full_name, phone, email')
        .not('email', 'is', null)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const p of data) {
        const issue = classifyName(p.full_name);
        if (!issue) continue;
        if (!isValidPhone(p.phone)) continue;
        targets.push({ id: p.id, phone: formatPhoneInternational(p.phone), issue });
        if (targets.length >= limit) break;
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }

    if (dryRun) {
      const byIssue: Record<string, number> = {};
      for (const t of targets) byIssue[t.issue] = (byIssue[t.issue] || 0) + 1;
      return new Response(JSON.stringify({ success: true, dry_run: true, recipient_count: targets.length, by_issue: byIssue }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // De-dup phones and honour SMS exception blocklist.
    const seen = new Set<string>();
    const dedup = targets.filter((t) => (seen.has(t.phone) ? false : (seen.add(t.phone), true)));
    const { data: exRows } = await admin.from('sms_message_exceptions').select('phone').in('message_type', ['all', 'profile_reminder']);
    const blocked = new Set((exRows || []).map((r: any) => formatPhoneInternational(r.phone)));
    const finalList = dedup.filter((t) => !blocked.has(t.phone));

    let sent = 0; let failed = 0;
    for (const t of finalList) {
      const msg = t.issue === 'one_name'
        ? 'Welile: Your profile only has one name. Please open the app and add your full legal name (first and last) so your receipts and payouts are correct.'
        : 'Welile: Your profile name looks incomplete. Please open the app and enter your full legal name (first and last) so we can verify your payouts and rent records.';
      const res = await sendSMS(t.phone, msg);
      if (res.accepted) sent++; else failed++;
      // Small pacing to be nice to the provider.
      await new Promise((r) => setTimeout(r, 60));
    }

    return new Response(JSON.stringify({ success: true, scanned: targets.length, unique: finalList.length, sent, failed }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});