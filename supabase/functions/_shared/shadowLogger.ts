/**
 * Shadow Logger — Phase 5 (upgraded from Phase 3)
 * 
 * Wraps shadow validation in a fire-and-forget promise.
 * Logs match/divergence to console with [SHADOW] prefix.
 * Persists results to shadow_audit_logs table when adminClient provided.
 * Respects sampling config — caller checks shouldSample() before calling.
 * All errors are swallowed — shadow failures NEVER affect primary path.
 */

import type { ShadowValidationResult } from "./shadowValidation.ts";

export function runShadowAudit(
  functionName: string,
  inputs: Record<string, unknown>,
  primaryPassed: boolean,
  shadowFn: () => ShadowValidationResult,
  adminClient?: { from: (table: string) => any },
): void {
  // Fire-and-forget — intentionally not awaited
  Promise.resolve().then(async () => {
    try {
      const shadowResult = shadowFn();
      const shadowPassed = shadowResult.valid;

      if (shadowPassed === primaryPassed) {
        console.log(
          `[SHADOW] ${functionName} | MATCH | primary=${primaryPassed} shadow=${shadowPassed}`
        );
      } else {
        console.warn(
          `[SHADOW] ${functionName} | DIVERGENCE | primary=${primaryPassed} shadow=${shadowPassed} | errors=${JSON.stringify(shadowResult.errors)}`
        );
      }

      // Persist to shadow_audit_logs if admin client available
      if (adminClient) {
        try {
          await adminClient.from("shadow_audit_logs").insert({
            function_name: functionName,
            primary_passed: primaryPassed,
            shadow_passed: shadowPassed,
            shadow_errors: shadowResult.errors || [],
          });
        } catch {
          // Swallow persistence errors
        }
      }
    } catch (err) {
      console.error(
        `[SHADOW] ${functionName} | ERROR | ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }).catch(() => {
    // Double safety net — swallow everything
  });
}
