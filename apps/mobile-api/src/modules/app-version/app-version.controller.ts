import type { Request, Response } from 'express';
import { ok } from '@bb/common/utils/response.util';
import { logger } from '@bb/common/config/logger';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@bb/common/openapi/decorators';
import { AppVersionService } from './app-version.service';
import { VersionCheckDto } from './dto/version-check.dto';
import type { VersionCheckQueryDto } from './dto/version-check.query.dto';

@ApiTags('App')
export class AppVersionController {
  constructor(private readonly appVersionService: AppVersionService) {}

  @ApiOperation({
    summary: 'Force/soft update verdict for the installed app build',
    description:
      'PUBLIC — no auth. The mobile client attaches a bearer whenever it has one, including an EXPIRED one, so this route must never answer 401: a version ping must not be able to trigger a token refresh or a forced logout. The client also fails open (5s timeout, any non-2xx silently skipped).',
  })
  @ApiQuery({ name: 'platform', type: 'string', required: true, example: 'android' })
  @ApiQuery({ name: 'version', type: 'string', required: true, example: '3.2.3' })
  @ApiQuery({ name: 'build', type: 'integer', required: false, example: 186 })
  @ApiResponse({ status: 200, description: 'Update verdict', type: () => VersionCheckDto })
  check = async (req: Request, res: Response) => {
    const { platform, version, build } = req.query as unknown as VersionCheckQueryDto;

    const result = await this.appVersionService.check(platform, version);

    // `build` is telemetry only — the sole place it is used. Gives us the versionCode
    // spread per verdict when deciding whether a force threshold is safe to raise.
    logger.info(
      { platform, version, build, update: result.update, latestVersion: result.latestVersion },
      'app.version_check',
    );

    // Tiny payload, called once per cold start and per login: never let a proxy or the
    // client pin a stale verdict, or the force kill-switch stops being a kill-switch.
    res.set('Cache-Control', 'no-store');
    return ok(res, result);
  };
}
