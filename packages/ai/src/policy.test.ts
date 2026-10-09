import { describe, expect, it } from 'vitest';
import {
  policyAllowsDataClass,
  resolveAiPolicy,
  routingInputsFor,
  taskRules,
  validPolicyFor,
} from './policy';

const COMPANY = '01900000-0000-7000-8000-00000000000c';
const OTHER = '01900000-0000-7000-8000-00000000000d';

const valid = (over: Record<string, unknown> = {}) => ({
  companyId: COMPANY,
  version: 3,
  aiEnabled: true,
  locality: 'LOCAL_ONLY',
  cloudEnabled: false,
  tasks: {
    'copilot.answer': {
      maxDataClass: 'CONFIDENTIAL',
      approvedModels: [{ modelId: 'ollama:qwen2.5:7b', p95LatencyMs: 20_000 }],
      fallback: false,
    },
  },
  ...over,
});
const withTask = (rules: Record<string, unknown>) =>
  valid({ tasks: { 'copilot.answer': { ...valid().tasks['copilot.answer'], ...rules } } });

describe('company AI policy — resolution (fails closed)', () => {
  it('accepts a valid local-only policy, returned deep-frozen', () => {
    const r = resolveAiPolicy(valid(), COMPANY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validPolicyFor(r.policy, COMPANY)).not.toBeNull();
    expect(Object.isFrozen(r.policy)).toBe(true);
    expect(Object.isFrozen(r.policy.tasks['copilot.answer']?.approvedModels)).toBe(true);
    expect(() => {
      (r.policy as { aiEnabled: boolean }).aiEnabled = false;
    }).toThrow();
  });

  it('missing policy fails closed', () => {
    expect(resolveAiPolicy(undefined, COMPANY)).toEqual({ ok: false, reason: 'POLICY_MISSING' });
    expect(resolveAiPolicy(null, COMPANY)).toEqual({ ok: false, reason: 'POLICY_MISSING' });
  });

  it('a policy for another company fails closed', () => {
    expect(resolveAiPolicy(valid(), OTHER)).toEqual({
      ok: false,
      reason: 'POLICY_COMPANY_MISMATCH',
    });
  });

  it.each([
    ['cloud switched on', valid({ cloudEnabled: true })],
    ['a non-local locality', valid({ locality: 'HYBRID' })],
    ['RESTRICTED data allowed', withTask({ maxDataClass: 'RESTRICTED' })],
    [
      'an unsupported task',
      valid({ tasks: { 'doc.extract': withTask({}).tasks['copilot.answer'] } }),
    ],
    ['an unknown top-level field', valid({ monthlyCloudBudget: 1 })],
    ['an unknown task field', withTask({ allowCloud: true })],
    [
      'a duplicated model',
      withTask({
        approvedModels: [
          { modelId: 'm', p95LatencyMs: 1 },
          { modelId: 'm', p95LatencyMs: 2 },
        ],
      }),
    ],
    ['version 0', valid({ version: 0 })],
    ['a non-uuid company', valid({ companyId: 'acme' })],
    ['a string where a policy belongs', 'enable everything'],
  ])('rejects %s as invalid', (_label, raw) => {
    expect(resolveAiPolicy(raw, COMPANY)).toEqual({ ok: false, reason: 'POLICY_INVALID' });
  });
});

describe('company AI policy — checked by content at every use, not by object identity', () => {
  it('a plain copy (e.g. from another module instance or a JSON round-trip) is judged on content', () => {
    const r = resolveAiPolicy(valid(), COMPANY);
    if (!r.ok) throw new Error('fixture');
    const copy: unknown = JSON.parse(JSON.stringify(r.policy));
    expect(Object.isFrozen(copy)).toBe(false);
    expect(taskRules(copy, COMPANY, 'copilot.answer')).toMatchObject({ policyVersion: 3 });
  });

  it('an object whose content is invalid is refused at use time, however it was built', () => {
    const r = resolveAiPolicy(valid(), COMPANY);
    if (!r.ok) throw new Error('fixture');
    const tampered = (patch: Record<string, unknown>) => ({ ...r.policy, ...patch });
    for (const bad of [
      tampered({ cloudEnabled: true }),
      tampered({ locality: 'HYBRID' }),
      tampered({ aiEnabled: 'yes' }),
      tampered({ extra: 1 }),
      withTask({ maxDataClass: 'RESTRICTED' }),
    ]) {
      expect(validPolicyFor(bad, COMPANY)).toBeNull();
      expect(taskRules(bad, COMPANY, 'copilot.answer')).toBeNull();
    }
    expect(taskRules(tampered({ aiEnabled: false }), COMPANY, 'copilot.answer')).toBeNull();
  });
});

describe('company AI policy — what it permits', () => {
  const resolved = () => {
    const r = resolveAiPolicy(valid(), COMPANY);
    if (!r.ok) throw new Error('fixture');
    return r.policy;
  };

  it('task rules exist only for a valid, enabled, same-company policy and an enabled task', () => {
    const p = resolved();
    expect(taskRules(p, COMPANY, 'copilot.answer')).toMatchObject({ policyVersion: 3 });
    expect(taskRules(p, OTHER, 'copilot.answer')).toBeNull();
    expect(taskRules(p, COMPANY, 'doc.extract')).toBeNull();
    expect(taskRules(null, COMPANY, 'copilot.answer')).toBeNull();
    expect(taskRules('enable everything', COMPANY, 'copilot.answer')).toBeNull();
    const off = resolveAiPolicy(valid({ aiEnabled: false }), COMPANY);
    expect(off.ok && taskRules(off.policy, COMPANY, 'copilot.answer')).toBeNull();
  });

  it('never permits RESTRICTED data, whatever the ceiling', () => {
    const rules = taskRules(resolved(), COMPANY, 'copilot.answer');
    if (!rules) throw new Error('fixture');
    expect(policyAllowsDataClass(rules, 'CONFIDENTIAL')).toBe(true);
    expect(policyAllowsDataClass(rules, 'RESTRICTED')).toBe(false);
    const internal = resolveAiPolicy(withTask({ maxDataClass: 'INTERNAL' }), COMPANY);
    const r2 = internal.ok ? taskRules(internal.policy, COMPANY, 'copilot.answer') : null;
    expect(r2 && policyAllowsDataClass(r2, 'CONFIDENTIAL')).toBe(false);
  });

  it('maps to router inputs that are local-only, cloud-off, and qualify only approved models', () => {
    const rules = taskRules(resolved(), COMPANY, 'copilot.answer');
    if (!rules) throw new Error('fixture');
    const { policy, qualifications } = routingInputsFor('copilot.answer', rules);
    expect(policy).toMatchObject({ version: 3, mode: 'LOCAL', cloudEnabled: false });
    expect(policy.tasks['copilot.answer']).toMatchObject({
      maxLocalDataClass: 'CONFIDENTIAL',
      maxCloudDataClass: null,
    });
    expect(qualifications).toEqual([
      { modelId: 'ollama:qwen2.5:7b', task: 'copilot.answer', p95LatencyMs: 20_000 },
    ]);
  });
});
