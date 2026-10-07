import { CreatePartyRequest, PERMISSIONS, type PartyDto } from '@factory-erp/contracts';
import { defineCommand } from '../../platform/commands';
import { BusinessRuleError, DuplicateError } from '../../platform/errors';
import { uuidv7 } from '../../platform/ids';
import { selectParties, toPartyDto } from './party-dto';

export const createParty = defineCommand({
  name: 'parties.create',
  description: 'Create a customer and/or supplier.',
  input: CreatePartyRequest,
  permission: PERMISSIONS.partyCreate,
  ai: { tier: 'CONFIRM' },
  handler: async ({ tx, actor, companyId, now }, input) => {
    const state = await tx
      .selectFrom('platform.states')
      .select('code')
      .where('code', '=', input.stateCode)
      .executeTakeFirst();
    if (!state)
      throw new BusinessRuleError('UNKNOWN_STATE', `Unknown state code ${input.stateCode}`);

    const clash = await tx
      .selectFrom('party.parties')
      .select(['code', 'gstin'])
      .where('companyId', '=', companyId)
      .where((eb) =>
        eb.or([
          eb('code', '=', input.code),
          ...(input.gstin ? [eb('gstin', '=', input.gstin)] : []),
        ]),
      )
      .executeTakeFirst();
    if (clash?.code === input.code)
      throw new DuplicateError(`Party code ${input.code} is already in use`);
    if (clash) throw new DuplicateError(`A party with GSTIN ${input.gstin ?? ''} already exists`);

    const id = uuidv7(now.getTime());
    await tx
      .insertInto('party.parties')
      .values({
        id,
        companyId,
        code: input.code,
        name: input.name,
        isCustomer: input.isCustomer,
        isSupplier: input.isSupplier,
        gstin: input.gstin,
        stateCode: input.stateCode,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        postalCode: input.postalCode,
        contactName: input.contactName,
        phone: input.phone,
        email: input.email,
        creditDays: input.creditDays,
        createdAt: now,
        updatedAt: now,
        createdBy: actor.user.id,
        updatedBy: actor.user.id,
      })
      .execute();

    const party: PartyDto = toPartyDto(
      await selectParties(tx, companyId, false).where('p.id', '=', id).executeTakeFirstOrThrow(),
    );
    return {
      result: party,
      audit: [
        { entityType: 'party', entityId: id, after: { ...party, receivableBalance: undefined } },
      ],
    };
  },
});
