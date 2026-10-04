import { MessageCircle, Mail, UserPlus } from 'lucide-react';

interface ArchivedAccountSupportProps {
  /** The phone or email the user tried to sign in with. */
  identifier?: string;
  /** Raw error message shown above — used to detect deleted/archived state. */
  errorMessage?: string | null;
  /** Optional callback to switch the auth form into sign-up mode (for freed accounts). */
  onSignUp?: () => void;
}

const SUPPORT_EMAIL = 'support@welile.com';
const SUPPORT_WHATSAPP = '256700000000'; // Welile support WhatsApp (placeholder)

type Mode = 'archived' | 'freed' | 'none';

function detectMode(msg?: string | null): Mode {
  if (!msg) return 'none';
  const m = msg.toLowerCase();
  if (m.includes('permanently closed') || m.includes("can't be restored") || m.includes('brand-new account')) {
    return 'freed';
  }
  if (
    m.includes('archived') ||
    m.includes('contact welile support') ||
    m.includes('restore access') ||
    m.includes('deleted')
  ) {
    return 'archived';
  }
  return 'none';
}

export function ArchivedAccountSupport({ identifier, errorMessage, onSignUp }: ArchivedAccountSupportProps) {
  const mode = detectMode(errorMessage);
  if (mode === 'none') return null;

  // Permanently closed → push the user to fresh signup, not to support.
  if (mode === 'freed') {
    return (
      <div className="mt-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 space-y-2">
        <div className="flex items-start gap-2 text-xs text-destructive">
          <UserPlus className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            This {identifier ? 'identifier' : 'account'} was released. The old account can't be restored — please
            create a brand-new one.
          </span>
        </div>
        {onSignUp ? (
          <button
            type="button"
            onClick={onSignUp}
            className="w-full flex items-center justify-center gap-1.5 h-10 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-opacity"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Sign up for a new account
          </button>
        ) : null}
      </div>
    );
  }

  // Archived (restorable) → contact support.
  const subject = encodeURIComponent('Request to restore my Welile account');
  const body = encodeURIComponent(
    `Hello Welile Support,\n\n` +
      `I'm trying to sign in but my account appears to be archived. ` +
      `Please help me restore access or guide me on next steps.\n\n` +
      `Account identifier: ${identifier || '(not provided)'}\n` +
      `Error shown at login: ${errorMessage || '(none)'}\n\n` +
      `Thank you.`,
  );
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
  const waMsg = encodeURIComponent(
    `Hello Welile Support — my account (${identifier || 'unknown identifier'}) appears archived. ` +
      `Please help me restore access.`,
  );
  const whatsapp = `https://wa.me/${SUPPORT_WHATSAPP}?text=${waMsg}`;

  return (
    <div className="mt-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 space-y-2">
      <div className="flex items-start gap-2 text-xs text-destructive">
        <MessageCircle className="h-4 w-4 shrink-0 mt-0.5" />
        <span>This account can still be restored. Request restoration or talk to our support team.</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <a
          href={whatsapp}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1.5 h-10 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-opacity"
        >
          <MessageCircle className="h-3.5 w-3.5" />
          Request restoration
        </a>
        <a
          href={mailto}
          className="flex items-center justify-center gap-1.5 h-10 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-muted transition-colors"
        >
          <Mail className="h-3.5 w-3.5" />
          Email support
        </a>
      </div>
    </div>
  );
}
