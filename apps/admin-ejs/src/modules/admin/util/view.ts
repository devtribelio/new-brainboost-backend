import type { Response } from 'express';
import type { AdminRequest } from '../admin.types';
import { consumeFlash } from './flash';
import { sidebarSections } from '../admin.nav';

export function renderAdmin(
  req: AdminRequest,
  res: Response,
  view: string,
  locals: Record<string, unknown> = {},
): void {
  res.render(view, {
    admin: req.admin ?? null,
    flash: consumeFlash(req, res),
    sidebar: sidebarSections,
    currentPath: req.path,
    title: locals.title ?? 'Admin',
    ...locals,
  });
}
