import { proxyShare } from '../../lib/proxy.js';

/** share.welileapp.com/m/<code>: merchandise. */
export const onRequest = ({ request, params }) => proxyShare(request, 'm', String(params.code || ''));
