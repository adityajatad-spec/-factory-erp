import { CREDIT_NOTE_REASON_LABELS, type CreditNoteStatus } from '@factory-erp/contracts';
import { Badge } from '../../components/display';

export const REASON_LABELS = CREDIT_NOTE_REASON_LABELS;

export function CreditNoteStatusBadge({ status }: { status: CreditNoteStatus }) {
  return <Badge tone={status === 'ISSUED' ? 'green' : 'amber'}>{status}</Badge>;
}
