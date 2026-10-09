/** Public API of the copilot module. Code outside this module imports only from here (see apps/core/test/architecture.ts). */
export { setAiPolicy } from './commands';
export { getAiPolicy, viewAiPolicy } from './queries';
