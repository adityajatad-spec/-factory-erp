import {
  COPILOT_MAX_QUESTION_CHARS,
  type AiPolicyViewDto,
  type AiStatusDto,
  type CopilotTurnResponse,
} from '@factory-erp/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Button } from '../../components/button';
import { PageHeader } from '../../components/display';
import { IconSend, IconSparkles, IconStop } from '../../components/icons';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import {
  aiReadiness,
  availableLookups,
  copilotCeiling,
  describeCopilotError,
  lookupLabels,
  suggestedQuestions,
  type CopilotNotice,
  type Readiness,
} from './copilot-logic';

/**
 * The copilot: questions in plain language, answered by the local AI from read-only ERP lookups.
 * Everything that matters is decided by the server (session, permissions, company policy,
 * limits); this page only asks and shows. The conversation lives in this page's memory alone —
 * nothing is stored, and each question is answered on its own.
 */

/** Monotonic milliseconds; read in event handlers and timers only, never while rendering. */
const clock = () => performance.now();

type Turn =
  | { id: number; question: string; state: 'pending'; startedAt: number }
  | {
      id: number;
      question: string;
      state: 'answered';
      response: CopilotTurnResponse;
      seconds: number;
    }
  | { id: number; question: string; state: 'failed'; notice: CopilotNotice };

export function CopilotPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['ai', 'status'],
    queryFn: () => api.get<AiStatusDto>('/ai/status'),
    staleTime: 30_000,
    retry: false,
  });
  const policy = useQuery({
    queryKey: ['ai', 'policy'],
    queryFn: () => api.get<AiPolicyViewDto | null>('/ai/policy'),
    staleTime: 60_000,
    retry: false,
  });
  const readiness = aiReadiness(status.data, status.isError);
  const ceiling = copilotCeiling(policy.data);
  const lookups = availableLookups(session.permissions, ceiling);
  const suggestions = suggestedQuestions(session.permissions, ceiling);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastTurnRef = useRef<HTMLLIElement>(null);
  const nextId = useRef(1);
  const inputId = useId();
  const hintId = useId();

  const turn = useMutation({
    mutationFn: ({ question, signal }: { question: string; signal: AbortSignal }) =>
      api.post<CopilotTurnResponse>('/ai/copilot/turns', { question }, { signal }),
  });
  const pending = turns.some((t) => t.state === 'pending');

  // Leaving the page cancels a question still being worked on (the server stops the turn).
  useEffect(() => () => controllerRef.current?.abort(), []);

  // Keep the newest exchange in view.
  useEffect(() => {
    lastTurnRef.current?.scrollIntoView({ block: 'nearest' });
  }, [turns]);

  const settle = (id: number, next: Turn) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? next : t)));

  // The control that had focus (Cancel) disappears when a turn ends; don't leave focus nowhere.
  const keepFocus = () => {
    if (!document.activeElement || document.activeElement === document.body) {
      inputRef.current?.focus();
    }
  };

  const ask = (raw: string) => {
    const question = raw.trim();
    if (!question || pending || !readiness.canAsk) return;
    const id = nextId.current++;
    const controller = new AbortController();
    controllerRef.current = controller;
    const startedAt = clock();
    setTurns((ts) => [...ts, { id, question, state: 'pending', startedAt }]);
    setDraft('');
    // A suggestion or "Ask again" button that was clicked is about to disappear: focus goes to
    // the question box, where Esc cancels and the next question is typed.
    inputRef.current?.focus();
    // Numbered, so two answers in a row are both announced (an unchanged text is not).
    setAnnouncement(`Working on question ${id}.`);
    turn.mutate(
      { question, signal: controller.signal },
      {
        onSuccess: (response) => {
          const seconds = Math.max(1, Math.round((clock() - startedAt) / 1000));
          settle(id, { id, question, state: 'answered', response, seconds });
          setAnnouncement(`Answer to question ${id} ready.`);
          keepFocus();
        },
        onError: (err) => {
          const notice = describeCopilotError(err);
          settle(id, { id, question, state: 'failed', notice });
          setAnnouncement(`Question ${id}: ${notice.title}. ${notice.body}`);
          keepFocus();
          if (notice.refresh) void queryClient.invalidateQueries({ queryKey: ['ai'] });
          if (notice.code === 'AI_AUTHORIZATION_CHANGED') {
            void queryClient.invalidateQueries({ queryKey: ['session'] });
          }
        },
        onSettled: () => {
          if (controllerRef.current === controller) controllerRef.current = null;
        },
      },
    );
  };

  const cancel = () => {
    controllerRef.current?.abort();
    inputRef.current?.focus();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask(draft);
  };

  const onInputKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask(draft);
    }
  };

  // While a question is being worked on, Esc cancels it wherever focus is (also when focus has
  // fallen to the page body) — except inside a dialog, such as the command palette, which
  // closes on Esc itself.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      controllerRef.current?.abort();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col">
      <PageHeader
        title="Copilot"
        subtitle="Ask about your company's data in plain language. Read-only: it can look things up but cannot change anything."
        actions={
          <>
            <StatusIndicator
              readiness={readiness}
              checking={status.isFetching}
              onRecheck={() => void status.refetch()}
            />
            {turns.length > 0 && !pending && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setTurns([]);
                  inputRef.current?.focus(); // the button itself disappears
                }}
              >
                Clear conversation
              </Button>
            )}
          </>
        }
      />

      {readiness.detail && <ReadinessNotice readiness={readiness} />}

      <section aria-label="Conversation" className="flex-1 pb-4">
        {turns.length === 0 ? (
          <Welcome
            lookups={lookups.map((l) => l.label)}
            suggestions={suggestions}
            disabled={!readiness.canAsk}
            onAsk={ask}
          />
        ) : (
          <ol className="flex flex-col gap-5">
            {turns.map((t, i) => (
              <li key={t.id} ref={i === turns.length - 1 ? lastTurnRef : undefined}>
                <Question text={t.question} />
                <div className="mt-2">
                  {t.state === 'pending' && <Working startedAt={t.startedAt} />}
                  {t.state === 'answered' && <Answer response={t.response} seconds={t.seconds} />}
                  {t.state === 'failed' && (
                    <Notice
                      notice={t.notice}
                      onRetry={
                        t.notice.canRetry && readiness.canAsk && !pending
                          ? () => ask(t.question)
                          : undefined
                      }
                    />
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <form
        onSubmit={onSubmit}
        className="sticky bottom-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
        aria-label="Ask the copilot"
      >
        <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-slate-600">
          Your question
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
          rows={2}
          maxLength={COPILOT_MAX_QUESTION_CHARS}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onInputKey}
          disabled={!readiness.canAsk}
          aria-describedby={hintId}
          placeholder={
            readiness.canAsk ? 'e.g. Which customers owe us money?' : 'The assistant is off'
          }
          className="block max-h-48 min-h-[3rem] w-full resize-y rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-accent-500 focus:outline-none disabled:bg-slate-100"
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p id={hintId} className="text-xs text-slate-500">
            <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line</span>
            {pending && (
              <span>
                <span className="hidden sm:inline"> · </span>Esc to cancel
              </span>
            )}
          </p>
          {draft.length > COPILOT_MAX_QUESTION_CHARS - 200 && (
            <span className="text-xs text-slate-500 tabular">
              {draft.length} / {COPILOT_MAX_QUESTION_CHARS}
            </span>
          )}
          <div className="ml-auto">
            {pending ? (
              <Button variant="danger" onClick={cancel}>
                <IconStop /> Cancel
              </Button>
            ) : (
              <Button
                type="submit"
                variant="primary"
                disabled={!readiness.canAsk || draft.trim() === ''}
              >
                <IconSend /> Ask
              </Button>
            )}
          </div>
        </div>
      </form>

      {/* Screen readers hear what changed: working, answered, or what went wrong. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

const DOT: Record<Readiness['kind'], string> = {
  ready: 'bg-emerald-500',
  checking: 'bg-slate-400 animate-pulse',
  off: 'bg-slate-400',
  unavailable: 'bg-amber-500',
  unknown: 'bg-amber-500',
};

function StatusIndicator({
  readiness,
  checking,
  onRecheck,
}: {
  readiness: Readiness;
  checking: boolean;
  onRecheck: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        data-testid="ai-status"
        data-kind={readiness.kind}
        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700"
      >
        <span aria-hidden="true" className={`h-2 w-2 rounded-full ${DOT[readiness.kind]}`} />
        {readiness.label}
      </span>
      {(readiness.kind === 'unavailable' || readiness.kind === 'unknown') && (
        <Button size="sm" variant="ghost" onClick={onRecheck} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      )}
    </div>
  );
}

function ReadinessNotice({ readiness }: { readiness: Readiness }) {
  const tone =
    readiness.kind === 'off'
      ? 'border-slate-200 bg-slate-100 text-slate-700'
      : 'border-amber-200 bg-amber-50 text-amber-900';
  return (
    <div className={`mb-4 rounded-md border px-3 py-2 text-sm ${tone}`} data-testid="ai-readiness">
      <p>{readiness.detail}</p>
      {!readiness.canAsk && (
        <p className="mt-0.5 text-xs opacity-80">Questions cannot be sent until this changes.</p>
      )}
    </div>
  );
}

function Welcome({
  lookups,
  suggestions,
  disabled,
  onAsk,
}: {
  lookups: string[];
  suggestions: string[];
  disabled: boolean;
  onAsk: (q: string) => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 text-slate-800">
        <IconSparkles />
        <h2 className="text-sm font-semibold">What you can ask</h2>
      </div>
      {lookups.length > 0 ? (
        <>
          <p className="mt-2 text-sm text-slate-600">
            The assistant answers from these read-only lookups of your company&apos;s data:{' '}
            <span className="font-medium text-slate-800">{lookups.join(', ')}</span>.
          </p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Suggested questions">
            {suggestions.map((q) => (
              <li key={q}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onAsk(q)}
                  className="h-full w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm text-slate-700 hover:border-slate-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-2 text-sm text-slate-600">
          Your role does not include any of the data the assistant can look up (customers and
          suppliers, receivables, payables, stock and warehouses), so it cannot answer questions
          about your company&apos;s figures.
        </p>
      )}
      <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-slate-500">
        <li>Each question is answered on its own; earlier questions are not remembered.</li>
        <li>Nothing is saved. Leaving this page clears the conversation.</li>
        <li>
          Answers are written by AI running on your own server and can be wrong. Check important
          figures in the ERP pages.
        </li>
      </ul>
    </div>
  );
}

function Question({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-lg bg-slate-900 px-3 py-2 text-sm break-words whitespace-pre-wrap text-white">
        <span className="sr-only">You asked: </span>
        {text}
      </p>
    </div>
  );
}

function Working({ startedAt }: { startedAt: number }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds(Math.floor((clock() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-600"
      data-testid="copilot-working"
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700 motion-reduce:animate-none"
      />
      <span>
        Working on it… <span className="tabular">{seconds} s</span>
      </span>
      {seconds >= 15 && (
        <span className="text-xs text-slate-500">
          The local AI can take a minute on this server.
        </span>
      )}
    </div>
  );
}

function Answer({ response, seconds }: { response: CopilotTurnResponse; seconds: number }) {
  const used = lookupLabels(response.toolsUsed);
  return (
    <article
      aria-label="Answer"
      className="rounded-lg border border-slate-200 bg-white"
      data-testid="copilot-answer"
    >
      <header className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-xs text-slate-500">
        <IconSparkles />
        <span className="font-medium text-slate-700">Copilot</span>
        <span>· Local AI · {seconds} s</span>
      </header>
      <p className="px-3 py-3 text-sm break-words whitespace-pre-wrap text-slate-800">
        {response.answer}
      </p>
      {response.truncated && (
        <p className="mx-3 mb-3 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
          Some lookups returned more rows than the assistant could read, so this answer may be
          incomplete.
        </p>
      )}
      <footer className="border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
        {used.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span>Looked up (read-only):</span>
            <ul className="flex flex-wrap gap-1.5" aria-label="ERP lookups used">
              {used.map((u) => (
                <li key={u.name}>
                  {u.page ? (
                    <Link
                      to={u.page}
                      className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-medium text-slate-700 hover:border-slate-300 hover:bg-white"
                      title={`Check in the ERP: ${u.label}`}
                    >
                      {u.label}
                    </Link>
                  ) : (
                    <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-medium text-slate-700">
                      {u.label}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p>
            No ERP data was looked up for this answer, so it is not based on your company&apos;s
            figures.
          </p>
        )}
      </footer>
    </article>
  );
}

const NOTICE_TONES: Record<CopilotNotice['tone'], string> = {
  neutral: 'border-slate-200 bg-slate-50 text-slate-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-900',
  red: 'border-red-200 bg-red-50 text-red-800',
};

function Notice({ notice, onRetry }: { notice: CopilotNotice; onRetry: (() => void) | undefined }) {
  return (
    <div
      className={`flex flex-wrap items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${NOTICE_TONES[notice.tone]}`}
      data-testid="copilot-notice"
      data-code={notice.code}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{notice.title}</p>
        <p className="mt-0.5">{notice.body}</p>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Ask again
        </Button>
      )}
    </div>
  );
}
