import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function verifyVendorSessionToken(
  token: unknown,
  expectedVendorId: string,
  secret: string,
): Promise<boolean> {
  if (typeof token !== 'string') return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const validSignature = await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64Url(signature) as unknown as BufferSource,
      new TextEncoder().encode(payload),
    );
    if (!validSignature) return false;

    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload) as unknown as Uint8Array<ArrayBuffer>)) as {
      vendorId?: unknown;
      exp?: unknown;
    };
    return claims.vendorId === expectedVendorId
      && typeof claims.exp === 'number'
      && claims.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const body = await req.json();
    const { vendorId, vendorToken, receiptId, amount } = body;
    if (typeof vendorId !== 'string' || typeof receiptId !== 'string' || typeof amount !== 'number') {
      return new Response(
        JSON.stringify({ success: false, message: 'Vendor ID, receipt ID, and amount are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Platform managers may act on a vendor's behalf. Vendor portal users
    // authenticate with the short-lived signed token issued by vendor-login.
    const authHeader = req.headers.get('Authorization');
    if (amount <= 0) {
      return new Response(
        JSON.stringify({ success: false, message: 'Amount must be positive' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    let authenticatedUserId: string | null = null;
    let isManager = false;
    if (authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const { data: { user } } = await supabase.auth.getUser(token);
      authenticatedUserId = user?.id ?? null;
      if (authenticatedUserId) {
        const { data: managerRole } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', authenticatedUserId)
          .eq('role', 'manager')
          .maybeSingle();
        isManager = Boolean(managerRole);
      }
    }

    const hasVendorSession = await verifyVendorSessionToken(vendorToken, vendorId, supabaseServiceKey);
    if (!isManager && !hasVendorSession) {
      return new Response(
        JSON.stringify({ success: false, message: 'Vendor session is invalid or expired. Please sign in again.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify the receipt belongs to this vendor and is available
    const { data: receipt, error: fetchError } = await supabase
      .from('receipt_numbers')
      .select('*')
      .eq('id', receiptId)
      .eq('vendor_id', vendorId)
      .maybeSingle();

    if (fetchError) {
      console.error('Fetch error:', fetchError);
      return new Response(
        JSON.stringify({ success: false, message: 'Database error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!receipt) {
      return new Response(
        JSON.stringify({ success: false, message: 'Receipt not found or does not belong to this vendor' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (receipt.status !== 'available') {
      return new Response(
        JSON.stringify({ success: false, message: `Receipt already ${receipt.status}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Mark the receipt
    const { error: updateError } = await supabase
      .from('receipt_numbers')
      .update({
        vendor_amount: amount,
        status: 'marked',
        vendor_marked_at: new Date().toISOString()
      })
      .eq('id', receiptId);

    if (updateError) {
      console.error('Update error:', updateError);
      return new Response(
        JSON.stringify({ success: false, message: 'Failed to mark receipt' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Audit log
    try {
      await supabase.from('audit_logs').insert({
        action_type: 'vendor_mark_receipt',
        table_name: 'receipt_numbers',
        record_id: receiptId,
        performed_by: authenticatedUserId,
        metadata: { vendorId, amount, receipt_code: receipt.receipt_code }
      });
    } catch {}

    console.log(`Receipt ${receipt.receipt_code} marked with amount ${amount} by vendor ${vendorId}`);

    return new Response(
      JSON.stringify({ success: true, message: 'Receipt marked successfully' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ success: false, message: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
