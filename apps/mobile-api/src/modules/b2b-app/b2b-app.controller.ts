import type { Response } from 'express';
import { isUUID } from 'class-validator';
import { ok } from '@bb/common/utils/response.util';
import { notFound, ERROR_CODES, UnauthorizedException } from '@bb/common/exceptions';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@bb/common/openapi/decorators';
import type { B2bAppService } from './b2b-app.service';

@ApiTags('B2B App')
@ApiBearerAuth()
export class B2bAppController {
  constructor(private readonly service: B2bAppService) {}

  private companyId(req: AuthenticatedRequest): string {
    const { companyId } = req.params;
    // Malformed ids get the same 404 as foreign ones: nothing to probe.
    if (!isUUID(companyId)) throw notFound(ERROR_CODES.B2B_COMPANY_NOT_FOUND);
    return companyId;
  }

  @ApiOperation({ summary: 'Companies where the member holds an active seat (company app home / picker)' })
  @ApiResponse({ status: 200, description: '[{ company_id, display_name, logo_url, primary_color, course_count }]' })
  listCompanies = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    return ok(res, await this.service.listCompanies(req.user.id));
  };

  @ApiOperation({ summary: 'Company theme and active announcements' })
  @ApiResponse({ status: 404, description: 'No active seat at this company (also unknown ids)' })
  getCompany = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    return ok(res, await this.service.getCompany(req.user.id, this.companyId(req)));
  };

  @ApiOperation({ summary: 'Courses the company grants the member, grouped by the company layout. No prices.' })
  @ApiResponse({ status: 404, description: 'No active seat at this company (also unknown ids)' })
  listCourses = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    return ok(res, await this.service.listCourses(req.user.id, this.companyId(req)));
  };
}
