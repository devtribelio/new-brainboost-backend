import { prisma } from '@bb/db';
import type { PaginationParams } from '@bb/common/utils/pagination.util';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { compareSemver } from '../app-version/version.util';

/** What the client tells us about itself on `GET /data/banner`. Both optional. */
export interface BannerClientInfo {
  platform?: string;
  version?: string;
}

const MAX_VERSION_KEY: Record<string, string> = {
  android: SETTING_KEYS.bannerMaxVersionAndroid,
  ios: SETTING_KEYS.bannerMaxVersionIos,
};

export class BannerService {
  async listActive(p: PaginationParams, filter?: { isPopup?: boolean }, client?: BannerClientInfo) {
    if (await this.isHiddenForClient(client)) return { rows: [], total: 0 };

    const now = new Date();
    const where = {
      isActive: true,
      // null bound = open-ended: started <= now <= ended
      AND: [
        { OR: [{ startedAt: null }, { startedAt: { lte: now } }] },
        { OR: [{ endedAt: null }, { endedAt: { gte: now } }] },
      ],
      ...(filter?.isPopup !== undefined ? { isPopup: filter.isPopup } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.banner.findMany({
        where,
        orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
        skip: p.skip,
        take: p.take,
      }),
      prisma.banner.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * Banners are shown up to and INCLUDING `banner.maxVersion<Platform>` ("3.3.0 kebawah"),
   * and hidden on anything strictly newer. Runtime-configurable per platform because Play
   * and the App Store never cut over together.
   *
   * Fail-OPEN on every unknown: no platform, no version, unparseable version, empty setting.
   * That is deliberate — builds shipped before this gate existed send no query params at all,
   * and they are by definition the OLD versions that must keep seeing the banner.
   */
  private async isHiddenForClient(client?: BannerClientInfo): Promise<boolean> {
    const key = client?.platform ? MAX_VERSION_KEY[client.platform] : undefined;
    if (!key || !client?.version) return false;

    const maxVersion = (await settingsService.get(key, '')).trim();
    if (!maxVersion) return false; // gate off

    // null (unparseable either side) is not 1 -> shown.
    return compareSemver(client.version, maxVersion) === 1;
  }
}
