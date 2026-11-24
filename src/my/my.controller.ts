import { Controller, Get } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { StudentsService } from '../students/students.service';

/** Personal views: a teacher's classes and a parent's children. */
@Controller('my')
export class MyController {
  constructor(private readonly students: StudentsService) {}

  @Get('classes')
  @Roles(Role.TEACHER)
  classes(@CurrentUser() me: AuthUser) {
    return this.students.myClasses(me);
  }

  @Get('children')
  @Roles(Role.PARENT)
  children(@CurrentUser() me: AuthUser) {
    return this.students.myChildren(me);
  }
}
