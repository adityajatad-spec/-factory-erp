import { z } from 'zod';
import type { Permission, RoleCode } from './permissions';

export const LoginRequest = z.object({
  username: z.string().trim().toLowerCase().min(3).max(64),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  roles: RoleCode[];
  permissions: Permission[];
  company: {
    id: string;
    legalName: string;
    tradeName: string | null;
    isDemo: boolean;
  };
}
