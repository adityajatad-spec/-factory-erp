import { AppError, BusinessRuleError, DuplicateError } from './errors';

interface PgError {
  code: string;
  constraint?: string;
  message: string;
}

function isPgError(err: unknown): err is PgError {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    'severity' in err
  );
}

/**
 * Translate database constraint failures into client-safe errors. The database is the last
 * line of defence; reaching one of these usually means a missing application-level check.
 */
export function translateDbError(err: unknown): unknown {
  if (err instanceof AppError || !isPgError(err)) return err;
  switch (err.code) {
    case '23505':
      return new DuplicateError(
        `A record with the same unique value already exists (${err.constraint ?? 'unique'})`,
      );
    case '23503':
      return new BusinessRuleError('REFERENCE_INVALID', 'A referenced record does not exist');
    case '23514':
      return new BusinessRuleError(
        'CONSTRAINT_VIOLATION',
        `Data rule violated (${err.constraint ?? 'check'})`,
      );
    case 'FO001':
      return new BusinessRuleError(
        'APPEND_ONLY',
        'This record is part of an append-only ledger and cannot be changed',
      );
    case 'FO002':
      return new BusinessRuleError('DOCUMENT_IMMUTABLE', err.message);
    case 'FO003':
      return new BusinessRuleError('ALLOCATION_INVALID', err.message);
    case 'FO004':
      return new BusinessRuleError('CREDIT_NOTE_INVALID', err.message);
    case 'FO005':
      return new BusinessRuleError('SUPPLIER_ALLOCATION_INVALID', err.message);
    case 'FO006':
      return new BusinessRuleError('GOODS_RECEIPT_INVALID', err.message);
    default:
      return err;
  }
}
