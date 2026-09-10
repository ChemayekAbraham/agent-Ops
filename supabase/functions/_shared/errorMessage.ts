// Extracts a readable message from any thrown value.
//
// `error instanceof Error` is false for a Supabase PostgrestError — the
// supabase-js client's `.rpc()`/`.from()` calls return `{ data, error }`
// where `error` is a plain object (message/code/details/hint), not a real
// Error subclass. A sender that does `if (rpcError) throw rpcError;` and then
// checks `error instanceof Error ? error.message : "Unknown error"` silently
// discards the actual database error and reports "Unknown error" instead —
// exactly the failure this project has spent this whole engagement trying to
// make senders fail loudly and specifically about, not quietly.
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === "string" && msg) return msg;
  }
  if (typeof error === "string" && error) return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}
