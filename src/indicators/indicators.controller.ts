import { BadRequestException, Controller, Get, Query, Req, Res } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { LGA_NAMES } from '../common/lgas';
import { OVERSIGHT_ROLES } from '../common/roles';
import { DEFINITIONS, IndicatorsService } from './indicators.service';
import { fileName, toCsv, toPdf, toXlsx } from './export';

class IndicatorQuery {
  @IsOptional() @IsUUID() sessionId?: string;
  @IsOptional() @IsUUID() termId?: string;
  @IsOptional() @IsString() @MaxLength(40) lga?: string;
}

class ExportQuery extends IndicatorQuery {
  @IsIn(['csv', 'xlsx', 'pdf'], { message: 'Choose csv, xlsx or pdf.' }) format: 'csv' | 'xlsx' | 'pdf';
}

const TYPES = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' };

/** Education indicators for the Ministry, LGAs and inspectors, with exports for reports and returns. */
@Controller('indicators')
@Roles(...OVERSIGHT_ROLES)
export class IndicatorsController {
  constructor(private readonly indicators: IndicatorsService, private readonly audit: AuditService) {}

  private check(q: IndicatorQuery) {
    if (q.lga && !LGA_NAMES.includes(q.lga)) throw new BadRequestException(`${q.lga} is not an Osun LGA.`);
  }

  @Get()
  get(@CurrentUser() me: AuthUser, @Query() q: IndicatorQuery) {
    this.check(q);
    return this.indicators.indicators(me, q);
  }

  @Get('trends')
  trends(@CurrentUser() me: AuthUser, @Query() q: IndicatorQuery) {
    this.check(q);
    return this.indicators.trends(me, q);
  }

  @Get('definitions')
  definitions() {
    return DEFINITIONS;
  }

  @Get('export')
  async export(@CurrentUser() me: AuthUser, @Query() q: ExportQuery, @Req() req: Request, @Res() res: Response) {
    this.check(q);
    const report = await this.indicators.indicators(me, q);
    const trend = q.format === 'csv' ? { bySession: [] } : await this.indicators.trends(me, q);
    const body = q.format === 'csv' ? Buffer.from(toCsv(report), 'utf8') : q.format === 'xlsx' ? toXlsx(report, trend) : await toPdf(report, trend);
    await this.audit.record({ actorId: me.id, action: 'indicators.exported', targetType: 'indicators', targetId: report.scope.label, meta: { format: q.format, session: report.session.name, term: report.term?.name ?? null }, ip: req.ip });
    res.set({ 'Content-Type': TYPES[q.format], 'Content-Disposition': `attachment; filename="${fileName(report, q.format)}"`, 'Cache-Control': 'no-store' });
    res.send(body);
  }
}
