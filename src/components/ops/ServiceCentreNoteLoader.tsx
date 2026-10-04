import { useServiceCentreComments } from '@/hooks/useServiceCentreComments';
import { ServiceCentreNote } from './ServiceCentreNote';

/**
 * Lazily loads and renders the Service Centre vetting note for one record.
 * Used inside Ops review panels where the list RPC does not carry the column.
 */
export function ServiceCentreNoteLoader({
  table,
  id,
}: {
  table: 'house_listings' | 'landlords' | 'lc1_chairpersons';
  id: string;
}) {
  const { data } = useServiceCentreComments(table, [id]);
  const row = data?.[id];
  return <ServiceCentreNote comment={row?.comment} reviewedAt={row?.reviewed_at} />;
}
