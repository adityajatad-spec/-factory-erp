import { PERMISSIONS, type CompanyDto, type StateDto } from '@factory-erp/contracts';
import { z } from 'zod';
import { NotFoundError } from '../../platform/errors';
import { defineQuery } from '../../platform/queries';

const FINANCE_READINESS = ['DEVELOPMENT', 'CA_REVIEW', 'PARALLEL_RUN', 'PRODUCTION'] as const;

export const getCompany = defineQuery({
  name: 'company.get',
  description: "Get the signed-in user's company profile.",
  input: z.object({}),
  permission: PERMISSIONS.companyRead,
  ai: { tier: 'READ' },
  dataClass: 'INTERNAL',
  handler: async ({ db, companyId }): Promise<CompanyDto> => {
    const c = await db
      .selectFrom('platform.companies as c')
      .innerJoin('platform.states as s', 's.code', 'c.stateCode')
      .select([
        'c.id',
        'c.legalName',
        'c.tradeName',
        'c.gstin',
        'c.stateCode',
        's.name as stateName',
        'c.addressLine1',
        'c.addressLine2',
        'c.city',
        'c.postalCode',
        'c.phone',
        'c.email',
        'c.isDemo',
        'c.financeReadiness',
      ])
      .where('c.id', '=', companyId)
      .executeTakeFirst();
    if (!c) throw new NotFoundError('Company');
    const readiness = FINANCE_READINESS.find((r) => r === c.financeReadiness) ?? 'DEVELOPMENT';
    return { ...c, financeReadiness: readiness };
  },
});

export const listStates = defineQuery({
  name: 'reference.states.list',
  description: 'List GST state codes (reference data, pending official verification).',
  input: z.object({}),
  permission: PERMISSIONS.companyRead,
  ai: { tier: 'READ' },
  dataClass: 'PUBLIC', // national reference data
  handler: async ({ db }): Promise<StateDto[]> =>
    db.selectFrom('platform.states').select(['code', 'name']).orderBy('name').execute(),
});
