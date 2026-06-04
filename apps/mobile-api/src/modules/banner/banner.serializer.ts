import type { Banner } from '@prisma/client';

export function serializeBanner(b: Banner): Record<string, unknown> {
  // FE BannerModel: `{id:int, client, link, image:List<String>}`. Aliased from
  // `legacyId` (= tribeversityBannerId), `title`, `linkUrl`, `[imageUrl]`.
  return {
    id: b.legacyId ?? b.id,
    client: b.title,
    link: b.linkUrl ?? '',
    image: [b.imageUrl],
    isPopup: b.isPopup,
  };
}
