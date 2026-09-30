// Groups calling-center comments into themes with counts, for the Combined
// Calling Center Report. Read-only: it only receives text and returns counts.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['themes'],
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['theme', 'ids', 'insight'],
        properties: {
          theme: { type: 'string' },
          ids: { type: 'array', items: { type: 'integer' } },
          insight: { type: 'string' },
        },
      },
    },
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => null);
    const comments: unknown = body?.comments;
    if (!Array.isArray(comments) || comments.some((c) => typeof c !== 'string'))
      return json({ error: 'comments must be an array of strings' }, 400);
    const list = (comments as string[]).map((c) => c.trim().slice(0, 400)).filter(Boolean).slice(0, 1500);
    if (!list.length) return json({ themes: [], total: 0 });

    const apiKey = Deno.env.get('LOVABLE_API_KEY');
    if (!apiKey) return json({ error: 'AI is not configured' }, 500);

    const numbered = list.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const res = await fetch('https://ai.gateway.lovable.dev/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Lovable-API-Key': apiKey, 'X-Lovable-AIG-SDK': 'fetch' },
      body: JSON.stringify({
        model: 'openai/gpt-6-astra',
        stream: true,
        store: false,
        reasoning: { effort: 'low', summary: 'auto' },
        include: ['reasoning.encrypted_content'],
        instructions:
          'You analyse comments that call-centre officers typed after calls with tenants, landlords and agents of Welile, a rent-support company in Uganda. Group the numbered comments into 4 to 12 clear themes in plain English (e.g. "Asking for rent support", "Did not know about Welile", "Phone off / not reachable", "Promised to pay"). Every comment id goes into exactly one theme; use "Other" for leftovers. Theme names are short. insight is one short sentence on what the theme means for operations. Use the words "Rent Plan" not loan, "Supporter" not lender, "Returns" not interest.',
        input: `Comments:\n${numbered}`,
        text: { format: { type: 'json_schema', name: 'themes', strict: true, schema } },
      }),
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      return json({ error: `AI request failed (${res.status})`, detail: t.slice(0, 300) }, res.status === 402 || res.status === 429 ? res.status : 502);
    }

    let out = '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        try {
          const ev = JSON.parse(d);
          if (ev.type === 'response.output_text.delta') out += ev.delta ?? '';
        } catch { /* ignore */ }
      }
    }
    const parsed = JSON.parse(out || '{"themes":[]}') as { themes: { theme: string; ids: number[]; insight: string }[] };
    const seen = new Set<number>();
    const themes = parsed.themes
      .map((t) => {
        const ids = [...new Set(t.ids)].filter((i) => i >= 1 && i <= list.length && !seen.has(i));
        ids.forEach((i) => seen.add(i));
        return { theme: t.theme, count: ids.length, insight: t.insight, example: ids.length ? list[ids[0] - 1] : '' };
      })
      .filter((t) => t.count > 0)
      .sort((a, b) => b.count - a.count);
    const missing = list.length - seen.size;
    if (missing > 0) themes.push({ theme: 'Other / unclassified', count: missing, insight: 'Comments the analysis could not place in a theme.', example: '' });
    return json({ themes, total: list.length });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'failed' }, 500);
  }
});
