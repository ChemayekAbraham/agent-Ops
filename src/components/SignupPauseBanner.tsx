import { AlertCircle } from 'lucide-react';

const RESUME_DATE = new Date();
RESUME_DATE.setDate(RESUME_DATE.getDate() + 7);

const formatDate = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

export const SIGNUP_PAUSED = false;
export const SIGNUP_RESUME_DATE = formatDate(RESUME_DATE);

// v2 - build refresh
export default function SignupPauseBanner() {
  if (!SIGNUP_PAUSED) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] w-full bg-destructive text-destructive-foreground px-4 py-3 text-center text-sm font-medium flex items-center justify-center gap-2">
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span>
        New sign-ups are paused. We resume on <strong>{SIGNUP_RESUME_DATE}</strong>. Explore freely!
      </span>
    </div>
  );
}
