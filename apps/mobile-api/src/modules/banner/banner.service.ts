import { prisma } from '@bb/db';
import type { PaginationParams } from '@bb/common/utils/pagination.util';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import type { Banner } from '@prisma/client';
import { compareSemver, isWithinVersionWindow } from '../app-version/version.util';

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
    // Paged in memory: the per-banner version window is semver, which SQL cannot compare,
    // so it has to be applied before skip/take for `total` to stay right. Active banners
    // number in the single digits.
    const all = await prisma.banner.findMany({
      where,
      orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
    });
    const visible = all.filter((b) => isVisibleForClient(b, client));
    return { rows: visible.slice(p.skip, p.skip + p.take), total: visible.length };
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

type BannerVersionWindow = Pick<
  Banner,
  'minVersionAndroid' | 'maxVersionAndroid' | 'minVersionIos' | 'maxVersionIos'
>;

/**
 * Per-banner version window, on top of the global gate above. A banner with no bound is
 * shown as before. A banner with ANY bound is shown only to a client that sends
 * `platform=android|ios` and a version inside that platform's window (an empty pair for
 * the client's platform = unbounded). It fails CLOSED — no platform means web or an app
 * build older than the banner gate, which BE cannot tell apart, and either way must not
 * see a banner scoped to an internal build.
 */
function isVisibleForClient(b: BannerVersionWindow, client?: BannerClientInfo): boolean {
  const hasWindow = [b.minVersionAndroid, b.maxVersionAndroid, b.minVersionIos, b.maxVersionIos]
    .some((v) => v?.trim());
  if (!hasWindow) return true;
  if (client?.platform === 'android') {
    return isWithinVersionWindow(client.version, b.minVersionAndroid, b.maxVersionAndroid);
  }
  if (client?.platform === 'ios') {
    return isWithinVersionWindow(client.version, b.minVersionIos, b.maxVersionIos);
  }
  return false;
}
