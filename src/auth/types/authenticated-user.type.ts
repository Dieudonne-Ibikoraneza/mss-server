import { Role } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  role: Role;
  email: string | null;
  phone: string | null;
}
