import { Router, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { asyncHandler } from '@bb/common/utils/async-handler';
import { NotFoundException } from '@bb/common/exceptions';
import type { AdminRequest } from '../admin.types';
import { renderAdmin } from './view';
import { setFlash } from './flash';
import { buildPageMeta, getPagination } from './pagination';

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'datetime'
  | 'json'
  | 'password'
  | 'string-array'
  | 'readonly';

export interface SelectOption {
  value: string;
  label: string;
}

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  helpText?: string;
  options?: SelectOption[];
  optionsLoader?: () => Promise<SelectOption[]>;
  showOn?: ('create' | 'edit')[];
  hashOnSet?: boolean;
}

export interface ColumnDef {
  field: string;
  label: string;
  format?: (value: unknown, row: Record<string, unknown>) => string;
}

// Loose shape that matches every Prisma model delegate. We intentionally use
// `any` for the args because each delegate has a different generic signature
// and we only ever call them through this admin scaffold, never with the
// Prisma-typed inputs.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaDelegate {
  findMany: (args?: any) => Promise<any[]>;
  findUnique: (args: any) => Promise<any>;
  count: (args?: any) => Promise<number>;
  create: (args: any) => Promise<any>;
  update: (args: any) => Promise<any>;
  delete: (args: any) => Promise<any>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface ResourceConfig {
  key: string;
  label: string;
  pluralLabel: string;
  model: PrismaDelegate;
  idField?: string;
  listColumns: ColumnDef[];
  fields: FieldDef[];
  defaultOrderBy?: Record<string, 'asc' | 'desc'>;
  searchField?: string;
  include?: Record<string, unknown>;
  canCreate?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  /**
   * When set, the whole resource router (list/create/edit/delete) is gated to
   * admins holding this role. Used to lock the `admins` resource to SUPERADMIN
   * so a low-privilege ADMIN cannot self-escalate or reset other admins'
   * credentials. Enforced in admin.routes.ts via requireRole.
   */
  requiredRole?: 'ADMIN' | 'SUPERADMIN';
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toISOString().replace('T', ' ').slice(0, 19);
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${value.length}]`;
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 80);
  return String(value);
}

async function loadFieldOptions(fields: FieldDef[]): Promise<Record<string, SelectOption[]>> {
  const result: Record<string, SelectOption[]> = {};
  await Promise.all(
    fields.map(async (f) => {
      if (f.options) result[f.name] = f.options;
      else if (f.optionsLoader) result[f.name] = await f.optionsLoader();
    }),
  );
  return result;
}

function shouldShow(field: FieldDef, mode: 'create' | 'edit'): boolean {
  if (!field.showOn) return true;
  return field.showOn.includes(mode);
}

async function parseField(
  field: FieldDef,
  raw: unknown,
  mode: 'create' | 'edit',
): Promise<{ skip: boolean; value: unknown }> {
  const str = raw === undefined || raw === null ? '' : String(raw);

  if (field.type === 'readonly') return { skip: true, value: undefined };

  if (field.type === 'boolean') {
    const checked = str === 'on' || str === 'true' || str === '1';
    return { skip: false, value: checked };
  }

  if (field.type === 'number') {
    if (str.trim() === '') {
      if (field.required) throw new Error(`${field.label} is required`);
      return { skip: false, value: null };
    }
    const n = Number(str);
    if (Number.isNaN(n)) throw new Error(`${field.label} must be a number`);
    return { skip: false, value: n };
  }

  if (field.type === 'datetime') {
    if (str.trim() === '') {
      if (field.required) throw new Error(`${field.label} is required`);
      return { skip: false, value: null };
    }
    const d = new Date(str);
    if (Number.isNaN(d.getTime())) throw new Error(`${field.label} is not a valid date`);
    return { skip: false, value: d };
  }

  if (field.type === 'json') {
    if (str.trim() === '') {
      if (field.required) throw new Error(`${field.label} is required`);
      return { skip: false, value: null };
    }
    try {
      return { skip: false, value: JSON.parse(str) };
    } catch {
      throw new Error(`${field.label} must be valid JSON`);
    }
  }

  if (field.type === 'string-array') {
    const items = str
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { skip: false, value: items };
  }

  if (field.type === 'password') {
    if (str === '') {
      if (mode === 'create' && field.required) throw new Error(`${field.label} is required`);
      return { skip: true, value: undefined };
    }
    if (field.hashOnSet) {
      return { skip: false, value: await bcrypt.hash(str, 10) };
    }
    return { skip: false, value: str };
  }

  if (field.type === 'select') {
    if (str === '' || str === '__null__') {
      if (field.required) throw new Error(`${field.label} is required`);
      return { skip: false, value: null };
    }
    return { skip: false, value: str };
  }

  // text, textarea
  if (str === '') {
    if (field.required) throw new Error(`${field.label} is required`);
    return { skip: false, value: null };
  }
  return { skip: false, value: str };
}

async function buildPersistData(
  fields: FieldDef[],
  body: Record<string, unknown>,
  mode: 'create' | 'edit',
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    if (!shouldShow(field, mode)) continue;
    const { skip, value } = await parseField(field, body[field.name], mode);
    if (skip) continue;
    data[field.name] = value;
  }
  return data;
}

export function createResourceRouter(cfg: ResourceConfig): Router {
  const router = Router();
  const idField = cfg.idField ?? 'id';
  const canCreate = cfg.canCreate !== false;
  const canEdit = cfg.canEdit !== false;
  const canDelete = cfg.canDelete !== false;
  const orderBy = cfg.defaultOrderBy ?? { [idField]: 'desc' };

  router.get(
    '/',
    asyncHandler(async (req: AdminRequest, res: Response) => {
      const p = getPagination(req);
      const search = ((req.query.q as string) ?? '').trim();

      const where: Record<string, unknown> = {};
      if (search && cfg.searchField) {
        where[cfg.searchField] = { contains: search, mode: 'insensitive' };
      }

      const [rows, total] = await Promise.all([
        cfg.model.findMany({
          where,
          orderBy,
          skip: p.skip,
          take: p.take,
          include: cfg.include,
        }),
        cfg.model.count({ where }),
      ]);

      const meta = buildPageMeta(p, total);
      renderAdmin(req, res, 'admin/resource/list', {
        title: cfg.pluralLabel,
        cfg,
        rows,
        meta,
        search,
        idField,
        canCreate,
        canEdit,
        canDelete,
        formatCell,
      });
    }),
  );

  if (canCreate) {
    router.get(
      '/new',
      asyncHandler(async (req: AdminRequest, res: Response) => {
        const fields = cfg.fields.filter((f) => shouldShow(f, 'create'));
        const fieldOptions = await loadFieldOptions(fields);
        renderAdmin(req, res, 'admin/resource/form', {
          title: `New ${cfg.label}`,
          cfg,
          mode: 'create',
          fields,
          fieldOptions,
          row: {},
          formAction: `/admin/${cfg.key}`,
          idField,
        });
      }),
    );

    router.post(
      '/',
      asyncHandler(async (req: AdminRequest, res: Response) => {
        try {
          const data = await buildPersistData(cfg.fields, req.body ?? {}, 'create');
          await cfg.model.create({ data });
          setFlash(res, 'success', `${cfg.label} created.`);
          res.redirect(`/admin/${cfg.key}`);
        } catch (err) {
          setFlash(res, 'error', err instanceof Error ? err.message : 'Failed to create');
          res.redirect(`/admin/${cfg.key}/new`);
        }
      }),
    );
  }

  if (canEdit) {
    router.get(
      '/:id/edit',
      asyncHandler(async (req: AdminRequest, res: Response) => {
        const row = (await cfg.model.findUnique({
          where: { [idField]: req.params.id },
          include: cfg.include,
        })) as Record<string, unknown> | null;
        if (!row) throw new NotFoundException(`${cfg.label} not found`);
        const fields = cfg.fields.filter((f) => shouldShow(f, 'edit'));
        const fieldOptions = await loadFieldOptions(fields);
        renderAdmin(req, res, 'admin/resource/form', {
          title: `Edit ${cfg.label}`,
          cfg,
          mode: 'edit',
          fields,
          fieldOptions,
          row,
          formAction: `/admin/${cfg.key}/${req.params.id}`,
          idField,
        });
      }),
    );

    router.post(
      '/:id',
      asyncHandler(async (req: AdminRequest, res: Response) => {
        try {
          const data = await buildPersistData(cfg.fields, req.body ?? {}, 'edit');
          await cfg.model.update({
            where: { [idField]: req.params.id },
            data,
          });
          setFlash(res, 'success', `${cfg.label} updated.`);
          res.redirect(`/admin/${cfg.key}`);
        } catch (err) {
          setFlash(res, 'error', err instanceof Error ? err.message : 'Failed to update');
          res.redirect(`/admin/${cfg.key}/${req.params.id}/edit`);
        }
      }),
    );
  }

  if (canDelete) {
    router.post(
      '/:id/delete',
      asyncHandler(async (req: AdminRequest, res: Response) => {
        try {
          await cfg.model.delete({ where: { [idField]: req.params.id } });
          setFlash(res, 'success', `${cfg.label} deleted.`);
        } catch (err) {
          setFlash(res, 'error', err instanceof Error ? err.message : 'Failed to delete');
        }
        res.redirect(`/admin/${cfg.key}`);
      }),
    );
  }

  return router;
}
