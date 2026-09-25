/**
 * Branded short links for merchandise shares.
 *
 * WhatsApp only renders a rich preview from OG tags present in the HTML the
 * crawler receives, which is produced by the `og-merchandise` edge function.
 * To keep that preview while showing a short Welile address, a tiny proxy
 * (Cloudflare Worker — see infra/share-proxy/) is published on the share host
 * and forwards `/m/<code>` to the function, returning the same body.
 *
 * The branded host is welileapp.com (same as rent-plan /s/ links). The app
 * route `/m/:code` hands visitors to the `og-merchandise` function, which
 * logs the click and sends humans to the store. If the Cloudflare share
 * proxy (infra/share-proxy/) is later deployed on this host, crawlers will
 * also receive the rich preview directly at the branded URL.
 */
export const SHARE_LINK_HOST =
  (import.meta.env.VITE_SHARE_LINK_HOST as string | undefined)?.replace(/\/+$/, "") ||
  "https://welileapp.com";

export function shortMerchandiseUrl(code: string, src: string): string | null {
  if (!SHARE_LINK_HOST || !code) return null;
  return `${SHARE_LINK_HOST}/m/${code}?src=${encodeURIComponent(src)}`;
}

export function longMerchandiseUrl(itemId: string, itemName: string, src: string): string {
  const slug =
    String(itemName || "item")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "item";
  return `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/og-merchandise/${slug}-${itemId}?src=${encodeURIComponent(src)}&pv=4`;
}