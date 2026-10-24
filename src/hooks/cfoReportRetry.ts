/** Read-only CFO reports: deterministic failures cannot improve on replay. */
export function cfoReportRetry(failureCount: number, error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return code !== '57014' && code !== '42501' && failureCount < 2;
}