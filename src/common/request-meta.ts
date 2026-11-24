import { Request } from 'express';

export function requestMeta(req: Request) {
  return { ip: req.ip ?? null, userAgent: (req.headers['user-agent'] ?? '').slice(0, 255) || null };
}
