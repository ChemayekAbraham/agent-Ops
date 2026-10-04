import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing authorization header');
    }

    const supabaseClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const body = await req.json().catch(() => ({}));
    const { productId, quantity: rawQuantity = 1 } = body as { productId?: string; quantity?: number };

    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!productId || typeof productId !== 'string' || !UUID_REGEX.test(productId)) {
      throw new Error('Valid Product ID is required');
    }

    const quantity = Number(rawQuantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
      throw new Error('Quantity must be an integer between 1 and 1000');
    }

    console.log(`[product-purchase] user ${user.id}, product ${productId}, qty ${quantity}`);

    // ── Fetch product ──
    const { data: product, error: productError } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('id', productId)
      .eq('active', true)
      .single();

    if (productError || !product) {
      throw new Error('Product not found or not available');
    }

    if (product.stock < quantity) {
      throw new Error('Insufficient stock');
    }

    // ── Price calculation ──
    let effectivePrice = product.price;
    if (product.discount_percentage && product.discount_percentage > 0) {
      const discountActive = !product.discount_ends_at || new Date(product.discount_ends_at) > new Date();
      if (discountActive) {
        effectivePrice = Math.round(product.price * (1 - product.discount_percentage / 100));
      }
    }

    const totalPrice = effectivePrice * quantity;
    const agentCommission = Math.round(totalPrice * 0.01); // 1% platform fee

    console.log(`[product-purchase] effectivePrice=${effectivePrice}, total=${totalPrice}, commission=${agentCommission}`);

    // ── Balance check (ledger-derived via sync trigger) ──
    const { data: buyerWallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', user.id)
      .single();

    if (!buyerWallet) {
      throw new Error('Buyer wallet not found');
    }
    if (buyerWallet.balance < totalPrice) {
      throw new Error('Insufficient wallet balance');
    }

    // ── Check if agent is verified (for cashback) ──
    const { data: agentRoleData } = await supabaseAdmin
      .from('user_roles')
      .select('id')
      .eq('user_id', product.agent_id)
      .eq('role', 'agent')
      .maybeSingle();

    const cashbackAmount = agentRoleData ? Math.round(totalPrice * 0.04) : 0;

    // ── Build ledger entries (single atomic transaction) ──
    const now = new Date().toISOString();

    const entries: Array<{
      user_id: string;
      ledger_scope: string;
      direction: string;
      category: string;
      amount: number;
      currency: string;
      description: string;
      source_table: string;
      source_id: string;
      transaction_date: string;
    }> = [
      // Leg 1: Buyer pays (wallet debit)
      {
        user_id: user.id,
        ledger_scope: 'wallet',
        direction: 'cash_out',
        category: 'wallet_deduction',
        amount: totalPrice,
        currency: 'UGX',
        description: `Purchase ${quantity}x ${product.name}`,
        source_table: 'product_orders',
        source_id: productId,
        transaction_date: now,
      },
      // Leg 2: Agent receives full sale amount (wallet credit)
      {
        user_id: product.agent_id,
        ledger_scope: 'wallet',
        direction: 'cash_in',
        category: 'agent_commission_earned',
        amount: totalPrice,
        currency: 'UGX',
        description: `Sale of ${quantity}x ${product.name}`,
        source_table: 'product_orders',
        source_id: productId,
        transaction_date: now,
      },
      // Leg 3: Platform records 1% revenue
      {
        user_id: product.agent_id,
        ledger_scope: 'platform',
        direction: 'cash_in',
        category: 'access_fee_collected',
        amount: agentCommission,
        currency: 'UGX',
        description: `1% marketplace fee on ${product.name}`,
        source_table: 'product_orders',
        source_id: productId,
        transaction_date: now,
      },
      // Leg 4: Platform balancing entry (net-zero offset)
      {
        user_id: product.agent_id,
        ledger_scope: 'platform',
        direction: 'cash_out',
        category: 'access_fee_collected',
        amount: agentCommission,
        currency: 'UGX',
        description: `1% marketplace fee offset for ${product.name}`,
        source_table: 'product_orders',
        source_id: productId,
        transaction_date: now,
      },
    ];

    // Legs 5-6: Cashback if verified agent
    if (cashbackAmount > 0) {
      entries.push(
        {
          user_id: user.id,
          ledger_scope: 'wallet',
          direction: 'cash_in',
          category: 'wallet_transfer',
          amount: cashbackAmount,
          currency: 'UGX',
          description: `4% cashback on ${product.name} purchase`,
          source_table: 'product_orders',
          source_id: productId,
          transaction_date: now,
        },
        {
          user_id: user.id,
          ledger_scope: 'platform',
          direction: 'cash_out',
          category: 'wallet_transfer',
          amount: cashbackAmount,
          currency: 'UGX',
          description: `4% cashback expense for ${product.name}`,
          source_table: 'product_orders',
          source_id: productId,
          transaction_date: now,
        },
      );
    }

    // ── Execute atomic ledger transaction ──
    const { data: ledgerResult, error: ledgerError } = await supabaseAdmin.rpc(
      'create_ledger_transaction',
      {
        entries: entries,
      }
    );

    if (ledgerError) {
      console.error('[product-purchase] Ledger RPC error:', ledgerError);
      throw new Error(ledgerError.message || 'Financial transaction failed');
    }

    console.log(`[product-purchase] Ledger OK`);

    // ── Update stock ──
    const { error: stockError } = await supabaseAdmin
      .from('products')
      .update({ stock: product.stock - quantity })
      .eq('id', productId);

    if (stockError) {
      console.error('[product-purchase] Stock update error:', stockError);
    }

    // ── Create order record ──
    const { data: order, error: orderError } = await supabaseAdmin
      .from('product_orders')
      .insert({
        product_id: productId,
        buyer_id: user.id,
        agent_id: product.agent_id,
        quantity,
        unit_price: effectivePrice,
        total_price: totalPrice,
        agent_commission: agentCommission,
        status: 'completed'
      })
      .select()
      .single();

    if (orderError) {
      console.error('[product-purchase] Order record error:', orderError);
    }

    // ── Record agent earning (1% commission) ──
    await supabaseAdmin
      .from('agent_earnings')
      .insert({
        agent_id: product.agent_id,
        amount: agentCommission,
        earning_type: 'marketplace_commission',
        description: `1% commission on ${product.name} sale (Qty: ${quantity})`,
        source_user_id: user.id
      });

    // ── Record cashback earning if applicable ──
    if (cashbackAmount > 0) {
      await supabaseAdmin
        .from('agent_earnings')
        .insert({
          agent_id: user.id,
          amount: cashbackAmount,
          earning_type: 'cashback',
          description: `4% cashback on ${product.name} purchase (UGX ${totalPrice.toLocaleString()})`,
          source_user_id: product.agent_id
        });

      console.log(`[product-purchase] Cashback ${cashbackAmount} to buyer ${user.id}`);
    }

    // ── Notifications (fire-and-forget, suppressed by DB trigger) ──
    const cashbackMsg = cashbackAmount > 0
      ? ` You earned UGX ${cashbackAmount.toLocaleString()} cashback!`
      : '';

    await supabaseAdmin.from('notifications').insert({
      user_id: user.id,
      title: cashbackAmount > 0 ? '🎉 Purchase + Cashback!' : 'Purchase Successful',
      message: `You purchased ${quantity}x ${product.name} for UGX ${totalPrice.toLocaleString()}.${cashbackMsg}`,
      type: 'success',
      metadata: { order_id: order?.id, product_id: productId, cashback: cashbackAmount }
    });

    await supabaseAdmin.from('notifications').insert({
      user_id: product.agent_id,
      title: 'New Sale!',
      message: `You sold ${quantity}x ${product.name} and earned UGX ${agentCommission.toLocaleString()} commission`,
      type: 'success',
      metadata: { order_id: order?.id, product_id: productId }
    });

    console.log('[product-purchase] Complete');

    return new Response(
      JSON.stringify({ success: true, order, message: 'Purchase completed successfully' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[product-purchase] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An error occurred';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    );
  }
});
