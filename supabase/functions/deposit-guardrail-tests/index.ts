// Test-only function directory. The handler is intentionally a no-op so the
// guardrail Deno tests in this folder can be discovered and run by the
// Supabase test runner without exposing a callable endpoint.
Deno.serve(() => new Response("test-only", { status: 200 }));
