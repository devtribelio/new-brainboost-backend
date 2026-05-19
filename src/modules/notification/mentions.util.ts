import { prisma } from '@/config/prisma';

export function parseMentionUsernames(content: string): string[] {
  const matches = content.match(/@[A-Za-z0-9_]+/g);
  if (!matches) return [];
  return Array.from(new Set(matches.map((m) => m.slice(1))));
}

export async function resolveMentionMemberIds(content: string): Promise<string[]> {
  const usernames = parseMentionUsernames(content);
  if (usernames.length === 0) return [];
  const rows = await prisma.member.findMany({
    where: { username: { in: usernames } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
