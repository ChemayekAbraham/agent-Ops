import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

/**
 * Branded short-link landing route: welileapp.com/m/<code>
 *
 * The code is resolved by the `og-merchandise` edge function, which logs the
 * click against the share code and then sends humans on to the merchandise
 * page (social crawlers receive the Open Graph head instead). We hand off with
 * a full-page replace so this route never appears in history.
 */
export default function MerchandiseShareRedirect() {
  const { code } = useParams<{ code: string }>();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const safeCode = (code ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (!safeCode) {
      window.location.replace('/merchandise');
      return;
    }
    const src = searchParams.get('src') ?? 'link';
    const target = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/og-merchandise/m/${encodeURIComponent(
      safeCode,
    )}?src=${encodeURIComponent(src)}`;
    window.location.replace(target);
  }, [code, searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <p className="text-sm text-muted-foreground">Opening the store…</p>
    </div>
  );
}
