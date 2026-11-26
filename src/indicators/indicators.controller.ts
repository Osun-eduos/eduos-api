import { BadRequestException, Body, Controller, Get, Put, Query, Req, Res } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { LGA_NAMES } from '../common/lgas';
import { OVERSIGHT_ROLES } from '../common/roles';
import { DEFINITIONS, IndicatorsService, STAGES } from './indicators.service';
import { fileName, toCsv, toPdf, toXlsx } from './export';

class IndicatorQuery {
  @IsOptional() @IsUUID() sessionId?: string;
  @IsOptional() @IsUUID() termId?: string;
  @IsOptional() @IsString() @MaxLength(40) lga?: string;
}

class CompareQuery {
  @IsOptional() @IsString() @MaxLength(130) lgas?: string;
  @IsOptional() @IsUUID() termId?: string;
}

class PopulationQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year?: number;
}

class PopulationRowDto {
  @IsIn(LGA_NAMES, { message: 'Choose one of the 30 Osun State LGAs.' }) lga!: string;
  @IsIn(STAGES.map((s) => s.key)) stage!: string;
  @IsInt() @Min(0) @Max(2_000_000) male!: number;
  @IsInt() @Min(0) @Max(2_000_000) female!: number;
  @IsOptional() @IsString() @MaxLength(120) source?: string;
}

class PopulationDto {
  @IsInt() @Min(2000) @Max(2100) year!: number;
  @IsArray() @ArrayMaxSize(120) @ValidateNested({ each: true }) @Type(() => PopulationRowDto) rows!: PopulationRowDto[];
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

  @Get('access')
  access(@CurrentUser() me: AuthUser, @Query() q: IndicatorQuery) {
    this.check(q);
    return this.indicators.access(me, q);
  }

  @Get('compare')
  compare(@CurrentUser() me: AuthUser, @Query() q: CompareQuery) {
    for (const l of (q.lgas ?? '').split(',').map((x) => x.trim()).filter(Boolean)) if (!LGA_NAMES.includes(l)) throw new BadRequestException(`${l} is not an Osun LGA.`);
    return this.indicators.compare(me, q);
  }

  @Get('overview')
  overview(@CurrentUser() me: AuthUser, @Query() q: IndicatorQuery) {
    this.check(q);
    return this.indicators.overview(me, q);
  }

  @Get('population')
  population(@CurrentUser() me: AuthUser, @Query() q: PopulationQuery) {
    return this.indicators.population(me, q.year);
  }

  @Put('population')
  @Roles(Role.MINISTRY_ADMIN)
  async savePopulation(@CurrentUser() me: AuthUser, @Body() dto: PopulationDto, @Req() req: Request) {
    const out = await this.indicators.savePopulation(me, dto.year, dto.rows);
    await this.audit.record({ actorId: me.id, action: 'population.saved', targetType: 'indicators', targetId: String(dto.year), meta: { rows: dto.rows.length }, ip: req.ip });
    return out;
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
