import { PERMISSIONS, type UserDto } from '@factory-erp/contracts';
import { z } from 'zod';
import { defineQuery } from '../../platform/queries';
import { selectUsers, toUserDto } from './user-dto';

export const listUsers = defineQuery({
  name: 'identity.users.list',
  description: 'List the sign-ins of this company with their roles, status and recent sign-ins.',
  input: z.object({}),
  permission: PERMISSIONS.userManage,
  ai: { tier: 'FORBIDDEN' },
  dataClass: 'CONFIDENTIAL',
  handler: async ({ db, companyId, now }): Promise<UserDto[]> => {
    const rows = await selectUsers(db, companyId, now).orderBy('u.username').execute();
    return rows.map(toUserDto);
  },
});
