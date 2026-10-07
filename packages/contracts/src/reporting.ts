import { z } from 'zod';
import { Uuid } from './common';
import type { InvoiceListItemDto } from './sales';

/** A KPI value produced by a module's insights provider — never a hard-coded number. */
export interface KpiDto {
  id: string;
  label: string;
  value: string;
  unit: 'INR' | 'COUNT';
  /** Plain-language definition, shown as a tooltip. */
  definition: string;
}

export interface DashboardDto {
  businessDate: string;
  kpis: KpiDto[];
  recentInvoices: InvoiceListItemDto[] | null;
}

export const ListAuditEventsQuery = z.object({
  entityType: z.string().min(1).max(100),
  entityId: Uuid,
});
export type ListAuditEventsQuery = z.input<typeof ListAuditEventsQuery>;

export interface AuditEventDto {
  id: string;
  occurredAt: string;
  actorKind: 'user' | 'ai_agent' | 'system' | 'integration';
  actorName: string | null;
  command: string;
  entityType: string;
  entityId: string;
  summary: string;
}

export interface StateDto {
  code: string;
  name: string;
}

export interface CompanyDto {
  id: string;
  legalName: string;
  tradeName: string | null;
  gstin: string | null;
  stateCode: string;
  stateName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  postalCode: string;
  phone: string | null;
  email: string | null;
  isDemo: boolean;
  financeReadiness: 'DEVELOPMENT' | 'CA_REVIEW' | 'PARALLEL_RUN' | 'PRODUCTION';
}
