# Fix "Could not load payment history" in the Service Centre tenant list

## What is wrong

The payment history panel under each tenant in the Service Centre fails for every tenant, not just Muyanja Mark. The database function that builds the history combines two sources of payments — recorded repayments and agent field collections — and the "payment method" column on field collections is a fixed-choice type while the repayment side sends plain text. Postgres refuses to merge the two, so the whole query aborts with a type error before any rows are returned.

Confirmed by running the same combined query directly against the database: it fails with `UNION types text and collection_payment_method cannot be matched`.

A second, smaller problem: when the panel catches a database error it prints `[object Object]` instead of the real message, which is why the cause has been invisible until now.

## The fix

1. Update the payment-history database function so the collection payment method is converted to plain text before the two payment sources are merged. Authorisation logic, paging, totals and ordering stay exactly as they are.
2. Update the panel's error display so it shows the real database message (message plus details/hint when present) rather than `[object Object]`.

## Technical detail

- Migration: `CREATE OR REPLACE FUNCTION public.get_service_center_tenant_payments(uuid, int, int)` — change `c.payment_method AS method` to `c.payment_method::text AS method` inside the `pays` CTE. No signature, grant, or security change; existing `REVOKE`/`GRANT EXECUTE` to `authenticated` and `service_role` remain.
- `src/components/agent/service-center/ServiceCenterTenantPayments.tsx` — replace the `error instanceof Error ? error.message : String(error)` fallback with a small formatter that reads `message`, `details`, `hint`, `code` off Postgrest-style error objects.

## Verification

After the migration, call the function for the Muyanja Mark rent plan and confirm it returns a JSON payload with totals and items, then reload the Service Centre tenant list and confirm the history renders (empty state if no payments recorded yet).
