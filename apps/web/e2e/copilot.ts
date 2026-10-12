/**
 * E2E journey — the Copilot page (Slice 3, phase A), against the production build.
 *
 * The server runs the deterministic local test provider (AI_PROVIDER=fake, set by run.ts; it
 * echoes and never calls a tool), and the demo seed's company policy approves it. So "real"
 * steps below go through the real session, policy, permissions, limits and copilot. Answers that
 * need a tool result, slow answers and failure codes cannot be produced by that provider; those
 * steps replace the server's response in the browser (page.route) — they test the page, and
 * are marked "(mocked response)".
 */
import { COPILOT_TOOLS, type AiPolicyViewDto, type SessionUser } from '@factory-erp/contracts';
import type { Browser, Page, Request } from 'playwright-core';
import { api, BASE_URL, createChecker, launchBrowser, login, watchConsole } from './harness';

const { check, steps } = createChecker('copilot');
const TURNS = '**/api/v1/ai/copilot/turns';
const DESKTOP = {
  viewport: { width: 1440, height: 900 },
  locale: 'en-IN',
  timezoneId: 'Asia/Kolkata',
};
// Mocked failures make the browser log their HTTP status: expected here.
const EXPECTED_STATUSES = [403, 409, 422, 429, 500, 503, 504];
const MODEL_TEXT = /fake:|deterministic|ollama|qwen|11434|llama|mistral|gpt/i;

/** Every request a page makes, to prove the browser talks to the ERP server only. */
function recordRequests(page: Page, into: Request[]) {
  page.on('request', (r) => into.push(r));
}
const question = (page: Page) => page.getByLabel('Your question');
const lastNotice = (page: Page) => page.getByTestId('copilot-notice').last();
const lastAnswer = (page: Page) => page.getByTestId('copilot-answer').last();

async function openCopilot(page: Page) {
  await page.goto(`${BASE_URL}/copilot`);
  await page.getByRole('heading', { name: 'Copilot', level: 1 }).waitFor();
}
async function waitForStatus(page: Page, label: string) {
  await page.getByTestId('ai-status').filter({ hasText: label }).waitFor();
}
async function ask(page: Page, text: string) {
  await question(page).fill(text);
  await question(page).press('Enter');
}
async function activeElement(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName ?? '',
      text: el?.innerText.trim() ?? '',
      outline: el ? getComputedStyle(el).outlineStyle : '',
    };
  });
}
async function noSidewaysScroll(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  if (scroll > width) throw new Error(`horizontal scroll: ${scroll}px content in ${width}px`);
}
/** Change the company AI policy as the owner (PUT /ai/policy, as an API client would). */
async function setAiEnabled(page: Page, aiEnabled: boolean) {
  const view = await api<AiPolicyViewDto>(page, 'GET', '/ai/policy');
  const res = await page.request.fetch(`${BASE_URL}/api/v1/ai/policy`, {
    method: 'PUT',
    headers: { 'idempotency-key': `e2e-policy-${Date.now()}-${aiEnabled}` },
    data: {
      expectedVersion: view.version,
      aiEnabled,
      tasks: view.detail?.tasks,
      reason: aiEnabled ? 'E2E: switch the copilot back on' : 'E2E: switch the copilot off',
    },
  });
  if (!res.ok()) throw new Error(`PUT /ai/policy → ${res.status()} ${await res.text()}`);
}

const browser: Browser = await launchBrowser();
try {
  const owner = await browser.newPage(DESKTOP);
  const ownerErrors = watchConsole(owner, EXPECTED_STATUSES);
  const requests: Request[] = [];
  recordRequests(owner, requests);

  process.stdout.write(`Factory ERP e2e copilot → ${BASE_URL}\n`);

  await check(
    'the owner opens the Copilot from the navigation; the local AI is ready (real)',
    async () => {
      await login(owner, 'owner');
      await owner
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Copilot' })
        .click();
      await owner.getByRole('heading', { name: 'Copilot', level: 1 }).waitFor();
      await waitForStatus(owner, 'Local AI ready');
      const suggestions = owner
        .getByRole('list', { name: 'Suggested questions' })
        .getByRole('button');
      // The owner holds every permission and the demo policy allows CONFIDENTIAL: all five lookups.
      if ((await suggestions.count()) !== COPILOT_TOOLS.length) {
        throw new Error(`expected ${COPILOT_TOOLS.length} suggestions`);
      }
      await owner
        .getByText('Nothing is saved. Leaving this page clears the conversation.')
        .waitFor();
    },
    owner,
  );

  await check(
    'a suggested question is answered by the server (real turn); focus stays in the question box',
    async () => {
      await owner.getByRole('button', { name: 'Which warehouses do we have?' }).click();
      await lastAnswer(owner).getByText('Fake reply: Which warehouses do we have?').waitFor();
      // The test provider looks nothing up, and the page says so instead of implying it did.
      await lastAnswer(owner)
        .getByText(/No ERP data was looked up for this answer/)
        .waitFor();
      await owner.getByRole('status').filter({ hasText: 'Answer to question 1 ready.' }).waitFor({
        state: 'attached',
      });
      // The clicked suggestion is gone; focus must land in the question box, not on the page.
      const focused = await activeElement(owner);
      if (focused.tag !== 'TEXTAREA') throw new Error(`focus fell to ${focused.tag}`);
      const body = requests
        .filter((r) => r.url().endsWith('/api/v1/ai/copilot/turns'))
        .map((r) => r.postData());
      if (body.at(-1) !== JSON.stringify({ question: 'Which warehouses do we have?' })) {
        throw new Error(`the page sent more than the question: ${String(body.at(-1))}`);
      }
    },
    owner,
  );

  await check(
    'typing: Shift+Enter makes a new line, Enter asks (real turn)',
    async () => {
      await question(owner).fill('line one');
      await question(owner).press('Shift+Enter');
      await question(owner).pressSequentially('line two');
      if ((await question(owner).inputValue()) !== 'line one\nline two') {
        throw new Error('Shift+Enter did not insert a new line');
      }
      await question(owner).press('Enter');
      await lastAnswer(owner)
        .getByText(/Fake reply: line one\s+line two/)
        .waitFor();
      const focused = await activeElement(owner);
      if (focused.tag !== 'TEXTAREA') throw new Error(`focus moved to ${focused.tag}`);
    },
    owner,
  );

  await check(
    'lookups used are named and link to the ERP page; a truncated answer says so (mocked response)',
    async () => {
      await owner.route(TURNS, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            answer: 'Here is what the receivables and stock lookups returned.',
            locality: 'LOCAL',
            toolsUsed: ['finance.receivables.summary', 'inventory.stock.list'],
            truncated: true,
          }),
        }),
      );
      try {
        await ask(owner, 'Who owes us money?');
        const answer = lastAnswer(owner);
        await answer.getByText('Here is what the receivables').waitFor();
        await answer.getByText(/may be\s+incomplete/).waitFor();
        const lookups = answer.getByRole('list', { name: 'ERP lookups used' });
        await lookups.getByRole('link', { name: 'Stock on hand' }).waitFor();
        await lookups.getByRole('link', { name: 'Receivables summary' }).click();
        await owner.waitForURL(/\/finance\/receivables$/);
      } finally {
        await owner.unroute(TURNS);
      }
      // Coming back starts afresh: the conversation was never stored.
      await openCopilot(owner);
      await owner.getByRole('heading', { name: 'What you can ask' }).waitFor();
      if ((await owner.getByTestId('copilot-answer').count()) !== 0) {
        throw new Error('the conversation survived leaving the page');
      }
    },
    owner,
  );

  await check(
    'while waiting: a working indicator; Esc and the Cancel button cancel the request (mocked slow response)',
    async () => {
      const aborted: string[] = [];
      owner.on('requestfailed', (r) => {
        if (r.url().endsWith('/api/v1/ai/copilot/turns'))
          aborted.push(r.failure()?.errorText ?? '');
      });
      // Never answered: the request stays open until the page cancels it.
      await owner.route(TURNS, () => undefined);
      try {
        await waitForStatus(owner, 'Local AI ready');
        // Asked by clicking a suggestion, then Esc pressed wherever focus is now.
        await owner.getByRole('button', { name: 'Which warehouses do we have?' }).click();
        await owner.getByTestId('copilot-working').waitFor();
        await owner.getByRole('button', { name: 'Cancel' }).waitFor();
        await owner.getByText('Esc to cancel').waitFor();
        // A click on plain text moves focus to the page itself; Esc must still cancel.
        await owner.getByRole('heading', { name: 'Copilot', level: 1 }).click();
        const before = await activeElement(owner);
        if (before.tag !== 'BODY') throw new Error(`expected focus on the page, got ${before.tag}`);
        await owner.keyboard.press('Escape');
        await lastNotice(owner).getByText('You cancelled this question.').waitFor();
        await owner.getByRole('button', { name: 'Ask', exact: true }).waitFor();

        await ask(owner, 'Another slow question');
        await owner.getByTestId('copilot-working').waitFor();
        await owner.getByRole('button', { name: 'Cancel' }).click();
        await owner
          .locator('[data-testid="copilot-notice"][data-code="CANCELLED"]')
          .nth(1)
          .waitFor();
        const focused = await activeElement(owner);
        if (focused.tag !== 'TEXTAREA')
          throw new Error(`after cancelling, focus is on ${focused.tag}`);
        if ((await owner.getByTestId('copilot-working').count()) !== 0) {
          throw new Error('a working indicator is left behind');
        }
      } finally {
        await owner.unroute(TURNS);
      }
      for (let i = 0; i < 20 && aborted.length < 2; i++) await owner.waitForTimeout(100);
      if (aborted.length < 2)
        throw new Error(`requests not aborted in the browser: ${aborted.join()}`);
    },
    owner,
  );

  await check(
    'every copilot failure is explained in plain words, with "Ask again" only where it can help (mocked responses)',
    async () => {
      const cases: [string, number, string | null, RegExp, boolean][] = [
        ['AI_DISABLED', 503, null, /not set up on this server/, false],
        ['AI_POLICY_BLOCKED', 403, null, /AI policy does not allow/, false],
        ['AI_UNAVAILABLE', 503, null, /not responding right now/, true],
        ['AI_TIMEOUT', 504, null, /took too long/, true],
        ['AI_BUSY', 429, '5', /Try again in about 5 seconds/, true],
        ['AI_RATE_LIMITED', 429, '540', /ask again in about 9 minutes/, true],
        ['AI_NO_ANSWER', 422, null, /could not produce an answer/, true],
        ['AI_AUTHORIZATION_CHANGED', 409, null, /answer was withheld/, true],
        ['INTERNAL_ERROR', 500, null, /reference e2e-req-1/, true],
      ];
      for (const [code, status, retryAfter, text, canRetry] of cases) {
        await owner.route(TURNS, (route) =>
          route.fulfill({
            status,
            contentType: 'application/problem+json',
            headers: retryAfter ? { 'retry-after': retryAfter } : {},
            body: JSON.stringify({
              type: 'about:blank',
              title: 'server wording that the page does not show',
              status,
              code,
              requestId: 'e2e-req-1',
            }),
          }),
        );
        try {
          await waitForStatus(owner, 'Local AI ready');
          await ask(owner, `Provoke ${code}`);
          const notice = owner
            .locator(`[data-testid="copilot-notice"][data-code="${code}"]`)
            .last();
          await notice.getByText(text).waitFor();
          if ((await notice.getByText('server wording').count()) !== 0) {
            throw new Error(`${code}: the server's title was shown verbatim`);
          }
          const retry = await notice.getByRole('button', { name: 'Ask again' }).count();
          if (retry !== (canRetry ? 1 : 0))
            throw new Error(`${code}: "Ask again" shown = ${retry}`);
          if (code === 'AI_UNAVAILABLE') {
            // "Ask again" asks the same question as a new turn; focus goes to the question box.
            await notice.getByRole('button', { name: 'Ask again' }).click();
            await owner
              .locator(`[data-testid="copilot-notice"][data-code="${code}"]`)
              .nth(1)
              .waitFor();
            const focused = await activeElement(owner);
            if (focused.tag !== 'TEXTAREA')
              throw new Error(`after "Ask again", focus is on ${focused.tag}`);
          }
        } finally {
          await owner.unroute(TURNS);
        }
      }
    },
    owner,
  );

  await check(
    'AI switched off on the server: the status says so and nothing can be asked (mocked status)',
    async () => {
      await owner.route('**/api/v1/ai/status', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            state: 'DISABLED',
            providerId: null,
            locality: null,
            reason: null,
            checkedAt: null,
            policy: { state: 'ENABLED', version: 1 },
          }),
        }),
      );
      try {
        await openCopilot(owner);
        await waitForStatus(owner, 'AI not set up');
        await owner.getByTestId('ai-readiness').getByText('not set up on this server').waitFor();
        if (!(await question(owner).isDisabled())) throw new Error('question box is enabled');
        const firstSuggestion = owner
          .getByRole('list', { name: 'Suggested questions' })
          .getByRole('button')
          .first();
        if (!(await firstSuggestion.isDisabled())) throw new Error('suggestions are enabled');
      } finally {
        await owner.unroute('**/api/v1/ai/status');
      }
    },
    owner,
  );

  await check(
    "switched off by the company's AI policy (real): the page and the server both refuse",
    async () => {
      await setAiEnabled(owner, false);
      try {
        await openCopilot(owner);
        await waitForStatus(owner, 'Off for this company');
        if (!(await question(owner).isDisabled())) throw new Error('question box is enabled');
        // The server refuses on its own, whatever a page shows.
        const res = await owner.request.fetch(`${BASE_URL}/api/v1/ai/copilot/turns`, {
          method: 'POST',
          data: { question: 'Anything?' },
        });
        const problem = (await res.json()) as { code: string };
        if (res.status() !== 403 || problem.code !== 'AI_POLICY_BLOCKED') {
          throw new Error(`server answered ${res.status()} ${problem.code}`);
        }
      } finally {
        await setAiEnabled(owner, true);
      }
      await openCopilot(owner);
      await waitForStatus(owner, 'Local AI ready');
    },
    owner,
  );

  await check(
    'keyboard: the question box is labelled, Tab reaches Ask with a visible focus ring, Enter asks (real turn)',
    async () => {
      await question(owner).focus();
      await question(owner).fill('Keyboard only');
      await owner.keyboard.press('Tab');
      const focused = await activeElement(owner);
      if (focused.tag !== 'BUTTON' || focused.text !== 'Ask') {
        throw new Error(`Tab went to ${focused.tag} "${focused.text}"`);
      }
      if (focused.outline !== 'solid') throw new Error('no visible focus ring on Ask');
      await owner.keyboard.press('Enter');
      await lastAnswer(owner).getByText('Fake reply: Keyboard only').waitFor();
      await owner.getByRole('region', { name: 'Conversation' }).waitFor();
      // Clearing removes its own button: focus moves to the question box.
      await owner.getByRole('button', { name: 'Clear conversation' }).click();
      await owner.getByRole('heading', { name: 'What you can ask' }).waitFor();
      const afterClear = await activeElement(owner);
      if (afterClear.tag !== 'TEXTAREA')
        throw new Error(`after clearing, focus is on ${afterClear.tag}`);
    },
    owner,
  );

  await check(
    'the session ending sends the person to sign in, then back to the Copilot (real)',
    async () => {
      await owner.context().clearCookies();
      await ask(owner, 'Am I still signed in?');
      await owner.waitForURL((u) => u.pathname === '/login');
      if (!owner.url().includes('next=%2Fcopilot')) throw new Error(`no way back: ${owner.url()}`);
      await owner.getByLabel('Username').fill('owner');
      await owner.getByLabel('Password').fill('factory-demo');
      await owner.getByRole('button', { name: 'Sign in' }).click();
      await owner.waitForURL((u) => u.pathname === '/copilot');
      await waitForStatus(owner, 'Local AI ready');
    },
    owner,
  );

  // --- Other people: what they are offered follows their own permissions. ----------------------
  const people = await browser.newPage(DESKTOP);
  const peopleErrors = watchConsole(people);
  await check(
    'each role is offered only the questions its permissions can answer (real sessions)',
    async () => {
      await login(people, 'production');
      await openCopilot(people);
      const me = await api<SessionUser>(people, 'GET', '/auth/me');
      const expected = COPILOT_TOOLS.filter((t) => me.permissions.includes(t.permission)).length;
      const offered = people.getByRole('list', { name: 'Suggested questions' }).getByRole('button');
      await offered.first().waitFor();
      if ((await offered.count()) !== expected || expected !== 2) {
        throw new Error(
          `production manager offered ${await offered.count()}, expected ${expected}`,
        );
      }
      await people
        .getByRole('button', { name: 'What stock do we have on hand, by warehouse?' })
        .waitFor();
      if ((await people.getByText('Who owes us money').count()) !== 0) {
        throw new Error('a finance question was offered to the production manager');
      }

      await people.getByRole('button', { name: 'Sign out' }).click();
      await people.waitForURL((u) => u.pathname === '/login');
      await login(people, 'hrmanager');
      await openCopilot(people);
      await people
        .getByText(/Your role does not include any of the data the assistant can look up/)
        .waitFor();
    },
    people,
  );

  // --- Layouts: phone and tablet. -----------------------------------------------------------------
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  const phoneErrors = watchConsole(phone);
  const phoneRequests: Request[] = [];
  recordRequests(phone, phoneRequests);
  await check(
    'phone: the menu reaches the Copilot; it fits the screen and a question is answered (real turn)',
    async () => {
      await login(phone, 'accountant');
      await phone.getByRole('button', { name: 'Open menu' }).click();
      await phone.getByRole('dialog').getByRole('link', { name: 'Copilot' }).click();
      await phone.getByRole('heading', { name: 'Copilot', level: 1 }).waitFor();
      await waitForStatus(phone, 'Local AI ready');
      await noSidewaysScroll(phone);
      await ask(phone, 'Which customers owe us money, and how much is overdue?');
      await lastAnswer(phone)
        .getByText(/Fake reply:/)
        .waitFor();
      await noSidewaysScroll(phone);
      const box = await phone.getByRole('button', { name: 'Ask', exact: true }).boundingBox();
      if (!box || box.y + box.height > 844) throw new Error('the Ask button is off screen');
    },
    phone,
  );

  const tablet = await browser.newPage({
    viewport: { width: 820, height: 1180 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  const tabletErrors = watchConsole(tablet);
  await check(
    'tablet: the sidebar shows the Copilot and the page fits the screen (real)',
    async () => {
      await login(tablet, 'purchase');
      await tablet
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Copilot' })
        .click();
      await waitForStatus(tablet, 'Local AI ready');
      await noSidewaysScroll(tablet);
    },
    tablet,
  );

  await check(
    'the browser only ever talked to the ERP server; no model names are shown',
    async () => {
      const outside = [...requests, ...phoneRequests]
        .map((r) => r.url())
        .filter((u) => !u.startsWith(BASE_URL) && !u.startsWith('data:'));
      if (outside.length > 0)
        throw new Error(`requests outside the ERP server: ${outside.join(', ')}`);
      for (const p of [owner, phone, tablet, people]) {
        const text = await p.locator('body').innerText();
        if (MODEL_TEXT.test(text.replace(/Fake reply:/g, ''))) {
          throw new Error(`a model or runtime name is visible on ${p.url()}`);
        }
      }
    },
  );

  await check('no unexpected browser console errors', () => {
    const all = [...ownerErrors, ...peopleErrors, ...phoneErrors, ...tabletErrors];
    if (all.length > 0) throw new Error(all.join('\n'));
    return Promise.resolve();
  });

  process.stdout.write(`All ${steps()} copilot checks passed.\n`);
} finally {
  await browser.close();
}
