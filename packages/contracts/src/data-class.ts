import { z } from 'zod';

/**
 * How sensitive a piece of data is (docs/ROADMAP.md §5.5). The AI gateway routes on it; the
 * command bus keeps RESTRICTED fields out of idempotency hashes; logs never carry them.
 *
 * - PUBLIC: reference data anyone may see (states, units).
 * - INTERNAL: ordinary operating data (items, company profile).
 * - CONFIDENTIAL: financials, customer data, audit history.
 * - RESTRICTED: credentials and bank account details — never sent to any model by default.
 */
export const DATA_CLASSES = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

const RANK: Record<DataClass, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3 };

/** The more sensitive of the given classes (the "high-water mark"). */
export function maxDataClass(...classes: readonly DataClass[]): DataClass {
  return classes.reduce<DataClass>((a, b) => (RANK[b] > RANK[a] ? b : a), 'PUBLIC');
}

/** True when `value` is no more sensitive than `limit`. */
export function withinDataClass(value: DataClass, limit: DataClass): boolean {
  return RANK[value] <= RANK[limit];
}

/** Field-level classification of request schemas. */
export const fieldClasses = z.registry<{ dataClass: DataClass }>();

/** Mark one field of a request schema RESTRICTED (a password, a bank account number). */
export function restricted<T extends z.ZodType>(schema: T): T {
  fieldClasses.add(schema, { dataClass: 'RESTRICTED' });
  return schema;
}

interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  innerType?: z.ZodType;
  in?: z.ZodType;
  element?: z.ZodType;
  options?: readonly z.ZodType[];
}
const defOf = (s: z.ZodType) => (s as unknown as { _zod: { def: Def } })._zod.def;

/** Look through wrappers (optional, nullable, default, transform …) to the field itself. */
function unwrap(s: z.ZodType): z.ZodType[] {
  const d = defOf(s);
  if (d.innerType) return [s, ...unwrap(d.innerType)];
  if (d.type === 'pipe' && d.in) return [s, ...unwrap(d.in)];
  return [s];
}

const isRestricted = (s: z.ZodType) =>
  unwrap(s).some((x) => fieldClasses.get(x)?.dataClass === 'RESTRICTED');

/** Dotted paths of every RESTRICTED field in a schema, e.g. ["password", "lines[].pin"]. */
export function restrictedPaths(schema: z.ZodType, prefix = ''): string[] {
  const paths: string[] = [];
  for (const s of unwrap(schema)) {
    const d = defOf(s);
    if (d.type === 'object' && d.shape) {
      for (const [key, field] of Object.entries(d.shape)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (isRestricted(field)) paths.push(path);
        else paths.push(...restrictedPaths(field, path));
      }
    } else if (d.type === 'array' && d.element) {
      paths.push(...restrictedPaths(d.element, `${prefix}[]`));
    } else if (d.type === 'union' && d.options) {
      for (const o of d.options) paths.push(...restrictedPaths(o, prefix));
    }
  }
  return [...new Set(paths)];
}

/** A copy of `value` without the RESTRICTED fields that `schema` declares. */
export function omitRestricted(schema: z.ZodType, value: unknown): unknown {
  const paths = restrictedPaths(schema).map((p) => p.split('.'));
  const strip = (v: unknown, path: readonly string[]): unknown => {
    const [head, ...rest] = path;
    if (head === undefined || v === null || typeof v !== 'object') return v;
    if (head.endsWith('[]')) {
      const key = head.slice(0, -2);
      const container = key ? (v as Record<string, unknown>)[key] : v;
      if (!Array.isArray(container)) return v;
      const mapped = container.map((x) => strip(x, rest));
      return key ? { ...v, [key]: mapped } : mapped;
    }
    const obj = v as Record<string, unknown>;
    if (!(head in obj)) return v;
    if (rest.length === 0) {
      const { [head]: _omitted, ...others } = obj;
      return others;
    }
    return { ...obj, [head]: strip(obj[head], rest) };
  };
  return paths.reduce<unknown>((acc, p) => strip(acc, p), value);
}
