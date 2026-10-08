/** Public API of the documents module. Code outside this module imports only from here (see apps/core/test/architecture.ts). */
export { getDocumentContentQuery, type DocumentContent } from './queries';
export { recordDocument, type DocumentKind } from './store';
export { accessRuleFor, DOCUMENT_ACCESS, UNREADABLE_KINDS } from './access';
