/** Public API of the identity module. Code outside this module imports only from here (see apps/core/test/architecture.ts). */
export { AuthService } from './auth-service';
export { hashPassword, verifyPassword } from './password';
export { loadAccess, resolveSession, SESSION_COOKIE } from './sessions';
export {
  changeOwnPassword,
  createUser,
  deactivateUser,
  reactivateUser,
  resetUserPassword,
  setUserRoles,
} from './admin';
export { listUsers } from './user-queries';
