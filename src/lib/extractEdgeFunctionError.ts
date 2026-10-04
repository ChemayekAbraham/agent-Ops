/**
 * Extract a human-readable error message from a Supabase edge function response.
 *
 * When `supabase.functions.invoke()` receives a non-2xx status the SDK wraps
 * the response in a `FunctionsHttpError` whose `.context` carries the raw
 * Response object.  The actual JSON body (with our `{ error: "..." }` shape)
 * must be read from that context.
 */
export async function extractEdgeFunctionError(
  response: { error: any; data: any },
  fallback = 'Something went wrong. Please try again.',
): Promise<string> {
  // 1. SDK-level error (non-2xx)
  if (response.error) {
    return extractFromErrorObject(response.error, fallback);
  }

  // 2. 2xx but the body itself contains an error field
  if (response.data?.error) {
    return response.data.error;
  }

  return fallback;
}

/**
 * Extract a human-readable error from a raw FunctionsHttpError object.
 * Use this when code does `if (error) throw error` — catch the thrown error
 * and pass it here to get the actual backend message.
 */
export async function extractFromErrorObject(
  error: any,
  fallback = 'Something went wrong. Please try again.',
): Promise<string> {
  if (!error) return fallback;

  try {
    // FunctionsHttpError stores the Response in `.context`
    const ctx = error?.context;

    // ctx is a Response – read JSON body
    if (ctx && typeof ctx.json === 'function') {
      const body = await ctx.json();
      if (body?.error) return body.error;
    }

    // Some SDK versions expose `.context.body` as a string
    if (ctx?.body) {
      const body = typeof ctx.body === 'string' ? JSON.parse(ctx.body) : ctx.body;
      if (body?.error) return body.error;
    }
  } catch {
    // parsing failed – fall through
  }

  // Last resort: use the error message itself
  if (error.message && error.message !== 'Edge Function returned a non-2xx status code') {
    return error.message;
  }

  return fallback;
}

/**
 * Structured details extracted from an edge function failure.
 * Used by the structured client logger so support can correlate a UI
 * failure with the exact backend invocation (request_id) and category
 * of failure (status / error_code).
 */
export interface EdgeFunctionErrorDetails {
  message: string;
  status?: number;
  requestId?: string;
  errorCode?: string;
}

export async function extractEdgeFunctionErrorDetails(
  response: { error: any; data: any },
  fallback = 'Something went wrong. Please try again.',
): Promise<EdgeFunctionErrorDetails> {
  const details: EdgeFunctionErrorDetails = { message: fallback };
  const err = response?.error;
  const ctx = err?.context;
  try {
    if (ctx && typeof ctx.status === 'number') details.status = ctx.status;
    const headers: Headers | undefined = ctx?.headers;
    const rid = headers?.get?.('x-request-id') || headers?.get?.('x-supabase-request-id');
    if (rid) details.requestId = rid;

    let body: any = null;
    if (ctx && typeof ctx.json === 'function') {
      body = await ctx.clone?.().json().catch(() => null) ?? await ctx.json().catch(() => null);
    } else if (ctx?.body) {
      body = typeof ctx.body === 'string' ? JSON.parse(ctx.body) : ctx.body;
    } else if (response.data?.error) {
      body = response.data;
    }
    if (body?.error) details.message = typeof body.error === 'string' ? body.error : details.message;
    if (body?.code) details.errorCode = String(body.code);
    if (body?.error_code) details.errorCode = String(body.error_code);
  } catch {
    // best-effort — message falls back to extractEdgeFunctionError
  }

  if (details.message === fallback) {
    details.message = await extractEdgeFunctionError(response, fallback);
  }
  return details;
}
