import { lazy, type LazyExoticComponent } from 'react';

/**
 * Landlord Ops child routes — one lazy chunk per destination.
 *
 * The paths here are the single source of truth and must stay in step with
 * `LANDLORD_OPS_SECTIONS` in `landlordOpsNav.ts`; `landlordOpsNav.test.ts`
 * asserts the two agree, so a nav link can never point at a route that does
 * not exist (or vice versa).
 *
 * Lazy matters: several of these mount `LandlordOpsDashboard`, which is a very
 * large component. Static imports here would pull the whole console — every
 * panel, every chart — into the first chunk a user loads.
 */
export interface LandlordOpsRoute {
  /** Path relative to `/landlord-ops`. The empty string is the index route. */
  path: string;
  Component: LazyExoticComponent<() => JSX.Element>;
}

export const LANDLORD_OPS_ROUTES: LandlordOpsRoute[] = [
  { path: '', Component: lazy(() => import('./Today')) },

  { path: 'verify/houses', Component: lazy(() => import('./verify/Houses')) },
  { path: 'verify/landlords', Component: lazy(() => import('./verify/Landlords')) },
  { path: 'verify/lc1', Component: lazy(() => import('./verify/Lc1')) },

  { path: 'pipeline/rent-requests', Component: lazy(() => import('./pipeline/RentRequests')) },
  { path: 'pipeline/advances', Component: lazy(() => import('./pipeline/Advances')) },

  { path: 'payouts/review', Component: lazy(() => import('./payouts/Review')) },
  { path: 'payouts/paid', Component: lazy(() => import('./payouts/Paid')) },
  { path: 'payouts/float', Component: lazy(() => import('./payouts/Float')) },
  { path: 'payouts/idle-float', Component: lazy(() => import('./payouts/IdleFloat')) },

  { path: 'fixups/chain-health', Component: lazy(() => import('./fixups/ChainHealth')) },
  { path: 'fixups/lc1-duplicates', Component: lazy(() => import('./fixups/Lc1Duplicates')) },
  { path: 'fixups/locations', Component: lazy(() => import('./fixups/Locations')) },
  { path: 'fixups/no-landlord', Component: lazy(() => import('./fixups/NoLandlord')) },
  { path: 'fixups/matching', Component: lazy(() => import('./fixups/Matching')) },

  { path: 'registers/landlords', Component: lazy(() => import('./registers/Landlords')) },
  { path: 'registers/landlord-float', Component: lazy(() => import('./float/LandlordFloat')) },
  { path: 'registers/houses-tenants', Component: lazy(() => import('./registers/HousesTenants')) },
  { path: 'registers/requests', Component: lazy(() => import('./registers/Requests')) },
  { path: 'registers/lc1', Component: lazy(() => import('./registers/Lc1')) },

  { path: 'calling', Component: lazy(() => import('./calling/CallingHub')) },
  { path: 'coverage', Component: lazy(() => import('./coverage/Coverage')) },
  { path: 'agent-capacity', Component: lazy(() => import('./agent-capacity/AgentCapacity')) },
  { path: 'service-centres', Component: lazy(() => import('./service-centres/ServiceCentres')) },
  { path: 'reports', Component: lazy(() => import('./reports/Reports')) },
];
