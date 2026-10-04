import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { AvailableHousesSheet } from '@/components/tenant/AvailableHousesSheet';

const SITE_URL = 'https://welileapp.com';

/**
 * Full-page route for "View All" available houses. Mounts the existing
 * AvailableHousesSheet with `open` pinned true; closing it returns to the
 * previous page (typically the tenant dashboard).
 */
export default function AvailableHouses() {
  const navigate = useNavigate();

  const collectionJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Available Houses to Rent',
    description: 'Browse verified houses, rooms, apartments and commercial spaces for daily rent across Uganda on Welile.',
    url: `${SITE_URL}/houses`,
    isPartOf: {
      '@type': 'WebSite',
      name: 'Welile',
      url: SITE_URL,
    },
  };

  return (
    <>
      <Helmet>
        <title>Available Houses | Welile</title>
        <meta name="description" content="Browse all available houses to rent on Welile." />
        <link rel="canonical" href="https://welileapp.com/houses" />
        <script type="application/ld+json">{JSON.stringify(collectionJsonLd)}</script>
      </Helmet>
      <h1 className="sr-only">Available Houses to Rent</h1>
      <AvailableHousesSheet
        open
        onOpenChange={(next) => {
          if (!next) navigate(-1);
        }}
      />
    </>
  );
}