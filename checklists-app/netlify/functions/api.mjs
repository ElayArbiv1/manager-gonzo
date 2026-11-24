// Netlify Function (v2): every /api/* request lands here.
import { handle } from '../../lib/router.mjs';

export default async req => handle(req);

export const config = { path: '/api/*' };
