import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ALLOWED = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const MAX_BYTES = 10 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  try {
    const form = await req.formData();
    const token = String(form.get('token') ?? '');
    const file = form.get('file');
    if (!token || !(file instanceof File)) return json({ error: 'missing' }, 400);
    if (!ALLOWED.has(file.type)) return json({ error: 'unsupported_type' }, 400);
    if (file.size > MAX_BYTES) return json({ error: 'too_large' }, 400);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: link } = await admin
      .from('requisition_links')
      .select('id, is_active, revoked_at, expires_at')
      .eq('token', token)
      .maybeSingle();
    if (!link || !link.is_active || link.revoked_at) return json({ error: 'invalid_token' }, 403);
    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return json({ error: 'expired' }, 403);

    const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const path = `${link.id}/${crypto.randomUUID()}.${ext}`;
    const bytes = new Uint8Array(await file.arrayBuffer());

    const { error: upErr } = await admin.storage
      .from('requisition-attachments')
      .upload(path, bytes, { contentType: file.type, upsert: false });
    if (upErr) throw upErr;

    return json({ ok: true, path, name: file.name }, 200);
  } catch (e) {
    console.error('upload error', e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }

  function json(body: unknown, status: number) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
