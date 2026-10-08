import { PERMISSIONS, type OutboxEventDto, type OutboxOverviewDto } from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '../../components/button';
import {
  Badge,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Panel,
  Spinner,
  Table,
  td,
  tdNum,
  th,
} from '../../components/display';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useCan } from '../../lib/session';

/** Plain-language names for job topics. */
const TOPICS: Record<string, string> = {
  'sales.invoice.issued': 'Invoice PDF',
  'sales.credit_note.issued': 'Credit-note PDF',
};

const outboxQuery = (status: 'FAILED' | 'PENDING') => ({
  queryKey: ['outbox', status],
  queryFn: () => api.get<OutboxOverviewDto>('/operations/outbox', { status }),
});

/** Dashboard warning, shown only to people who can act on it. */
export function FailedJobsBanner() {
  const can = useCan();
  const overview = useQuery({
    ...outboxQuery('FAILED'),
    enabled: can(PERMISSIONS.outboxManage),
    refetchInterval: 60_000,
  });
  const failed = overview.data?.failed ?? 0;
  if (!failed) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
    >
      <span>
        {failed === 1 ? '1 background job has' : `${failed} background jobs have`} failed (for
        example a PDF that could not be generated).
      </span>
      <Link to="/admin/jobs" className="font-medium underline">
        Review
      </Link>
    </div>
  );
}

export function BackgroundJobsPage() {
  const [status, setStatus] = useState<'FAILED' | 'PENDING'>('FAILED');
  const overview = useQuery(outboxQuery(status));
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: (e: OutboxEventDto) => api.post<OutboxEventDto>(`/operations/outbox/${e.id}/retry`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['outbox'] }),
  });

  return (
    <>
      <PageHeader
        title="Background jobs"
        subtitle="Work done after a document is saved, such as generating its PDF. A job that keeps failing stops and waits here; retry it once the cause is fixed. Retries are audited."
      />
      <Panel
        title={
          <span className="flex gap-2">
            <Button
              size="sm"
              variant={status === 'FAILED' ? 'primary' : 'secondary'}
              onClick={() => setStatus('FAILED')}
            >
              Failed ({overview.data?.failed ?? '…'})
            </Button>
            <Button
              size="sm"
              variant={status === 'PENDING' ? 'primary' : 'secondary'}
              onClick={() => setStatus('PENDING')}
            >
              Waiting ({overview.data?.pending ?? '…'})
            </Button>
          </span>
        }
      >
        <ErrorBanner error={overview.error ?? retry.error} className="m-3" />
        {overview.isPending ? (
          <Spinner />
        ) : overview.data?.events.length ? (
          <Table>
            <thead>
              <tr>
                <th className={th}>Job</th>
                <th className={th}>Queued</th>
                <th className={`${th} text-right`}>Attempts</th>
                <th className={th}>Last error</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {overview.data.events.map((e) => (
                <tr key={e.id}>
                  <td className={td}>
                    {TOPICS[e.topic] ?? e.topic}
                    {e.status === 'FAILED' && (
                      <span className="ml-2">
                        <Badge tone="red">Failed</Badge>
                      </span>
                    )}
                  </td>
                  <td className={`${td} text-slate-600`}>{dateTime(e.occurredAt)}</td>
                  <td className={tdNum}>{e.attempts}</td>
                  <td
                    className={`${td} max-w-md truncate font-mono text-xs`}
                    title={e.lastError ?? ''}
                  >
                    {e.lastError ?? '—'}
                  </td>
                  <td className={`${td} text-right`}>
                    {e.status === 'FAILED' && (
                      <Button size="sm" onClick={() => retry.mutate(e)} disabled={retry.isPending}>
                        Retry
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title={status === 'FAILED' ? 'No failed jobs' : 'Nothing waiting'} />
        )}
      </Panel>
    </>
  );
}
