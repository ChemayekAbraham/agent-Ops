import { useMemo } from 'react';
import { useSafeAuth } from '@/components/auth/useSafeAuth';
import { useAuthenticatorMfa } from '@/hooks/useAuthenticatorMfa';
import { AuthenticatorSetupScreen } from './AuthenticatorSetupScreen';
import { AuthenticatorChallengeScreen } from './AuthenticatorChallengeScreen';
import { AuthenticatorPromptBanner } from './AuthenticatorPromptBanner';

export function StaffAuthenticatorGate() {
  const { user } = useSafeAuth();
  const { stage } = useAuthenticatorMfa(user?.id);

  // DEV-only preview switch: ?mfaPreview=enrol or ?mfaPreview=challenge
  const devPreview = useMemo(() => {
    if (!import.meta.env.DEV || typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('mfaPreview');
  }, []);

  const activeStage = devPreview ? devPreview : stage;

  if (activeStage === 'enrol') {
    return <AuthenticatorSetupScreen />;
  }

  if (activeStage === 'challenge') {
    return <AuthenticatorChallengeScreen />;
  }

  if (activeStage === 'prompt') {
    return <AuthenticatorPromptBanner />;
  }

  // 'loading', 'not_required', 'verified' or unrecognized
  return null;
}

export default StaffAuthenticatorGate;
