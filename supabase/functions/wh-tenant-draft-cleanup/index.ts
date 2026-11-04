// Daily: remind agents 7 days before, then delete Welile Homes tenant drafts untouched for 30 days,
// including their private passport photos. Enrolled tenants and their IDs are never touched
// (the database function only returns draft photos no tenant ID uses). Logs counts only.
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const BUCKET = 'wh-tenant-id-photos';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data, error } = await admin.rpc('wh_tenant_drafts_cleanup');
    if (error) return json({ error: error.message }, 500);
    const res = data as { log_id: number; drafts_deleted: number; reminders_sent: number; photo_paths: string[] };
    const paths = (res.photo_paths ?? []).filter((p) => typeof p === 'string' && p.split('/')[1] === 'drafts');
    let removed = 0, failed = 0;
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      const { error: rmErr } = await admin.storage.from(BUCKET).remove(batch);
      if (rmErr) failed += batch.length; else removed += batch.length;
    }
    await admin.from('wh_tenant_draft_cleanup_log')
      .update({ photos_deleted: removed, photos_failed: failed }).eq('id', res.log_id);
    return json({ drafts_deleted: res.drafts_deleted, reminders_sent: res.reminders_sent, photos_deleted: removed, photos_failed: failed });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'cleanup failed' }, 500);
  }
});
