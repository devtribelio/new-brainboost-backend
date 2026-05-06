import type { Request, Response } from 'express';

const FLASH_COOKIE = 'bb_admin_flash';

export type FlashLevel = 'success' | 'error' | 'info';

export interface FlashMessage {
  level: FlashLevel;
  text: string;
}

export function setFlash(res: Response, level: FlashLevel, text: string): void {
  const value = encodeURIComponent(JSON.stringify({ level, text }));
  res.cookie(FLASH_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/admin',
    maxAge: 60_000,
  });
}

export function consumeFlash(req: Request, res: Response): FlashMessage | null {
  const raw = req.cookies?.[FLASH_COOKIE];
  if (!raw) return null;
  res.clearCookie(FLASH_COOKIE, { path: '/admin' });
  try {
    return JSON.parse(decodeURIComponent(raw)) as FlashMessage;
  } catch {
    return null;
  }
}
