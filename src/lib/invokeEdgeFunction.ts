import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { extractEdgeFunctionError } from "./extractEdgeFunctionError";

type InvokeOptions = Parameters<typeof supabase.functions.invoke>[1];

export interface InvokeEdgeOptions extends InvokeOptions {
  /** Toast title on failure. Defaults to "Action failed". */
  errorTitle?: string;
  /** Fallback message if the backend didn't return one. */
  fallbackMessage?: string;
  /** Disable automatic toast (caller will handle UI). */
  silent?: boolean;
}

export interface InvokeEdgeResult<T = any> {
  data: T | null;
  error: Error | null;
}

/**
 * Wrapper around `supabase.functions.invoke` that GUARANTEES backend errors
 * surface to the user. Any non-2xx response, or a 2xx with `{ error: "..." }`
 * in the body, is converted into:
 *   1. A `sonner` toast with the structured backend message (unless `silent`)
 *   2. An `Error` returned in the result so callers can branch on it
 *
 * Use this everywhere instead of calling `supabase.functions.invoke` directly
 * for mutations (deposits, withdrawals, approvals, etc.) so we never have
 * silent failures again.
 */
export async function invokeEdgeFunction<T = any>(
  functionName: string,
  options: InvokeEdgeOptions = {},
): Promise<InvokeEdgeResult<T>> {
  const { errorTitle, fallbackMessage, silent, ...invokeOpts } = options;

  try {
    const response = await supabase.functions.invoke(functionName, invokeOpts);

    if (response.error || (response.data as any)?.error) {
      const message = await extractEdgeFunctionError(
        { error: response.error, data: response.data },
        fallbackMessage ?? "Something went wrong. Please try again.",
      );

      console.error(`[edge:${functionName}] failed:`, message, response.error ?? response.data);

      if (!silent) {
        toast.error(errorTitle ?? "Action failed", { description: message });
      }

      return { data: null, error: new Error(message) };
    }

    return { data: response.data as T, error: null };
  } catch (err: any) {
    // Network failure / thrown exception
    const message = err?.message || fallbackMessage || "Network error. Please try again.";
    console.error(`[edge:${functionName}] threw:`, err);

    if (!silent) {
      toast.error(errorTitle ?? "Action failed", { description: message });
    }

    return { data: null, error: err instanceof Error ? err : new Error(message) };
  }
}