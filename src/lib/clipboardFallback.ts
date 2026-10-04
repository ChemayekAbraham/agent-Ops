/**
 * Make navigator.clipboard.writeText survive the browsers that refuse it.
 *
 * Older Android WebViews / Chrome builds reject writeText with
 * "Write permission denied." (or "Document is not focused.") even from a tap.
 * 164 call sites across the app fire it without a catch, and most then toast
 * "Copied!" regardless — so the agent pastes nothing, typically a MoMo merchant
 * code in the deposit flow, and client_error_reports logs an unhandled
 * rejection (doc 160).
 *
 * Patched once, here, instead of at every caller: when the async API rejects,
 * retry with the legacy hidden-textarea + execCommand('copy') path, and only
 * reject if that fails too. Browsers without the async API get the legacy path
 * as the whole implementation.
 */

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  const active = document.activeElement as HTMLElement | null;
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
    active?.focus?.();
  }
}

export function installClipboardFallback(): void {
  if (typeof navigator === 'undefined') return;
  const nav = navigator as Navigator & { clipboard?: Clipboard };
  const original = nav.clipboard?.writeText?.bind(nav.clipboard);

  const writeText = (text: string): Promise<void> => {
    const viaLegacy = () =>
      legacyCopy(String(text ?? ''))
        ? Promise.resolve()
        : Promise.reject(new DOMException('Copy is not available on this device.', 'NotAllowedError'));
    if (!original) return viaLegacy();
    return original(text).catch(err => {
      console.warn('[clipboard] writeText rejected, using legacy copy:', err);
      return viaLegacy();
    });
  };

  try {
    if (nav.clipboard) {
      Object.defineProperty(nav.clipboard, 'writeText', { value: writeText, configurable: true, writable: true });
    } else {
      Object.defineProperty(nav, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
    }
  } catch {
    /* non-configurable on some engines: leave the native API untouched */
  }
}
