import { prisma } from '@bb/db';
import type { PostKindDto } from './dto/post-kind.dto';

/**
 * Post kind taxonomy (§4 / BB-116). BE-sourced like topics so product can tune
 * the list without an app release. Tiny + rarely changing — FE caches it
 * client-side and refreshes in the background.
 */
export class PostKindService {
  async list(): Promise<PostKindDto[]> {
    const rows = await prisma.postKind.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    });
    return rows.map((r) => ({ kindId: r.id, name: r.name }));
  }
}
