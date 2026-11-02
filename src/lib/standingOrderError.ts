/** Presentation only: keep the recorded run status and payment state unchanged. */
export function standingOrderErrorText(error: string | null): string | null {
  if (!error) return error;
  if (/SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED/i.test(error)) {
    return 'The last payment attempt encountered a temporary service outage.';
  }
  try {
    const parsed: unknown = JSON.parse(error);
    if (parsed && typeof parsed === 'object' && 'message' in parsed && typeof parsed.message === 'string') {
      return parsed.message;
    }
  } catch {
    // Plain text and truncated responses remain available for diagnosis.
  }
  return error;
}