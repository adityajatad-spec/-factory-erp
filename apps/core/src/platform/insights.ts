import type { KpiDto, Permission } from '@factory-erp/contracts';
import type { Database } from '../db/database';

/**
 * The insights contract (docs/ARCHITECTURE.md §E.5). Business modules register KPIs backed
 * by real queries; the dashboard only composes them. A KPI cannot exist without a query.
 */
export interface KpiDefinition {
  id: string;
  label: string;
  unit: KpiDto['unit'];
  definition: string;
  /** The viewer must hold this permission, or the KPI is omitted. */
  permission: Permission;
  compute(ctx: { db: Database; companyId: string; businessDate: string }): Promise<string>;
}

export function defineKpi(def: KpiDefinition): KpiDefinition {
  return def;
}
