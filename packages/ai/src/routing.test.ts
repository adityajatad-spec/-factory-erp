import { DATA_CLASSES, type DataClass } from '@factory-erp/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  estimateCostMicroInr,
  localityAllowed,
  route,
  type RouteRequest,
  type RouteState,
} from './routing';
import {
  CAPABILITIES,
  DEFAULT_POLICY,
  TASKS,
  type AiPolicy,
  type ModelInfo,
  type TaskPolicy,
} from './types';

// ── examples ──────────────────────────────────────────────────────────────────────────────

const local: ModelInfo = {
  id: 'local:small',
  providerId: 'local-runtime',
  locality: 'LOCAL',
  capabilities: ['chat', 'tools', 'structured'],
  contextTokens: 32_000,
  priceInPerMTokMicroInr: 0n,
  priceOutPerMTokMicroInr: 0n,
};
const cloud: ModelInfo = {
  id: 'cloud:large',
  providerId: 'cloud-a',
  locality: 'CLOUD',
  capabilities: ['chat', 'tools', 'structured', 'vision'],
  contextTokens: 200_000,
  priceInPerMTokMicroInr: 250_000_000n, // ₹250 per million input tokens (illustrative data)
  priceOutPerMTokMicroInr: 1_000_000_000n,
};
const healthy: RouteState = {
  models: [local, cloud],
  providers: [
    { providerId: 'local-runtime', healthy: true, circuitOpen: false },
    { providerId: 'cloud-a', healthy: true, circuitOpen: false },
  ],
  qualifications: [
    { modelId: 'local:small', task: 'copilot.answer', p95LatencyMs: 4_000 },
    { modelId: 'cloud:large', task: 'copilot.answer', p95LatencyMs: 2_000 },
    { modelId: 'cloud:large', task: 'doc.extract.handwritten', p95LatencyMs: 6_000 },
  ],
  cloudSpentThisMonthMicroInr: 0n,
};
const hybrid: AiPolicy = {
  version: 3,
  mode: 'HYBRID',
  cloudEnabled: true,
  monthlyCloudBudgetMicroInr: 2_000_000_000n, // ₹2,000
  tasks: {
    'copilot.answer': {
      maxLocalDataClass: 'CONFIDENTIAL',
      maxCloudDataClass: 'INTERNAL',
      preference: 'LOCAL_FIRST',
      fallback: true,
    },
    'doc.extract.handwritten': {
      maxLocalDataClass: 'RESTRICTED',
      maxCloudDataClass: 'RESTRICTED',
      allowRestrictedToCloud: true,
      preference: 'LOCAL_FIRST',
      fallback: true,
    },
  },
};
const ask = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  task: 'copilot.answer',
  dataClass: 'INTERNAL',
  capabilities: ['chat', 'tools'],
  estimatedInputTokens: 2_000,
  estimatedOutputTokens: 500,
  ...over,
});

describe('route — examples', () => {
  it('the default policy keeps AI off (local only, nothing enabled)', () => {
    expect(route(ask(), DEFAULT_POLICY, healthy)).toMatchObject({
      ok: false,
      reason: 'POLICY_BLOCKED',
    });
  });

  it('hybrid: routine questions go local first, with the cloud as fallback', () => {
    const r = route(ask(), hybrid, healthy);
    expect(r.ok && r.candidates.map((c) => c.modelId)).toEqual(['local:small', 'cloud:large']);
  });

  it('hybrid: confidential data stays local — the cloud is not even a fallback', () => {
    const r = route(ask({ dataClass: 'CONFIDENTIAL' }), hybrid, healthy);
    expect(r.ok && r.candidates.map((c) => c.modelId)).toEqual(['local:small']);
  });

  it('a handwritten bill goes to the approved cloud model when no local model qualifies', () => {
    const r = route(
      ask({ task: 'doc.extract.handwritten', dataClass: 'RESTRICTED', capabilities: ['vision'] }),
      hybrid,
      healthy,
    );
    expect(r.ok && r.candidates.map((c) => c.modelId)).toEqual(['cloud:large']);
  });

  it('local mode never uses the cloud, whatever the task allows', () => {
    const r = route(ask(), { ...hybrid, mode: 'LOCAL' }, healthy);
    expect(r.ok && r.candidates.map((c) => c.locality)).toEqual(['LOCAL']);
  });

  it('says why when nothing qualifies: unavailable, or over budget', () => {
    const down: RouteState = {
      ...healthy,
      providers: healthy.providers.map((p) => ({ ...p, healthy: false })),
    };
    expect(route(ask(), hybrid, down)).toMatchObject({ ok: false, reason: 'AI_UNAVAILABLE' });
    const noLocal: RouteState = { ...healthy, models: [cloud] };
    expect(route(ask({ maxCostMicroInr: 1n }), hybrid, noLocal)).toMatchObject({
      ok: false,
      reason: 'BUDGET_EXCEEDED',
    });
  });

  it('estimates cost in whole micro-rupees, rounding up', () => {
    // 2,000 × 250,000,000 + 500 × 1,000,000,000 = 1,000,000,000,000 → 1,000,000 µ₹ (₹1)
    expect(estimateCostMicroInr(cloud, 2_000, 500)).toBe(1_000_000n);
    expect(estimateCostMicroInr(cloud, 1, 0)).toBe(250n);
    expect(estimateCostMicroInr({ ...cloud, priceInPerMTokMicroInr: 1n }, 1, 0)).toBe(1n);
  });
});

// ── properties ────────────────────────────────────────────────────────────────────────────

const dataClassArb = fc.constantFrom<DataClass>(...DATA_CLASSES);
const PROVIDERS = ['p-local', 'p-cloud-a', 'p-cloud-b'];
const modelArb = fc.record({
  providerId: fc.constantFrom(...PROVIDERS),
  locality: fc.constantFrom<'LOCAL' | 'CLOUD'>('LOCAL', 'CLOUD'),
  capabilities: fc.subarray([...CAPABILITIES], { minLength: 2 }),
  contextTokens: fc.integer({ min: 1_000, max: 200_000 }),
  priceInPerMTokMicroInr: fc.bigInt({ min: 0n, max: 5_000_000_000n }),
  priceOutPerMTokMicroInr: fc.bigInt({ min: 0n, max: 5_000_000_000n }),
});
const stateArb: fc.Arbitrary<RouteState> = fc
  .array(modelArb, { minLength: 1, maxLength: 6 })
  .chain((ms) => {
    const models: ModelInfo[] = ms.map((m, i) => ({ ...m, id: `m${i}` }));
    return fc.record({
      models: fc.constant(models),
      providers: fc.subarray(PROVIDERS, { minLength: 3 }).chain((present) =>
        fc.tuple(
          ...present.map((providerId) =>
            fc.record({
              providerId: fc.constant(providerId),
              // Mostly up, sometimes down or tripped — both paths must be exercised.
              healthy: fc.constantFrom(true, true, true, false),
              circuitOpen: fc.constantFrom(false, false, false, true),
            }),
          ),
        ),
      ),
      qualifications: fc
        .subarray(models.flatMap((m) => TASKS.map((task) => ({ modelId: m.id, task }))))
        .chain((qs) =>
          fc.tuple(
            ...qs.map((q) =>
              fc.integer({ min: 50, max: 8_000 }).map((p95LatencyMs) => ({ ...q, p95LatencyMs })),
            ),
          ),
        ),
      cloudSpentThisMonthMicroInr: fc.bigInt({ min: 0n, max: 1_000_000_000n }),
    });
  });
const taskPolicyArb: fc.Arbitrary<TaskPolicy> = fc
  .record({
    // Local limits are usually generous (data stays on the node); cloud limits vary widely.
    maxLocalDataClass: fc.constantFrom<DataClass>(
      'INTERNAL',
      'CONFIDENTIAL',
      'CONFIDENTIAL',
      'RESTRICTED',
    ),
    maxCloudDataClass: fc.option(dataClassArb, { nil: null, freq: 4 }),
    allowRestrictedToCloud: fc.boolean(),
    preference: fc.constantFrom<'LOCAL_FIRST' | 'CLOUD_FIRST'>('LOCAL_FIRST', 'CLOUD_FIRST'),
    fallback: fc.boolean(),
    pin: fc.integer({ min: 0, max: 23 }), // one policy in six pins a model (m3 may not exist)
  })
  .map(({ pin, ...rest }) => (pin <= 3 ? { ...rest, pinnedModelId: `m${pin}` } : rest));
const policyArb: fc.Arbitrary<AiPolicy> = fc.record({
  version: fc.nat(),
  mode: fc.constantFrom<AiPolicy['mode']>('LOCAL', 'CLOUD', 'HYBRID', 'HYBRID'),
  cloudEnabled: fc.constantFrom(true, true, false),
  tasks: fc.dictionary(fc.constantFrom(...TASKS), taskPolicyArb),
  monthlyCloudBudgetMicroInr: fc.bigInt({ min: 0n, max: 5_000_000_000n }),
});
const requestArb: fc.Arbitrary<RouteRequest> = fc.record(
  {
    task: fc.constantFrom(...TASKS),
    dataClass: dataClassArb,
    capabilities: fc.subarray([...CAPABILITIES], { maxLength: 1 }),
    estimatedInputTokens: fc.integer({ min: 0, max: 20_000 }),
    estimatedOutputTokens: fc.integer({ min: 0, max: 4_000 }),
    maxCostMicroInr: fc.bigInt({ min: 0n, max: 2_000_000_000n }),
    maxLatencyMs: fc.integer({ min: 2_000, max: 30_000 }),
  },
  {
    requiredKeys: [
      'task',
      'dataClass',
      'capabilities',
      'estimatedInputTokens',
      'estimatedOutputTokens',
    ],
  },
);
/** Usually the requested task has a policy (otherwise AI is simply off for it). */
const scenario = fc
  .tuple(requestArb, policyArb, stateArb, taskPolicyArb, fc.integer({ min: 0, max: 4 }))
  .map(([req, policy, state, taskPolicy, dice]): [RouteRequest, AiPolicy, RouteState] => [
    req,
    dice === 0 ? policy : { ...policy, tasks: { ...policy.tasks, [req.task]: taskPolicy } },
    state,
  ]);
const RUNS = { numRuns: 3_000 };

function candidatesOf(req: RouteRequest, policy: AiPolicy, state: RouteState) {
  const r = route(req, policy, state);
  return r.ok ? r.candidates : [];
}

describe('route — invariants (property tests)', () => {
  it('RESTRICTED data reaches the cloud only with both explicit owner decisions', () => {
    fc.assert(
      fc.property(scenario, ([req, policy, state]) => {
        const restricted = { ...req, dataClass: 'RESTRICTED' as const };
        const task = policy.tasks[req.task];
        for (const c of candidatesOf(restricted, policy, state)) {
          if (c.locality !== 'CLOUD') continue;
          expect(policy.cloudEnabled).toBe(true);
          expect(policy.mode).not.toBe('LOCAL');
          expect(task?.allowRestrictedToCloud).toBe(true);
          expect(task?.maxCloudDataClass).toBe('RESTRICTED');
        }
      }),
      RUNS,
    );
  });

  it('fails closed: no task policy, or no models registered, never routes', () => {
    fc.assert(
      fc.property(scenario, ([req, policy, state]) => {
        const { [req.task]: _dropped, ...others } = policy.tasks;
        expect(route(req, { ...policy, tasks: others }, state).ok).toBe(false);
        expect(route(req, policy, { ...state, models: [] }).ok).toBe(false);
      }),
      RUNS,
    );
  });

  it('a policy with the cloud disabled never selects a cloud model', () => {
    fc.assert(
      fc.property(scenario, ([req, policy, state]) => {
        const off = { ...policy, cloudEnabled: false };
        expect(candidatesOf(req, off, state).filter((c) => c.locality === 'CLOUD')).toEqual([]);
      }),
      RUNS,
    );
  });

  it('local-only mode never selects a cloud model', () => {
    fc.assert(
      fc.property(scenario, ([req, policy, state]) => {
        const localOnly = { ...policy, mode: 'LOCAL' as const };
        expect(candidatesOf(req, localOnly, state).filter((c) => c.locality === 'CLOUD')).toEqual(
          [],
        );
      }),
      RUNS,
    );
  });

  it('an unavailable provider (down, circuit open, or unknown) is never selected', () => {
    fc.assert(
      fc.property(scenario, ([req, policy, state]) => {
        for (const c of candidatesOf(req, policy, state)) {
          const p = state.providers.find((x) => x.providerId === c.providerId);
          expect(p?.healthy).toBe(true);
          expect(p?.circuitOpen).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it('no fallback ever violates the data-class policy — every candidate is allowed, not just the first', () => {
    fc.assert(
      fc.property(scenario, ([req, policy, state]) => {
        const task = policy.tasks[req.task];
        for (const c of candidatesOf(req, policy, state)) {
          expect(task).toBeDefined();
          if (task) expect(localityAllowed(policy, task, c.locality, req.dataClass)).toBeNull();
        }
      }),
      RUNS,
    );
  });

  it('every candidate has the capabilities, qualification, cost and latency the request needs', () => {
    fc.assert(
      fc.property(scenario, ([req, policy, state]) => {
        for (const c of candidatesOf(req, policy, state)) {
          const m = state.models.find((x) => x.id === c.modelId);
          expect(m).toBeDefined();
          if (!m) continue;
          for (const cap of req.capabilities) expect(m.capabilities).toContain(cap);
          expect(state.qualifications.some((q) => q.modelId === m.id && q.task === req.task)).toBe(
            true,
          );
          if (req.maxCostMicroInr !== undefined)
            expect(c.estimatedCostMicroInr <= req.maxCostMicroInr).toBe(true);
          if (req.maxLatencyMs !== undefined)
            expect(c.p95LatencyMs).toBeLessThanOrEqual(req.maxLatencyMs);
          if (c.locality === 'CLOUD')
            expect(
              state.cloudSpentThisMonthMicroInr + c.estimatedCostMicroInr <=
                policy.monthlyCloudBudgetMicroInr,
            ).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('is deterministic: identical inputs, in any order, give an identical decision', () => {
    fc.assert(
      fc.property(scenario, fc.integer(), ([req, policy, state], seed) => {
        const shuffle = <T>(xs: readonly T[]) =>
          [...xs]
            .map((x, i) => ({ x, k: (i * 7919 + seed) % 104_729 }))
            .sort((a, b) => a.k - b.k)
            .map((p) => p.x);
        const once = route(req, policy, state);
        expect(route(req, policy, state)).toEqual(once);
        const shuffled: RouteState = {
          ...state,
          models: shuffle(state.models),
          providers: shuffle(state.providers),
          qualifications: shuffle(state.qualifications),
        };
        expect(route(req, policy, shuffled)).toEqual(once);
      }),
      RUNS,
    );
  });

  it('accounts for every model exactly once, and offers no fallback when fallback is off', () => {
    fc.assert(
      fc.property(scenario, ([req, policy, state]) => {
        const r = route(req, policy, state);
        const task = policy.tasks[req.task];
        if (r.ok && task && !task.fallback) expect(r.candidates.length).toBe(1);
        if (r.ok && task?.fallback) {
          const seen = [...r.candidates.map((c) => c.modelId), ...r.excluded.map((e) => e.modelId)];
          expect(seen.sort()).toEqual(state.models.map((m) => m.id).sort());
        }
      }),
      RUNS,
    );
  });
});

describe('route — the properties are not vacuous', () => {
  it('random scenarios regularly produce local, cloud and RESTRICTED-to-cloud candidates', () => {
    const samples = fc.sample(scenario, { numRuns: 3_000, seed: 42 });
    let any = 0;
    let cloudCount = 0;
    let restrictedCloud = 0;
    for (const [req, policy, state] of samples) {
      const cs = candidatesOf(req, policy, state);
      if (cs.length) any++;
      if (cs.some((c) => c.locality === 'CLOUD')) cloudCount++;
      const rcs = candidatesOf({ ...req, dataClass: 'RESTRICTED' }, policy, state);
      if (rcs.some((c) => c.locality === 'CLOUD')) restrictedCloud++;
    }
    // Measured with this seed: 335 / 63 / 15 of 3,000 — each property sees real routings.
    expect(any).toBeGreaterThan(250);
    expect(cloudCount).toBeGreaterThan(40);
    expect(restrictedCloud).toBeGreaterThan(8);
  });
});
