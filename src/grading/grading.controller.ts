import { Body, Controller, Delete, Get, Put, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { CREDIT_MARK, PASS_MARK } from '../common/results';
import { DEFAULT_GRADING, GradingService } from './grading.service';

class BandDto {
  @IsInt() @Min(0) @Max(100) min!: number;
  @IsString() @MaxLength(3) grade!: string;
  @IsString() @MaxLength(20) remark!: string;
}

class ScalesDto {
  @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => BandDto) BASIC!: BandDto[];
  @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => BandDto) SSS!: BandDto[];
}

@Controller('grading')
export class GradingController {
  constructor(private readonly grading: GradingService, private readonly audit: AuditService) {}

  @Get()
  async get() {
    return { scales: await this.grading.refresh(), defaults: DEFAULT_GRADING, passMark: PASS_MARK, creditMark: CREDIT_MARK };
  }

  /** Changes apply at once to score sheets, report cards, class analysis and the archive. */
  @Put()
  @Roles(Role.MINISTRY_ADMIN)
  async save(@CurrentUser() me: AuthUser, @Body() dto: ScalesDto, @Req() req: Request) {
    const scales = await this.grading.save(me.id, dto);
    await this.audit.record({ actorId: me.id, action: 'grading.updated', targetType: 'setting', targetId: 'grading', meta: { BASIC: scales.BASIC.map((b) => `${b.grade}≥${b.min}`).join(' '), SSS: scales.SSS.map((b) => `${b.grade}≥${b.min}`).join(' ') }, ip: req.ip ?? null });
    return { scales, defaults: DEFAULT_GRADING, passMark: PASS_MARK, creditMark: CREDIT_MARK };
  }

  @Delete()
  @Roles(Role.MINISTRY_ADMIN)
  async reset(@CurrentUser() me: AuthUser, @Req() req: Request) {
    const scales = await this.grading.reset();
    await this.audit.record({ actorId: me.id, action: 'grading.reset', targetType: 'setting', targetId: 'grading', ip: req.ip ?? null });
    return { scales, defaults: DEFAULT_GRADING, passMark: PASS_MARK, creditMark: CREDIT_MARK };
  }
}
