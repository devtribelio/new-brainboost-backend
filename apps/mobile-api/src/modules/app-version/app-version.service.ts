import { prisma } from '@bb/db';
import { resolveVerdict, type UpdateVerdict } from './version.util';

/**
 * Cache the per-platform config in memory: the endpoint is hit on every cold start and
 * every login, but the row changes a handful of times per release. The TTL is what makes
 * an ops SQL edit (or a backoffice write) take effect WITHOUT a redeploy — in particular
 * the force kill-switch, which must be revocable within a minute.
 */
const CACHE_TTL_MS = 60_000;

export interface VersionCheckResult {
  update: UpdateVerdict;
  latestVersion: string | null;
  storeUrl: string | null;
  message: string | null;
}

interface ConfigRow {
  latestVersion: string;
  forceBelow: string | null;
  storeUrl: string | null;
  softMessage: string | null;
  forceMessage: string | null;
}

interface CacheEntry {
  row: ConfigRow | null;
  expiresAt: number;
}

export class AppVersionService {
  private static cache = new Map<string, CacheEntry>();

  async check(platform: string, version: string): Promise<VersionCheckResult> {
    const config = await this.getConfig(platform);

    // No row for this platform (not seeded yet, or a platform we don't publish for):
    // stay silent rather than guess. Fail-safe matches the client's fail-open behaviour.
    if (!config) return { update: 'none', latestVersion: null, storeUrl: null, message: null };

    const update = resolveVerdict(version, config);
    // Stored per verdict so ops can word the blocking dialog differently from the nag,
    // but the contract exposes a single `message` — the client renders one body copy.
    const message =
      update === 'force' ? config.forceMessage : update === 'soft' ? config.softMessage : null;

    return {
      update,
      latestVersion: config.latestVersion,
      storeUrl: config.storeUrl,
      message: message ?? null,
    };
  }

  private async getConfig(platform: string): Promise<ConfigRow | null> {
    const now = Date.now();
    const hit = AppVersionService.cache.get(platform);
    if (hit && hit.expiresAt > now) return hit.row;

    const row = await prisma.appVersionConfig.findUnique({
      where: { platform },
      select: {
        latestVersion: true,
        forceBelow: true,
        storeUrl: true,
        softMessage: true,
        forceMessage: true,
      },
    });
    // A miss is cached too, so an unseeded platform can't turn every cold start into a query.
    AppVersionService.cache.set(platform, { row, expiresAt: now + CACHE_TTL_MS });
    return row;
  }

  /** Drop the in-memory cache (tests, or to force an immediate reload). */
  static clearCache(): void {
    AppVersionService.cache.clear();
  }
}
