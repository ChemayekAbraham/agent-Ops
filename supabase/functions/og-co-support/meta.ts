/**
 * Title, description and image for a co-support invitation preview.
 * Pure (no I/O) so it is unit-tested in meta_test.ts.
 *
 * Copy rules: "Rent Plan", "Rent Profit Share"; never "loan", "interest",
 * "ROI" or "Returns"; never a rate or a Rent Profit Share figure (both depend
 * on the person who opens the link).
 */
export interface CoSupportPreview {
  status?: string | null;
  kind?: "rent_plan" | "house" | null;
  house_title?: string | null;
  lead_first_name?: string | null;
  tenant_first_name?: string | null;
  city?: string | null;
  house_image_url?: string | null;
  your_share?: number | string | null;
}

export interface CoSupportMeta {
  title: string;
  description: string;
  image: string | null;
  imageAlt: string;
}

export function formatUgx(n: number | string | null | undefined): string {
  const v = Math.round(Number(n ?? 0));
  return `UGX ${v.toLocaleString("en-US")}`;
}

const clean = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();

export function coSupportPreviewMeta(p: CoSupportPreview): CoSupportMeta {
  const isHouse = p.kind === "house";
  const what = isHouse ? "an empty house" : "a Rent Plan";
  const lead = clean(p.lead_first_name) || "A Welile partner";
  const tenant = clean(p.tenant_first_name);
  const houseTitle = clean(p.house_title);
  const city = clean(p.city);
  const home = isHouse
    ? houseTitle ? `A verified empty house (${houseTitle})` : "A verified empty house"
    : tenant ? `${tenant}'s home` : "A tenant's home";
  const place = city ? `${home} in ${city}, Uganda` : home;
  const image = /^https:\/\//i.test(clean(p.house_image_url)) ? clean(p.house_image_url) : null;
  const imageAlt = city ? `Rental home in ${city}` : "Rental home";

  if (p.status !== "open") {
    const ended = p.status === "completed"
      ? isHouse ? "This house has been fully supported." : "This Rent Plan has been fully supported."
      : "This invitation is no longer open.";
    return {
      title: `${lead}'s ${isHouse ? "house" : "Rent Plan"} invitation`,
      description: `${ended} Open Welile to find another one to support.`,
      image,
      imageAlt,
    };
  }

  return {
    title: `${lead} wants to support ${what} with you`,
    description:
      `${place}. Share it 50/50: your half is ${formatUgx(p.your_share)} ` +
      `and you earn Rent Profit Share every month. The invitation is open for 48 hours.`,
    image,
    imageAlt,
  };
}
