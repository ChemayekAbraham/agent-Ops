import { createClient } from "npm:@supabase/supabase-js@2";
import * as bcrypt from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Rate limiting configuration
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// In-memory rate limiting store (resets on function restart, but provides basic protection)
const loginAttempts = new Map<string, { attempts: number; lastAttempt: number; lockedUntil?: number }>();

function checkRateLimit(phone: string): { allowed: boolean; remainingAttempts?: number; lockedUntil?: number } {
  const now = Date.now();
  const record = loginAttempts.get(phone);
  
  if (!record) {
    return { allowed: true, remainingAttempts: MAX_ATTEMPTS };
  }
  
  // Check if locked
  if (record.lockedUntil && now < record.lockedUntil) {
    return { allowed: false, lockedUntil: record.lockedUntil };
  }
  
  // Reset if lockout expired
  if (record.lockedUntil && now >= record.lockedUntil) {
    loginAttempts.delete(phone);
    return { allowed: true, remainingAttempts: MAX_ATTEMPTS };
  }
  
  // Reset attempts if last attempt was more than 15 minutes ago
  if (now - record.lastAttempt > LOCKOUT_DURATION_MS) {
    loginAttempts.delete(phone);
    return { allowed: true, remainingAttempts: MAX_ATTEMPTS };
  }
  
  return { allowed: true, remainingAttempts: MAX_ATTEMPTS - record.attempts };
}

function recordFailedAttempt(phone: string): void {
  const now = Date.now();
  const record = loginAttempts.get(phone) || { attempts: 0, lastAttempt: now };
  
  record.attempts++;
  record.lastAttempt = now;
  
  if (record.attempts >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_DURATION_MS;
  }
  
  loginAttempts.set(phone, record);
}

function clearAttempts(phone: string): void {
  loginAttempts.delete(phone);
}

// Input validation
function validatePhone(phone: unknown): string | null {
  if (typeof phone !== 'string') return null;
  const cleaned = phone.trim();
  // Uganda phone format: 07XXXXXXXX or 256XXXXXXXX
  if (!/^(0[7][0-9]{8}|256[7][0-9]{8})$/.test(cleaned)) return null;
  return cleaned;
}

function validatePin(pin: unknown): string | null {
  if (typeof pin !== 'string') return null;
  const cleaned = pin.trim();
  // PIN should be 4-6 digits
  if (!/^[0-9]{4,6}$/.test(cleaned)) return null;
  return cleaned;
}

function toBase64Url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function createVendorSessionToken(vendorId: string, secret: string): Promise<string> {
  const payload = toBase64Url(JSON.stringify({
    vendorId,
    exp: Math.floor(Date.now() / 1000) + (8 * 60 * 60),
    nonce: crypto.randomUUID(),
  }));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ success: false, message: 'Invalid request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { phone: rawPhone, pin: rawPin } = body as Record<string, unknown>;

    // Validate inputs
    const phone = validatePhone(rawPhone);
    const pin = validatePin(rawPin);

    if (!phone || !pin) {
      // Generic error - don't reveal which field is invalid
      return new Response(
        JSON.stringify({ success: false, message: 'Invalid credentials' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check rate limiting
    const rateCheck = checkRateLimit(phone);
    if (!rateCheck.allowed) {
      const remainingSeconds = Math.ceil((rateCheck.lockedUntil! - Date.now()) / 1000);
      console.log(`[vendor-login] Rate limited: ${phone}, locked for ${remainingSeconds}s`);
      return new Response(
        JSON.stringify({ 
          success: false, 
          message: `Too many failed attempts. Try again in ${Math.ceil(remainingSeconds / 60)} minutes.` 
        }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Find vendor by phone
    const { data: vendor, error } = await supabase
      .from('vendors')
      .select('id, name, phone, location, pin, pin_hash')
      .eq('phone', phone)
      .eq('active', true)
      .maybeSingle();

    if (error) {
      console.error('[vendor-login] Database error:', error);
      return new Response(
        JSON.stringify({ success: false, message: 'Service temporarily unavailable' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Generic error for vendor not found (don't reveal if account exists)
    if (!vendor) {
      recordFailedAttempt(phone);
      console.log(`[vendor-login] Failed attempt for unknown phone: ${phone}`);
      return new Response(
        JSON.stringify({ success: false, message: 'Invalid credentials' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if PIN is set
    if (!vendor.pin_hash && !vendor.pin) {
      return new Response(
        JSON.stringify({ success: false, message: 'Account not fully set up. Contact manager.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify PIN - prefer hashed PIN, fallback to legacy plaintext for migration
    let pinValid = false;
    
    if (vendor.pin_hash) {
      // Use bcrypt for hashed PINs
      try {
        pinValid = await bcrypt.compare(pin, vendor.pin_hash);
      } catch (e) {
        console.error('[vendor-login] bcrypt compare error:', e);
        pinValid = false;
      }
    } else if (vendor.pin) {
      // Legacy plaintext comparison - this should be migrated
      pinValid = vendor.pin === pin;
      
      // Auto-migrate to hashed PIN on successful login
      if (pinValid) {
        try {
          const hashedPin = await bcrypt.hash(pin);
          await supabase
            .from('vendors')
            .update({ pin_hash: hashedPin, pin: null })
            .eq('id', vendor.id);
          console.log(`[vendor-login] Migrated vendor ${vendor.id} to hashed PIN`);
        } catch (e) {
          console.error('[vendor-login] Failed to migrate PIN:', e);
        }
      }
    }

    if (!pinValid) {
      recordFailedAttempt(phone);
      const remaining = rateCheck.remainingAttempts! - 1;
      console.log(`[vendor-login] Invalid PIN for vendor: ${vendor.id}, remaining attempts: ${remaining}`);
      
      // Log failed attempt to audit (fire and forget)
      (async () => {
        try {
          await supabase.from('audit_logs').insert({
            action_type: 'vendor_login_failed',
            table_name: 'vendors',
            record_id: vendor.id,
            performed_by: vendor.id,
            reason: 'Invalid PIN',
            metadata: { phone, attempts_remaining: remaining }
          });
        } catch {}
      })();
      
      return new Response(
        JSON.stringify({ success: false, message: 'Invalid credentials' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Success - clear rate limiting
    clearAttempts(phone);

    // Return vendor info (without sensitive data)
    const vendorInfo = {
      id: vendor.id,
      name: vendor.name,
      phone: vendor.phone,
      location: vendor.location
    };
    const vendorToken = await createVendorSessionToken(vendor.id, supabaseServiceKey);

    console.log(`[vendor-login] Vendor ${vendor.name} logged in successfully`);

    // Log successful login (fire and forget)
    (async () => {
      try {
        await supabase.from('audit_logs').insert({
          action_type: 'vendor_login_success',
          table_name: 'vendors',
          record_id: vendor.id,
          performed_by: vendor.id,
          metadata: { phone }
        });
      } catch {}
    })();

    return new Response(
      JSON.stringify({ success: true, vendor: vendorInfo, vendorToken }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[vendor-login] Unexpected error:', error);
    return new Response(
      JSON.stringify({ success: false, message: 'Service temporarily unavailable' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
