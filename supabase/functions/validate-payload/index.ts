import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ═══════════════════════════════════════════
// Server-Side Contract Definitions (mirror client)
// ═══════════════════════════════════════════

type FieldType = "integer" | "uuid" | "text" | "boolean" | "date" | "numeric" | "timestamp";

interface FieldContract {
  type: FieldType;
  required: boolean;
  derived?: boolean;
  allowedValues?: (number | string | boolean)[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  label?: string;
}

type FormContract = Record<string, FieldContract>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ═══════════════════════════════════════════
// Contracts (subset of client contracts)
// ═══════════════════════════════════════════

const CONTRACTS: Record<string, FormContract> = {
  rent_requests: {
    tenant_id: { type: "uuid", required: true, label: "Tenant ID" },
    landlord_id: { type: "uuid", required: true, label: "Landlord ID" },
    lc1_id: { type: "uuid", required: true, label: "LC1 ID" },
    rent_amount: { type: "numeric", required: true, label: "Rent Amount", min: 10000, max: 10000000 },
    duration_days: { type: "integer", required: true, label: "Duration", allowedValues: [7, 14, 30, 60, 90, 120] },
    access_fee: { type: "numeric", required: true, label: "Access Fee", min: 0, derived: true },
    request_fee: { type: "numeric", required: true, label: "Request Fee", min: 0, derived: true },
    total_repayment: { type: "numeric", required: true, label: "Total Repayment", min: 0, derived: true },
    daily_repayment: { type: "numeric", required: true, label: "Daily Repayment", min: 0, derived: true },
  },
  deposit_requests: {
    user_id: { type: "uuid", required: true, label: "User ID" },
    amount: { type: "numeric", required: true, label: "Amount", min: 1000, max: 50000000 },
    provider: { type: "text", required: false, label: "Provider", allowedValues: ["mtn", "airtel"] },
    transaction_id: { type: "text", required: false, label: "Transaction ID", maxLength: 100 },
  },
  general_ledger: {
    amount: { type: "numeric", required: true, label: "Amount", min: 1 },
    direction: { type: "text", required: true, label: "Direction", allowedValues: ["cash_in", "cash_out"] },
    category: {
      type: "text", required: true, label: "Category",
      allowedValues: [
        "tenant_access_fee", "tenant_request_fee", "rent_repayment",
        "supporter_facilitation_capital", "agent_remittance", "platform_service_income",
        "rent_facilitation_payout", "supporter_platform_rewards",
        "agent_commission_payout", "transaction_platform_expenses", "operational_expenses",
      ],
    },
    linked_party: { type: "text", required: false, label: "Linked Party", allowedValues: ["tenant", "agent", "supporter", "platform"] },
    source_table: { type: "text", required: true, label: "Source Table" },
  },
  user_loans: {
    borrower_id: { type: "uuid", required: true, label: "Borrower ID" },
    lender_id: { type: "uuid", required: true, label: "Lender ID" },
    amount: { type: "numeric", required: true, label: "Loan Amount", min: 1000, max: 10000000 },
    interest_rate: { type: "numeric", required: true, label: "Interest Rate", min: 0, max: 100 },
    total_repayment: { type: "numeric", required: true, label: "Total Repayment", min: 0, derived: true },
    due_date: { type: "text", required: true, label: "Due Date" },
  },
  wallet_transactions: {
    sender_id: { type: "uuid", required: true, label: "Sender ID" },
    recipient_id: { type: "uuid", required: true, label: "Recipient ID" },
    amount: { type: "numeric", required: true, label: "Amount", min: 100, max: 50000000 },
  },
};

// ═══════════════════════════════════════════
// Validator (same logic as client)
// ═══════════════════════════════════════════

interface ValidationError {
  field: string;
  message: string;
}

function validate(contract: FormContract, payload: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const [field, c] of Object.entries(contract)) {
    if (c.derived) continue;
    const value = payload[field];
    const label = c.label || field;

    // Required
    if (c.required && (value === undefined || value === null || value === "")) {
      errors.push({ field, message: `${label} is required` });
      continue;
    }
    if (value === undefined || value === null || value === "") continue;

    // Type checks — NO COERCION
    switch (c.type) {
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value))
          errors.push({ field, message: `${label} must be a whole number, got ${typeof value}: ${value}` });
        break;
      case "numeric":
        if (typeof value !== "number" || isNaN(value))
          errors.push({ field, message: `${label} must be a number, got ${typeof value}: ${value}` });
        break;
      case "text":
        if (typeof value !== "string")
          errors.push({ field, message: `${label} must be text` });
        break;
      case "boolean":
        if (typeof value !== "boolean")
          errors.push({ field, message: `${label} must be boolean` });
        break;
      case "uuid":
        if (typeof value !== "string" || !UUID_RE.test(value))
          errors.push({ field, message: `${label} must be a valid UUID` });
        break;
    }

    // Allowed values
    if (c.allowedValues && !c.allowedValues.includes(value as string | number | boolean)) {
      errors.push({ field, message: `${label} must be one of: ${c.allowedValues.join(", ")}` });
    }

    // Numeric range
    if ((c.type === "integer" || c.type === "numeric") && typeof value === "number") {
      if (c.min !== undefined && value < c.min)
        errors.push({ field, message: `${label} must be >= ${c.min}` });
      if (c.max !== undefined && value > c.max)
        errors.push({ field, message: `${label} must be <= ${c.max}` });
    }

    // String length
    if (c.type === "text" && typeof value === "string") {
      if (c.minLength !== undefined && value.length < c.minLength)
        errors.push({ field, message: `${label} must be >= ${c.minLength} chars` });
      if (c.maxLength !== undefined && value.length > c.maxLength)
        errors.push({ field, message: `${label} must be <= ${c.maxLength} chars` });
    }

    // Formatted string detection
    if ((c.type === "integer" || c.type === "numeric") && typeof value === "string") {
      errors.push({ field, message: `${label} contains a string where a number is expected: "${value}"` });
    }
  }

  return errors;
}

// ═══════════════════════════════════════════
// Edge Function Handler
// ═══════════════════════════════════════════

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse body
    const body = await req.json();
    const { table, payload } = body;

    if (!table || !payload) {
      return new Response(
        JSON.stringify({ error: "Missing 'table' or 'payload' in request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Find contract
    const contract = CONTRACTS[table];
    if (!contract) {
      return new Response(
        JSON.stringify({ error: `No contract defined for table '${table}'` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate
    const errors = validate(contract, payload);
    if (errors.length > 0) {
      return new Response(
        JSON.stringify({
          valid: false,
          errors,
          message: `Validation failed: ${errors.map(e => e.message).join("; ")}`,
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ valid: true, message: "Payload passes contract validation" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
