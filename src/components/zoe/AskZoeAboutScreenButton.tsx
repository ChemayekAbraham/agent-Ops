import React from 'react';
import { useLocation } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { derivePageContextFromLocation, type ZoePageContext } from './zoeConfig';
import { useZoeAccess } from './useZoeAssistant';

export const ZOE_OPEN_WITH_PAGE_CONTEXT_EVENT = 'welile:open-zoe-assistant';

export interface OpenZoeWithContextDetail {
  pageContext: ZoePageContext;
  initialPrompt?: string;
}

export interface AskZoeAboutScreenButtonProps {
  title?: string;
  filters?: Record<string, string | number | boolean | null>;
  period?: string;
  initialPrompt?: string;
  label?: string;
  className?: string;
}

/**
 * Part C item (4) — "Ask Zoe about this" button for report and workspace screens.
 * Passes ONLY the route name, visible filters, and period (never screen data).
 * Zoe fetches all figures through her own role-checked tools.
 */
export const AskZoeAboutScreenButton: React.FC<AskZoeAboutScreenButtonProps> = ({
  title,
  filters,
  period,
  initialPrompt,
  label = 'Ask Zoe about this',
  className = '',
}) => {
  const location = useLocation();
  const { data: hasAccess } = useZoeAccess();

  if (hasAccess !== true) return null;

  const handleOpen = () => {
    const derived = derivePageContextFromLocation(location.pathname, location.search);
    const pageContext: ZoePageContext = {
      route: derived.route,
      title: title || derived.title,
      filters: filters ?? derived.filters,
      period: period ?? derived.period,
    };

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent<OpenZoeWithContextDetail>(ZOE_OPEN_WITH_PAGE_CONTEXT_EVENT, {
          detail: { pageContext, initialPrompt },
        }),
      );
    }
  };

  return (
    <button
      type="button"
      onClick={handleOpen}
      data-testid="ask-zoe-about-screen-button"
      className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
};

export default AskZoeAboutScreenButton;
