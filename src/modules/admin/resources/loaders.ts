import { prisma } from '@bb/db';
import type { SelectOption } from '../util/crud-factory';

const LOAD_LIMIT = 500;

export async function loadMembers(): Promise<SelectOption[]> {
  const rows = await prisma.member.findMany({
    take: LOAD_LIMIT,
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true, fullName: true },
  });
  return rows.map((r) => ({ value: r.id, label: `${r.email} (${r.fullName ?? '—'})` }));
}

export async function loadTopics(): Promise<SelectOption[]> {
  const rows = await prisma.topic.findMany({
    take: LOAD_LIMIT,
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  return rows.map((r) => ({ value: r.id, label: r.name }));
}

export async function loadCountries(): Promise<SelectOption[]> {
  const rows = await prisma.country.findMany({
    take: LOAD_LIMIT,
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  return rows.map((r) => ({ value: r.id, label: r.name }));
}

export async function loadProvinces(): Promise<SelectOption[]> {
  const rows = await prisma.province.findMany({
    take: LOAD_LIMIT,
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  return rows.map((r) => ({ value: r.id, label: r.name }));
}

export async function loadCities(): Promise<SelectOption[]> {
  const rows = await prisma.city.findMany({
    take: LOAD_LIMIT,
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  return rows.map((r) => ({ value: r.id, label: r.name }));
}

export async function loadDistricts(): Promise<SelectOption[]> {
  const rows = await prisma.district.findMany({
    take: LOAD_LIMIT,
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  return rows.map((r) => ({ value: r.id, label: r.name }));
}

export async function loadProducts(): Promise<SelectOption[]> {
  const rows = await prisma.product.findMany({
    take: LOAD_LIMIT,
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true },
  });
  return rows.map((r) => ({ value: r.id, label: r.title }));
}

export async function loadPosts(): Promise<SelectOption[]> {
  const rows = await prisma.post.findMany({
    take: LOAD_LIMIT,
    orderBy: { createdAt: 'desc' },
    select: { id: true, content: true },
  });
  return rows.map((r) => ({
    value: r.id,
    label: `${r.id.slice(0, 8)} — ${r.content.slice(0, 40)}`,
  }));
}

export async function loadComments(): Promise<SelectOption[]> {
  const rows = await prisma.comment.findMany({
    take: LOAD_LIMIT,
    orderBy: { createdAt: 'desc' },
    select: { id: true, content: true },
  });
  return rows.map((r) => ({
    value: r.id,
    label: `${r.id.slice(0, 8)} — ${r.content.slice(0, 40)}`,
  }));
}

export async function loadNetworks(): Promise<SelectOption[]> {
  const rows = await prisma.network.findMany({
    take: LOAD_LIMIT,
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  return rows.map((r) => ({ value: r.id, label: r.name }));
}

export async function loadReportCategories(): Promise<SelectOption[]> {
  const rows = await prisma.reportCategory.findMany({
    take: LOAD_LIMIT,
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  return rows.map((r) => ({ value: r.id, label: r.name }));
}
