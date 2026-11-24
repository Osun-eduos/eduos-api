import { Role } from '@prisma/client';

/** The signed-in user, as carried in the access token. */
export interface AuthUser {
  id: string;
  role: Role;
  schoolId: string | null;
  mustChangePassword: boolean;
}
