import { proxyShare } from '../../lib/proxy.js';

/** share.welileapp.com/c/<code>: co-support invitations (two partners share one Rent Plan). */
export const onRequest = ({ request, params }) => proxyShare(request, 'c', String(params.code || ''));
