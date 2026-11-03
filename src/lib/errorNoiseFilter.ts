/**
 * Errors that come from browser wallet extensions / injected scripts, not from
 * our app. Every client error reporting path checks this before reporting.
 */
export const IGNORABLE_MESSAGE_PATTERNS: RegExp[] = [
  /window\.ethereum/i,
  /ethereum\.selectedAddress/i,
  /Cannot read properties of undefined \(reading 'M_ID'\)/i,
  /Window message "chrome: call method" timed out/i,
];

export const EXTENSION_SOURCE_PATTERNS: RegExp[] = [
  /chrome-extension:\/\//i,
  /moz-extension:\/\//i,
  /safari-extension:\/\//i,
  /safari-web-extension:\/\//i,
  /webkit-masked-url:\/\//i,
];

export function isIgnorableClientError(
  messageOrError: unknown,
  stack?: string | null,
  filename?: string | null,
): boolean {
  const err = messageOrError as { message?: unknown; stack?: unknown } | null;
  const message =
    typeof messageOrError === 'string'
      ? messageOrError
      : typeof err?.message === 'string'
        ? err.message
        : '';
  const fullStack = stack ?? (typeof err?.stack === 'string' ? err.stack : '') ?? '';
  const file = filename ?? '';

  if (IGNORABLE_MESSAGE_PATTERNS.some((re) => re.test(message))) return true;
  if (EXTENSION_SOURCE_PATTERNS.some((re) => re.test(fullStack) || re.test(file))) return true;
  // Bare cross-origin "Script error." with nothing to trace.
  if (/^\s*Script error\.?\s*$/i.test(message) && !fullStack && !file) return true;
  return false;
}
