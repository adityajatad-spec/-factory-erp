/** Shared helpers for the e2e journeys (playwright-core against a running Factory ERP). */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

export const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const BROWSER =
  process.env.PDF_BROWSER_EXECUTABLE ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((p) => existsSync(p));

export async function launchBrowser(): Promise<Browser> {
  if (!BROWSER) throw new Error('No Chrome/Chromium found; set PDF_BROWSER_EXECUTABLE');
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  return chromium.launch({ executablePath: BROWSER, headless: true });
}

/** Numbered, timed steps with a screenshot after each (when E2E_SCREENSHOTS is set). */
export function createChecker(prefix: string) {
  let step = 0;
  const check = async (name: string, fn: () => Promise<void>, page?: Page) => {
    step++;
    const started = Date.now();
    const file = `${prefix}-${String(step).padStart(2, '0')}-${name.replace(/\W+/g, '-').toLowerCase()}`;
    try {
      await fn();
      process.stdout.write(`  ✓ ${step}. ${name} (${Date.now() - started} ms)\n`);
      if (SHOTS && page)
        await page.screenshot({ path: path.join(SHOTS, `${file}.png`), fullPage: true });
    } catch (err) {
      process.stdout.write(`  ✗ ${step}. ${name}\n`);
      if (SHOTS && page) {
        await page
          .screenshot({ path: path.join(SHOTS, `FAILED-${file}.png`), fullPage: true })
          .catch(() => undefined);
      }
      throw err;
    }
  };
  return { check, steps: () => step };
}

/**
 * Collect console errors, ignoring the expected 401s a signed-out session produces (and any
 * other HTTP statuses a journey deliberately provokes, e.g. a rejected command's 422).
 */
export function watchConsole(page: Page, expectedStatuses: readonly number[] = []): string[] {
  const errors: string[] = [];
  const expected = [401, ...expectedStatuses].map((s) => `status of ${s}`);
  page.on(
    'console',
    (m) =>
      m.type() === 'error' && !expected.some((e) => m.text().includes(e)) && errors.push(m.text()),
  );
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

let keySeq = 0;

/**
 * Call the API with the browser's session cookie — used to SET UP data a journey is not about
 * and to VERIFY database state the UI does not show. Mutations carry an Idempotency-Key.
 */
export async function api<T>(
  page: Page,
  method: 'GET' | 'POST',
  path: string,
  data?: unknown,
): Promise<T> {
  const res = await page.request.fetch(`${BASE_URL}/api/v1${path}`, {
    method,
    ...(method === 'POST'
      ? { data: data ?? {}, headers: { 'idempotency-key': `e2e-${Date.now()}-${++keySeq}` } }
      : {}),
  });
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Draft and issue a 1-line invoice through the UI: <quantity> × BA-100 @ ₹245 + 18 % GST.
 * Returns the invoice page URL and number.
 */
export async function issueInvoiceViaUi(
  page: Page,
  customerCode: string,
  quantity: string,
  expectedTotal: string,
): Promise<{ url: string; number: string; id: string }> {
  await page.goto(`${BASE_URL}/sales/invoices/new`);
  const customer = page.getByLabel('Customer');
  await customer.fill(customerCode);
  await page.getByRole('option', { name: new RegExp(customerCode) }).waitFor();
  await customer.press('Enter');
  const item = page.getByPlaceholder('Search item').first();
  await item.click();
  await item.fill('BA-100');
  await page.getByRole('option', { name: /BA-100/ }).waitFor();
  await item.press('Enter');
  await page.getByLabel('Quantity').first().fill(quantity);
  await page.keyboard.press('Control+Enter');
  await page.getByRole('heading', { name: /Draft invoice/ }).waitFor();
  await page.getByRole('button', { name: 'Issue invoice…' }).click();
  await page.getByRole('button', { name: `Issue for ${expectedTotal}` }).click();
  const heading = page.getByRole('heading', { name: /INV\/\d{2}-\d{2}\/\d{5}/ });
  await heading.waitFor();
  const number = /INV\/\d{2}-\d{2}\/\d{5}/.exec(await heading.innerText())?.[0] ?? '';
  const url = page.url();
  return { url, number, id: url.split('/').pop() ?? '' };
}

export async function login(
  page: Page,
  username: string,
  password = 'factory-demo',
): Promise<void> {
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}
