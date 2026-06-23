/**
 * Print every media slide of a product with its current Bunny guid + library,
 * straight from the DB — a verification read after migration.
 *
 * Run: pnpm exec tsx scripts/check-product-media.ts <productCode>
 */
import { prisma } from '@bb/db';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const EMBED_RE = new RegExp(`embed/(\\d+)/(${UUID})`);

interface Slide {
  id?: unknown;
  type?: unknown;
  data?: { url?: unknown; audio?: { guid?: unknown; videoLibraryId?: unknown } };
}

async function main(): Promise<void> {
  const code = process.argv[2];
  if (!code) {
    console.error('usage: tsx scripts/check-product-media.ts <productCode>');
    process.exit(1);
  }
  const product = await prisma.product.findUnique({
    where: { code },
    include: { course: { include: { sections: { include: { lessons: true } } } } },
  });
  if (!product) {
    console.error(`product not found: ${code}`);
    process.exit(1);
  }
  console.log(`product: ${product.title}  (code ${code})\n`);

  for (const sec of product.course?.sections ?? []) {
    for (const l of sec.lessons) {
      const slides = Array.isArray(l.slidesData) ? (l.slidesData as Slide[]) : [];
      for (const s of slides) {
        const type = typeof s?.type === 'string' ? s.type : '';
        const d = s?.data ?? {};
        if (type === 'AudioTemplate' && typeof d.audio?.guid === 'string') {
          console.log(`  [${l.name}]  audio  guid=${d.audio.guid}  lib=${d.audio.videoLibraryId}`);
        } else if (type === 'VideoTemplate' && typeof d.url === 'string') {
          const m = d.url.match(EMBED_RE);
          console.log(`  [${l.name}]  video  ${m ? `lib=${m[1]} guid=${m[2]}` : '(no bunny embed)'}`);
        }
      }
    }
  }
  await prisma.$disconnect();
}

void main().catch((err) => {
  console.error('ERROR:', (err as Error).message);
  process.exit(1);
});
