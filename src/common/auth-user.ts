import { Role } from '@prisma/client';

/** The signed-in user, as carried in the access token. */
export interface AuthUser {
  id: string;
  role: Role;
  schoolId: string | null;
  /** The LGA an LGA officer or inspector oversees; null for everyone else and for state-wide inspectors. */
  lga: string | null;
  mustChangePassword: boolean;
}
