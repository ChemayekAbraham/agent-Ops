import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.104.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return toHex(hash)
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return toHex(sig)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const HMAC_SECRET = Deno.env.get('NFC_CARD_HMAC_SECRET')

    if (!HMAC_SECRET) {
      return new Response(JSON.stringify({ error: 'Card signing key not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const token = authHeader.replace('Bearer ', '')
    const { data: userData, error: userErr } = await adminClient.auth.getUser(token)
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const userId = userData.user.id

    const body = await req.json().catch(() => ({}))
    const pin = String(body?.pin ?? '')
    const pinlessLimitRaw = Number(body?.pinless_limit ?? 0)

    if (!/^\d{4,6}$/.test(pin)) {
      return new Response(JSON.stringify({ error: 'PIN must be 4-6 digits' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (!Number.isFinite(pinlessLimitRaw) || pinlessLimitRaw < 0 || pinlessLimitRaw > 10_000_000) {
      return new Response(JSON.stringify({ error: 'Invalid pinless limit' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const pinlessLimit = Math.floor(pinlessLimitRaw)

    // Generate Card ID (UUID) and HMAC signature
    const cardId = crypto.randomUUID()
    const issuedAt = new Date().toISOString()
    const payloadToSign = `${cardId}|${userId}|${pinlessLimit}|${issuedAt}`
    const hmacSignature = await hmacSha256Hex(HMAC_SECRET, payloadToSign)

    // Hash PIN with card_id as salt
    const pinHash = await sha256Hex(`${cardId}:${pin}`)

    // Revoke any previously active cards for this user
    await (adminClient.from('nfc_cards') as any)
      .update({ status: 'revoked', revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('status', 'active')

    const { error: insertErr } = await (adminClient.from('nfc_cards') as any).insert({
      user_id: userId,
      card_id: cardId,
      pin_hash: pinHash,
      pinless_limit: pinlessLimit,
      hmac_signature_preview: hmacSignature.slice(-12),
      status: 'active',
    })

    if (insertErr) {
      console.error('Insert error:', insertErr)
      return new Response(JSON.stringify({ error: 'Failed to save card' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const cardPayload = {
      version: 1,
      issuer: 'Welile',
      card_id: cardId,
      user_id: userId,
      pinless_limit: pinlessLimit,
      issued_at: issuedAt,
      hmac_signature: hmacSignature,
    }

    return new Response(
      JSON.stringify({ success: true, card: cardPayload }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (e) {
    console.error('setup-nfc-card error', e)
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})