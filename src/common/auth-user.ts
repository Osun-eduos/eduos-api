import { Role } from '@prisma/client';

/** The signed-in user, as carried in the access token. */
export interface AuthUser {
  id: string;
  role: Role;
  schoolId: string | null;
  /** The LGA an LGA officer or inspector oversees; null for everyone else and for state-wide inspectors. */
  lga: string | null;
  mustChangePassword: boolean;
  /** This session passed two-step sign-in. */
  twoStepVerified?: boolean;
  /** Two-step sign-in is required for this role and has not been completed: only set-up is allowed. */
  twoStepPending?: boolean;
}
