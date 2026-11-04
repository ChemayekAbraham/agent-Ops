import { proxyShare } from '../../lib/proxy.js';

/** share.welileapp.com/s/<code>: rent plans and empty houses. */
export const onRequest = ({ request, params }) => proxyShare(request, 's', String(params.code || ''));
