import { describe, expect, it } from 'vitest';
import { BusinessRuleError } from './errors';
import { publicJobError, serializeErrorForLog } from './safe-errors';

/** Shaped like node-postgres' DatabaseError, with row values in `detail` and SQL in `where`. */
function pgError(): Error {
  return Object.assign(new Error('invalid input syntax for type uuid: "SECRET-VALUE"'), {
    code: '22P02',
    severity: 'ERROR',
    detail: 'Failing row contains (SECRET-VALUE)',
    where: 'SQL statement "select SECRET-VALUE"',
    internalQuery: 'select SECRET-VALUE',
    hint: 'SECRET-VALUE',
    constraint: 'warehouses_code_check',
    table: 'warehouses',
    column: 'code',
  });
}

describe('serializeErrorForLog', () => {
  it('reduces a PostgreSQL error to its SQLSTATE, table and column', () => {
    expect(serializeErrorForLog(pgError())).toEqual({
      type: 'Error',
      code: '22P02',
      severity: 'ERROR',
      table: 'warehouses',
      column: 'code',
    });
  });

  it('applies the same rule to a database error wrapped as a cause', () => {
    const wrapped = new Error('could not load', { cause: pgError() });
    const twice = new Error('report failed', { cause: wrapped });
    const out = serializeErrorForLog(twice);
    expect(out).toMatchObject({
      message: 'report failed',
      cause: { message: 'could not load', cause: { code: '22P02', table: 'warehouses' } },
    });
    expect(JSON.stringify(out)).not.toContain('SECRET-VALUE');
    expect(JSON.stringify(out)).not.toContain('warehouses_code_check');
  });

  it('keeps no arbitrary properties of other errors', () => {
    const err = Object.assign(new Error('request failed'), {
      code: 'ECONNREFUSED',
      config: { headers: { authorization: 'Bearer SECRET-VALUE' } },
    });
    const out = serializeErrorForLog(err);
    expect(Object.keys(out).sort()).toEqual(['code', 'message', 'stack', 'type']);
    expect(serializeErrorForLog('a string')).toEqual({ type: 'string' });
  });
});

describe('publicJobError', () => {
  it('passes client-safe application messages, and only the class and code of anything else', () => {
    expect(publicJobError(new BusinessRuleError('X', 'The invoice is cancelled'))).toBe(
      'The invoice is cancelled',
    );
    expect(publicJobError(pgError())).toBe(
      'The job failed (Error 22P02). Details are in the server log.',
    );
    expect(publicJobError(new TypeError('cannot read SECRET-VALUE'))).toBe(
      'The job failed (TypeError). Details are in the server log.',
    );
    expect(publicJobError('SECRET-VALUE')).toBe('The job failed. Details are in the server log.');
  });
});
