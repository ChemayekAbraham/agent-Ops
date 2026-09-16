import { supabase } from '@/integrations/supabase/client';
import {
  isIOSInAppBrowser,
  isChromeIOS,
  isFirefoxIOS,
} from '@/hooks/useIOSCompatibility';
import { detectStandalone } from '@/lib/pwaStandalone';

export type InstallEventType =
  | 'install_card_shown'
  | 'install_card_dismissed'
  | 'install_cta_clicked'
  | 'ios_guide_opened'
  | 'ios_guide_closed'
  | 'in_app_browser_detected'
  | 'copy_link_clicked'
  | 'copy_link_success'
  | 'copy_link_failed'
  | 'native_prompt_shown'
  | 'native_prompt_accepted'
  | 'native_prompt_dismissed'
  | 'app_installed'
  | 'diagnostics_opened'
  | 'diagnostics_report_copied'
  | 'install_preflight_failed'
  | 'install_card_suppressed'
  | 'install_card_degraded'
  | 'install_instructions_opened'
  | 'manual_platform_selected'
  | 'manual_platform_changed'
  | 'platform_steps_shown'
  | 'install_attributed'
  | 'whatsapp_banner_shown';

function detectInAppName(): string | null {
  const ua = navigator.userAgent || '';
  if (/FBAN|FBAV/i.test(ua)) return 'Facebook';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/WhatsApp/i.test(ua)) return 'WhatsApp';
  if (/Line\//i.test(ua)) return 'Line';
  if (/MicroMessenger/i.test(ua)) return 'WeChat';
  if (/Twitter/i.test(ua)) return 'X / Twitter';
  if (/LinkedInApp/i.test(ua)) return 'LinkedIn';
  if (/musical_ly|BytedanceWebview/i.test(ua)) return 'TikTok';
  if (/Snapchat/i.test(ua)) return 'Snapchat';
  if (/Telegram/i.test(ua)) return 'Telegram';
  if (isChromeIOS()) return 'Chrome iOS';
  if (isFirefoxIOS()) return 'Firefox iOS';
  return null;
}

function detectPlatform(): string {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Mac/i.test(ua)) return 'macos';
  if (/Win/i.test(ua)) return 'windows';
  return 'other';
}

function detectDisplayMode(): string {
  if (typeof window.matchMedia !== 'function') return 'unknown';
  for (const q of ['standalone', 'fullscreen', 'minimal-ui', 'browser']) {
    try {
      if (window.matchMedia(`(display-mode: ${q})`).matches) return q;
    } catch {
      /* noop */
    }
  }
  return 'browser';
}

function detectIosVersion(): number | null {
  const m = (navigator.userAgent || '').match(/OS (\d+)_/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Fire-and-forget log of an install-flow interaction. Never throws.
 * Anonymous visitors are supported (user_id stays null).
 */
export async function trackInstallEvent(
  event_type: InstallEventType,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const payload = {
      user_id: user?.id ?? null,
      event_type,
      platform: detectPlatform(),
      in_app_browser: isIOSInAppBrowser() || isChromeIOS() || isFirefoxIOS(),
      in_app_browser_name: detectInAppName(),
      is_standalone: detectStandalone(),
      display_mode: detectDisplayMode(),
      ios_version: detectIosVersion(),
      user_agent: navigator.userAgent,
      url: window.location.href,
      metadata: metadata as never,
    };

    await supabase.from('install_attempt_events').insert([payload]);
  } catch {
    // Silent — telemetry must never break the flow.
  }
}