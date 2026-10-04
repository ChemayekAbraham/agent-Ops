import { useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useNameCompletionStatus } from '@/hooks/useNameCompletionStatus';

const FIRST_NAME_INPUT_ID = 'settings-first-name';

/**
 * Persistent, read-only reminder to complete the user's profile name.
 * Uses the existing validateFullName message verbatim and navigates to
 * /settings, focusing the existing First name input.
 *
 * No form, no save logic, no backend writes.
 */
export default function NameCompletionReminder() {
  const navigate = useNavigate();
  const { data, isLoading } = useNameCompletionStatus();

  if (isLoading || !data?.needsName) return null;

  const handleUpdate = () => {
    navigate('/settings');
    // Allow the settings route to render before focusing.
    setTimeout(() => {
      const el = document.getElementById(FIRST_NAME_INPUT_ID);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus({ preventScroll: true });
    }, 0);
  };

  return (
    <Alert variant="warning" className="rounded-2xl">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Complete your profile name</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <span>{data.reason}</span>
        <Button variant="outline" size="sm" className="self-start" onClick={handleUpdate}>
          Update my name
        </Button>
      </AlertDescription>
    </Alert>
  );
}
