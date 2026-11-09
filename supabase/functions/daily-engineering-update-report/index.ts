// Daily Engineering Update (the "daily features report")
// Every evening, emails the CEO (CC Josh) a plain-English summary of what the
// engineers shipped in the last 24 hours. Source of truth is the commit history
// of the `lovable` branch on GitHub; an AI model rewrites the commit notes so a
// non-engineer can read them: what changed, who it helps, no code words.
//
// Secrets needed (Edge Function secrets):
//   GITHUB_TOKEN     read-only token (Contents: read) for the repo below
//   LOVABLE_API_KEY  already set; used for the AI rewrite
//   MAILGUN_API_KEY / MAILGUN_DOMAIN  already set
//
// Invocation:
//   POST /daily-engineering-update-report                 -> last 24h, default recipients (cron)
//   POST body: { "hours": 24, "to": [...], "cc": [...], "dry_run": true }
//     - overrides are honoured only for a signed-in executive, so the public
//       anon key can't redirect the email or read the summary back.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const REPO = 'weliletenants-sys/welilereceipts-com-98bba33b';
const BRANCH = 'lovable';
const FROM = 'Welile Reports <reports@welile.com>';
const DEFAULT_TO = ['benjamin@welile.com'];
const DEFAULT_CC = ['joshwanda17@gmail.com'];
const EXEC_ROLES = ['ceo', 'cfo', 'coo', 'cto', 'manager', 'super_admin'];
const MAX_COMMITS = 40;
const AI_MODEL = 'google/gemini-3-flash-preview';

type Json = Record<string, any>;

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function validEmails(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((r): r is string => typeof r === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));
  return out.length ? out : null;
}

function prettyDate(d: Date) {
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Kampala' });
}

async function gh(path: string, token: string) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Commits in the window, merges removed, with the folders each one touched. */
async function recentWork(token: string, sinceIso: string) {
  const list: Json[] = await gh(`commits?sha=${BRANCH}&since=${encodeURIComponent(sinceIso)}&per_page=100`, token);
  const real = list.filter((c) => (c.parents?.length ?? 0) < 2).slice(0, MAX_COMMITS);
  const out: { message: string; author: string; areas: string[] }[] = [];
  for (const c of real) {
    let areas: string[] = [];
    try {
      const full: Json = await gh(`commits/${c.sha}`, token);
      areas = [...new Set((full.files ?? []).map((f: Json) => String(f.filename).split('/').slice(0, 3).join('/')))].slice(0, 12) as string[];
    } catch { /* areas are a hint only */ }
    out.push({ message: String(c.commit?.message ?? '').slice(0, 900), author: c.commit?.author?.name ?? 'Engineer', areas });
  }
  return { out, totalSeen: list.length };
}

const SYSTEM_PROMPT = `You write a daily update for the CEO of Welile, a Ugandan rent-financing company. The CEO is smart but not an engineer.
You get a list of what engineers changed today (commit notes plus the folders touched). Turn it into plain English.

Rules:
- Say WHAT now works differently and WHO it helps (tenants, agents, landlords, Supporters, finance team, support staff, management). Never say how it was built.
- No code words: no file names, function names, "RPC", "migration", "edge function", "refactor", "schema", "endpoint", "table". Say "the screen", "the report", "the payout".
- Mandatory vocabulary: "Rent Plan" (never loan), "Supporter" (never lender/investor), "Returns" (never ROI or interest).
- Group related commits into one item. Skip pure housekeeping (formatting, dependency bumps, docs) unless it affects safety or money; mention those in one line at most.
- Each item: a short title (max 8 words), "what_changed" (one or two plain sentences), "who_benefits" (a few words), and "kind" = one of "new" (something new), "fixed" (a problem fixed), "safer" (security or money safety), "faster" (speed or smoother use), "behind_the_scenes".
- Flag anything touching money (payouts, wallets, balances, Returns) with "money": true.
- "headline": one sentence summarising the day. "needs_attention": list of short plain sentences for things the CEO may need to act on or know (empty list if none). Never invent anything not supported by the commit notes.
Reply with JSON only: {"headline":string,"items":[{"title":string,"what_changed":string,"who_benefits":string,"kind":string,"money":boolean}],"needs_attention":[string]}`;

async function explain(work: { message: string; author: string; areas: string[] }[], key: string): Promise<Json> {
  const payload = work.map((w, i) => `#${i + 1} (${w.author})\n${w.message}\nTouched: ${w.areas.join(', ') || 'n/a'}`).join('\n\n');
  const res = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: payload }],
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`AI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const raw: string = data?.choices?.[0]?.message?.content ?? '';
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  if (!parsed || !Array.isArray(parsed.items)) throw new Error('AI reply had no items');
  return parsed;
}

const KIND: Record<string, { label: string; color: string }> = {
  new: { label: 'NEW', color: '#0d7a4f' },
  fixed: { label: 'FIXED', color: '#b45309' },
  safer: { label: 'SAFER', color: '#1d4ed8' },
  faster: { label: 'SMOOTHER', color: '#6d28d9' },
  behind_the_scenes: { label: 'BEHIND THE SCENES', color: '#57534e' },
};

function render(summary: Json | null, dateLabel: string, commitCount: number) {
  const items: Json[] = summary?.items ?? [];
  const attention: string[] = summary?.needs_attention ?? [];
  const subject = items.length
    ? `Welile Engineering Update — ${dateLabel} — ${items.length} change${items.length === 1 ? '' : 's'} shipped`
    : `Welile Engineering Update — ${dateLabel} — quiet day`;

  const t: string[] = [`WELILE ENGINEERING UPDATE — ${dateLabel.toUpperCase()}`, '━━━━━━━━━━━━━━━━━━'];
  const h: string[] = [];
  if (!items.length) {
    const msg = 'No new changes were released to the live app in the last 24 hours.';
    t.push(msg);
    h.push(`<p style="font-size:16px;color:#1c1917">${msg}</p>`);
  } else {
    t.push(summary!.headline, '');
    h.push(`<p style="font-size:17px;line-height:1.5;color:#1c1917;margin:0 0 18px"><b>${esc(summary!.headline)}</b></p>`);
    if (attention.length) {
      t.push('WORTH YOUR ATTENTION', ...attention.map((a) => `  ! ${a}`), '');
      h.push(
        `<div style="background:#fffbeb;border-left:4px solid #b45309;padding:12px 16px;margin:0 0 20px;border-radius:4px"><b style="color:#92400e">Worth your attention</b><ul style="margin:6px 0 0;padding-left:18px;color:#1c1917">${attention.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>`,
      );
    }
    t.push('WHAT THE TEAM DID TODAY');
    h.push(`<h3 style="margin:0 0 10px;color:#1c1917;font-size:15px;letter-spacing:.04em">WHAT THE TEAM DID TODAY</h3>`);
    items.forEach((it, i) => {
      const k = KIND[it.kind] ?? KIND.behind_the_scenes;
      const money = it.money ? ' [involves money]' : '';
      t.push(`${i + 1}. [${k.label}] ${it.title}${money}`, `   ${it.what_changed}`, `   Helps: ${it.who_benefits}`, '');
      h.push(
        `<div style="margin:0 0 14px;padding:12px 14px;border:1px solid #e7e5e4;border-radius:8px">` +
          `<span style="display:inline-block;font-size:11px;font-weight:700;color:#fff;background:${k.color};padding:2px 8px;border-radius:99px">${k.label}</span>` +
          (it.money ? ` <span style="display:inline-block;font-size:11px;font-weight:700;color:#92400e;background:#fef3c7;padding:2px 8px;border-radius:99px">INVOLVES MONEY</span>` : '') +
          `<div style="font-size:15px;font-weight:700;color:#1c1917;margin:6px 0 2px">${esc(it.title)}</div>` +
          `<div style="font-size:14px;line-height:1.5;color:#292524">${esc(it.what_changed)}</div>` +
          `<div style="font-size:13px;color:#57534e;margin-top:4px">Helps: ${esc(it.who_benefits)}</div></div>`,
      );
    });
  }
  const foot = `Covers the last 24 hours (${commitCount} engineering update${commitCount === 1 ? '' : 's'} reviewed). Sent automatically every evening.`;
  t.push('━━━━━━━━━━━━━━━━━━', foot);
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#fff">` +
    `<div style="font-size:12px;letter-spacing:.08em;color:#78716c">WELILE · ENGINEERING UPDATE</div>` +
    `<h2 style="margin:2px 0 16px;color:#1c1917">${esc(dateLabel)}</h2>${h.join('')}` +
    `<p style="font-size:12px;color:#78716c;border-top:1px solid #e7e5e4;padding-top:10px;margin-top:20px">${esc(foot)}</p></div>`;
  return { subject, text: t.join('\n'), html };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: Json, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const mailgunApiKey = Deno.env.get('MAILGUN_API_KEY');
    const mailgunDomain = Deno.env.get('MAILGUN_DOMAIN');
    const mailgunBaseUrl = Deno.env.get('MAILGUN_API_BASE') || 'https://api.mailgun.net';
    const ghToken = Deno.env.get('GITHUB_TOKEN');
    const aiKey = Deno.env.get('LOVABLE_API_KEY');
    if (!supabaseUrl || !serviceKey || !mailgunApiKey || !mailgunDomain) return json({ error: 'Server not configured' }, 500);
    if (!ghToken) return json({ error: 'GITHUB_TOKEN secret is not set' }, 503);
    if (!aiKey) return json({ error: 'LOVABLE_API_KEY secret is not set' }, 503);

    const body: Json = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const wantsOverrides = body.hours || body.to || body.cc || body.dry_run;

    let isExec = false;
    const authHeader = req.headers.get('Authorization') ?? '';
    const admin = createClient(supabaseUrl, serviceKey);
    if (wantsOverrides && anonKey && authHeader.startsWith('Bearer ')) {
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
      const { data: u } = await userClient.auth.getUser();
      if (u?.user) {
        const { data: roles } = await admin.from('user_roles').select('role').eq('user_id', u.user.id).in('role', EXEC_ROLES);
        isExec = (roles?.length ?? 0) > 0;
      }
    }
    if (wantsOverrides && !isExec) return json({ error: 'Overrides (hours/to/cc/dry_run) require an executive sign-in' }, 403);

    const hours = isExec && Number.isFinite(Number(body.hours)) ? Math.min(168, Math.max(1, Number(body.hours))) : 24;
    const to = (isExec && validEmails(body.to)) || DEFAULT_TO;
    const cc = isExec && body.cc !== undefined ? (validEmails(body.cc) ?? []) : DEFAULT_CC;

    const since = new Date(Date.now() - hours * 3600_000);
    const { out: work } = await recentWork(ghToken, since.toISOString());

    // Never send engineer-speak to the CEO: if the AI step fails, fail the run.
    let summary: Json | null = null;
    if (work.length) {
      try { summary = await explain(work, aiKey); } catch (e) {
        console.error('explain failed', e);
        return json({ error: 'ai_summary_failed', details: String((e as Error).message) }, 502);
      }
    }

    const email = render(summary, prettyDate(new Date()), work.length);
    if (isExec && body.dry_run) return json({ ok: true, dry_run: true, to, cc, subject: email.subject, commits: work.length, text: email.text });

    const form = new FormData();
    form.set('from', FROM);
    to.forEach((r) => form.append('to', r));
    cc.forEach((r) => form.append('cc', r));
    form.set('subject', email.subject);
    form.set('text', email.text);
    form.set('html', email.html);
    form.set('o:tag', 'engineering-update-daily');
    const mgRes = await fetch(`${mailgunBaseUrl}/v3/${mailgunDomain}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`api:${mailgunApiKey}`) },
      body: form,
    });
    const mgText = await mgRes.text();
    if (!mgRes.ok) {
      console.error('Mailgun send failed', mgRes.status, mgText);
      return json({ error: 'Mailgun send failed', status: mgRes.status, details: mgText }, 502);
    }
    return json({ ok: true, to, cc, subject: email.subject, commits: work.length });
  } catch (e) {
    console.error('daily-engineering-update-report error', e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
