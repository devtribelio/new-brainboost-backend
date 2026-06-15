import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireRole } from '../src/modules/admin/admin.auth.middleware';
import { resources } from '../src/modules/admin/resources';

// Regression for the CRITICAL admin RBAC gap: requireRole was dead code and the
// `admins` resource was reachable by any authenticated ADMIN, allowing
// self-escalation to SUPERADMIN. These tests assert the guard works AND that the
// sensitive resource is actually wired to demand SUPERADMIN.

function mockRes() {
  const res = {
    statusCode: 0,
    rendered: null as string | null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    render(view: string) {
      this.rendered = view;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; rendered: string | null };
}

describe('requireRole admin guard', () => {
  it('blocks an ADMIN from a SUPERADMIN-only resource (403, no next)', () => {
    const guard = requireRole('SUPERADMIN');
    const req = { admin: { role: 'ADMIN' }, path: '/admin/admins' } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    guard(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.rendered).toBe('admin/error');
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a SUPERADMIN through', () => {
    const guard = requireRole('SUPERADMIN');
    const req = { admin: { role: 'SUPERADMIN' }, path: '/admin/admins' } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    guard(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it('blocks an unauthenticated request (no admin on req)', () => {
    const guard = requireRole('SUPERADMIN');
    const req = { path: '/admin/admins' } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    guard(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('admins resource is SUPERADMIN-gated', () => {
  it('the `admins` resource declares requiredRole SUPERADMIN', () => {
    const adminsResource = resources.find((r) => r.key === 'admins');
    expect(adminsResource).toBeDefined();
    expect(adminsResource?.requiredRole).toBe('SUPERADMIN');
  });
});
