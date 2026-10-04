// Background User Analytics export worker.
// Client inserts an analytics_export_jobs row, then invokes this fn with { job_id }.
// Fn streams data, writes CSV to Storage, and updates progress along the way.
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'analytics-exports';

function csvRow(vals: (string | number | null | undefined)[]): string {
  return vals
    .map((v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  let jobId: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    jobId = body?.job_id ?? null;
    if (!jobId) throw new Error('job_id required');

    const { data: job, error: jobErr } = await admin
      .from('analytics_export_jobs').select('*').eq('id', jobId).single();
    if (jobErr || !job) throw new Error(jobErr?.message || 'job not found');

    const params = job.params || {};
    const start = params.start as string;
    const end = params.end as string;
    if (!start || !end) throw new Error('params.start and params.end required');

    const update = (patch: Record<string, unknown>) =>
      admin.from('analytics_export_jobs').update(patch).eq('id', jobId);

    await update({ status: 'running', progress: 5 });

    // 1) Signups (paginated to avoid 1k limit)
    const signups: { created_at: string; referrer_id: string | null; id: string; email: string | null; full_name: string | null; active_role: string | null }[] = [];
    let from = 0; const page = 1000;
    while (true) {
      const { data, error } = await admin
        .from('profiles')
        .select('id, created_at, referrer_id, email, full_name, active_role')
        .gte('created_at', start).lte('created_at', end)
        .order('created_at', { ascending: true })
        .range(from, from + page - 1);
      if (error) throw error;
      if (!data?.length) break;
      signups.push(...data as any);
      if (data.length < page) break;
      from += page;
      await update({ progress: Math.min(45, 5 + Math.floor((signups.length / 5000) * 40)) });
    }

    await update({ progress: 50 });

    // 2) Login audit
    const logins: { created_at: string; resolved_user_id: string | null; actual_user_id: string | null; outcome: string }[] = [];
    from = 0;
    while (true) {
      const { data, error } = await admin
        .from('otp_login_audit')
        .select('created_at, resolved_user_id, actual_user_id, outcome')
        .gte('created_at', start).lte('created_at', end)
        .order('created_at', { ascending: true })
        .range(from, from + page - 1);
      if (error) throw error;
      if (!data?.length) break;
      logins.push(...data as any);
      if (data.length < page) break;
      from += page;
      await update({ progress: Math.min(85, 50 + Math.floor((logins.length / 20000) * 35)) });
    }

    await update({ progress: 90 });

    // 3) Role snapshot
    const { data: roleRows, error: roleErr } = await admin.from('user_roles').select('role');
    if (roleErr) throw roleErr;
    const roleCounts: Record<string, number> = {};
    (roleRows || []).forEach((r: any) => { roleCounts[r.role] = (roleCounts[r.role] || 0) + 1; });

    // Build CSV
    const lines: string[] = [];
    lines.push(`User Analytics Export,,${start} → ${end}`);
    lines.push('');
    lines.push('Summary');
    lines.push(csvRow(['Metric', 'Value']));
    lines.push(csvRow(['New signups', signups.length]));
    lines.push(csvRow(['Successful logins', logins.filter((l) => l.outcome === 'success').length]));
    lines.push(csvRow(['Login attempts', logins.length]));
    lines.push('');
    lines.push('Signups');
    lines.push(csvRow(['created_at', 'user_id', 'email', 'full_name', 'active_role', 'referrer_id']));
    for (const s of signups) {
      lines.push(csvRow([s.created_at, s.id, s.email, s.full_name, s.active_role, s.referrer_id]));
    }
    lines.push('');
    lines.push('Logins');
    lines.push(csvRow(['created_at', 'user_id', 'outcome']));
    for (const l of logins) {
      lines.push(csvRow([l.created_at, l.resolved_user_id || l.actual_user_id || '', l.outcome]));
    }
    lines.push('');
    lines.push('Users by Role');
    lines.push(csvRow(['role', 'count']));
    for (const [role, count] of Object.entries(roleCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(csvRow([role, count]));
    }

    const csv = lines.join('\n');
    const bytes = new TextEncoder().encode(csv);

    const filename = `user-analytics_${start.slice(0, 10)}_${end.slice(0, 10)}_${jobId.slice(0, 8)}.csv`;
    const path = `${job.requested_by}/${filename}`;
    const { error: upErr } = await admin.storage.from(BUCKET).upload(path, bytes, {
      contentType: 'text/csv; charset=utf-8',
      upsert: true,
    });
    if (upErr) throw upErr;

    await update({
      status: 'succeeded',
      progress: 100,
      file_path: path,
      row_count: signups.length + logins.length,
      completed_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({ ok: true, path, rows: signups.length + logins.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('generate-user-analytics-export failed', msg);
    if (jobId) {
      await admin.from('analytics_export_jobs').update({
        status: 'failed', error: msg, completed_at: new Date().toISOString(),
      }).eq('id', jobId);
    }
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});