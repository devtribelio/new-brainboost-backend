import { prisma } from '@bb/db';
import { notFound, ERROR_CODES } from '@bb/common/exceptions';
import { activeEnrollment } from '@bb/domain/commerce/enrollment';

/**
 * Backend of the company (B2B) app — PRD b2b-db-consolidation §App B2B.
 *
 * Reads the B2B tables owned by brainboost-b2b-be (read-only here):
 * b2b_member_grant / b2b_payment_plan / b2b_customer / b2b_company_branding.
 *
 * What a member sees for a company comes from their ACTIVE grants there (grant
 * active AND plan active) — never from `course_enrollment.via_b2b_grant_id`:
 * an employee who bought course X themselves and is also given X by the company
 * has an unmarked enrollment, yet X must still appear in the company app. Access
 * (can it play right now?) is still decided by `course_enrollment`, like
 * everywhere else.
 */
const ACTIVE_SEAT = { isActive: true, paymentPlan: { isActive: true } } as const;
const DEFAULT_GROUP_TITLE = 'Kursus';

export interface Announcement {
  id: string;
  title: string;
  body: string;
  starts_at: string | null;
  ends_at: string | null;
}

interface LayoutGroup {
  title: string;
  course_ids: string[];
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Announcements whose window contains `now`; a missing bound is open-ended. */
export function activeAnnouncements(raw: unknown, now = new Date()): Announcement[] {
  return asArray<Partial<Announcement>>(raw)
    .filter((a) => a && typeof a.title === 'string')
    .filter((a) => {
      const starts = a.starts_at ? new Date(a.starts_at) : null;
      const ends = a.ends_at ? new Date(a.ends_at) : null;
      return (!starts || starts <= now) && (!ends || ends >= now);
    })
    .map((a, i) => ({
      id: String(a.id ?? i),
      title: a.title as string,
      body: String(a.body ?? ''),
      starts_at: a.starts_at ?? null,
      ends_at: a.ends_at ?? null,
    }));
}

/**
 * Order courses by the company's layout: listed groups first (in order, only
 * courses the member actually has), everything else in a trailing default group.
 * Empty groups are dropped.
 */
export function groupCourses<T extends { course_uuid: string }>(courses: T[], layoutRaw: unknown) {
  const byId = new Map(courses.map((c) => [c.course_uuid, c]));
  const used = new Set<string>();
  const groups: Array<{ title: string; courses: T[] }> = [];
  for (const g of asArray<LayoutGroup>(layoutRaw)) {
    if (!g || typeof g.title !== 'string') continue;
    const items = asArray<string>(g.course_ids)
      .map((id) => byId.get(id))
      .filter((c): c is T => Boolean(c) && !used.has(c!.course_uuid));
    items.forEach((c) => used.add(c.course_uuid));
    if (items.length) groups.push({ title: g.title, courses: items });
  }
  const rest = courses.filter((c) => !used.has(c.course_uuid));
  if (rest.length) groups.push({ title: DEFAULT_GROUP_TITLE, courses: rest });
  return groups;
}

export class B2bAppService {
  /** Companies where the member holds an active seat, with the theme summary. */
  async listCompanies(memberId: string) {
    const grants = await prisma.b2bMemberGrant.findMany({
      where: { memberId, ...ACTIVE_SEAT },
      select: { customerId: true, courseId: true },
    });
    const courseCount = new Map<string, Set<string>>();
    for (const g of grants) {
      if (!courseCount.has(g.customerId)) courseCount.set(g.customerId, new Set());
      courseCount.get(g.customerId)!.add(g.courseId);
    }
    if (courseCount.size === 0) return [];
    const customers = await prisma.b2bCustomer.findMany({
      where: { id: { in: [...courseCount.keys()] } },
      select: { id: true, companyName: true, branding: true },
      orderBy: { companyName: 'asc' },
    });
    return customers.map((c) => ({
      company_id: c.id,
      display_name: c.branding?.displayName ?? c.companyName ?? null,
      logo_url: c.branding?.logoUrl ?? null,
      primary_color: c.branding?.primaryColor ?? null,
      course_count: courseCount.get(c.id)?.size ?? 0,
    }));
  }

  /** 404 unless the member holds an active seat at this company. */
  private async assertSeat(memberId: string, companyId: string) {
    const seat = await prisma.b2bMemberGrant.findFirst({
      where: { memberId, customerId: companyId, ...ACTIVE_SEAT },
      select: { id: true },
    });
    if (!seat) throw notFound(ERROR_CODES.B2B_COMPANY_NOT_FOUND);
  }

  async getCompany(memberId: string, companyId: string, now = new Date()) {
    await this.assertSeat(memberId, companyId);
    const c = await prisma.b2bCustomer.findUnique({
      where: { id: companyId },
      select: { id: true, companyName: true, branding: true },
    });
    if (!c) throw notFound(ERROR_CODES.B2B_COMPANY_NOT_FOUND);
    return {
      company_id: c.id,
      display_name: c.branding?.displayName ?? c.companyName ?? null,
      logo_url: c.branding?.logoUrl ?? null,
      primary_color: c.branding?.primaryColor ?? null,
      welcome_text: c.branding?.welcomeText ?? null,
      announcements: activeAnnouncements(c.branding?.announcements, now),
    };
  }

  async listCourses(memberId: string, companyId: string, now = new Date()) {
    await this.assertSeat(memberId, companyId);
    const grants = await prisma.b2bMemberGrant.findMany({
      where: { memberId, customerId: companyId, ...ACTIVE_SEAT },
      select: { courseId: true },
      distinct: ['courseId'],
    });
    const courseIds = grants.map((g) => g.courseId);
    const [courses, enrollments, branding] = await Promise.all([
      prisma.course.findMany({
        where: { id: { in: courseIds } },
        select: {
          id: true,
          legacyCourseId: true,
          durationMin: true,
          // Explicit select: no price field can ever reach the company app.
          product: { select: { id: true, title: true, thumbnail: true } },
        },
      }),
      prisma.courseEnrollment.findMany({
        where: { memberId, courseId: { in: courseIds } },
        select: { courseId: true, progress: true, expiredDate: true, isCanceled: true },
      }),
      prisma.b2bCompanyBranding.findUnique({ where: { customerId: companyId }, select: { courseLayout: true } }),
    ]);
    const live = new Set(
      (
        await prisma.courseEnrollment.findMany({
          where: { memberId, courseId: { in: courseIds }, ...activeEnrollment(now) },
          select: { courseId: true },
        })
      ).map((e) => e.courseId),
    );
    const enrollmentByCourse = new Map(enrollments.map((e) => [e.courseId, e]));
    const items = courses
      .map((c) => {
        const e = enrollmentByCourse.get(c.id);
        return {
          course_id: c.legacyCourseId,
          course_uuid: c.id,
          product_id: c.product.id,
          title: c.product.title,
          thumbnail: c.product.thumbnail,
          duration_min: c.durationMin,
          access: { active: live.has(c.id), expires_at: e?.expiredDate ? e.expiredDate.toISOString() : null },
          progress: e?.progress ?? 0,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
    return { groups: groupCourses(items, branding?.courseLayout) };
  }
}
