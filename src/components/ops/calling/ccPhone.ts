/** Phone link helpers shared by the calling hub surfaces. Display the number as
 *  returned; strip everything but digits for the href. */
export function telHref(phone: string) {
  return `tel:${phone.replace(/\D/g, '')}`;
}

export function waHref(phone: string) {
  return `https://wa.me/${phone.replace(/\D/g, '')}`;
}

/** Minutes-since helper used by every open-attempt surface. */
export function openFor(iso: string) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m open`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m open`;
}
