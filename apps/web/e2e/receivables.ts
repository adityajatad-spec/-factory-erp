/**
 * E2E journey — the sales-to-cash loop:
 *   login → new customer → invoice → issue → partial payment → overpayment
 *   → verify derived outstanding, payment status, on-account credit and receivables.
 *
 * Self-contained: creates its own customer, so it can run repeatedly on any database.
 */
import { BASE_URL, createChecker, launchBrowser, login, watchConsole } from './harness';

const { check, steps } = createChecker('recv');
const code = `E2E-${Date.now().toString(36).toUpperCase()}`;
const customerName = `E2E Customer ${code}`;

const browser = await launchBrowser();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  const consoleErrors = watchConsole(page);
  const outstanding = page.getByTestId('invoice-outstanding');
  let invoiceUrl = '';
  let invoiceNumber = '';

  process.stdout.write(`Factory ERP e2e receivables → ${BASE_URL}\n`);

  await check('accountant signs in', async () => {
    await login(page, 'accountant');
    await page.getByText("Today's sales").waitFor();
  });

  await check(
    'create a customer',
    async () => {
      await page.goto(`${BASE_URL}/sales/customers`);
      await page.getByRole('button', { name: 'New party' }).click();
      await page.getByLabel('Code', { exact: true }).fill(code);
      await page.getByLabel('Name', { exact: true }).fill(customerName);
      await page.getByRole('button', { name: 'Create' }).click();
      await page.getByRole('cell', { name: customerName }).waitFor();
    },
    page,
  );

  await check(
    'issue an invoice for ₹2,891.00 (10 × BA-100 @ ₹245 + 18% GST)',
    async () => {
      await page.goto(`${BASE_URL}/sales/invoices/new`);
      const customer = page.getByLabel('Customer');
      await customer.fill(code);
      await page.getByRole('option', { name: new RegExp(code) }).waitFor();
      await customer.press('Enter');
      const item = page.getByPlaceholder('Search item').first();
      await item.click();
      await item.fill('BA-100');
      await page.getByRole('option', { name: /BA-100/ }).waitFor();
      await item.press('Enter');
      await page.getByLabel('Quantity').first().fill('10');
      await page.keyboard.press('Control+Enter');
      await page.getByRole('heading', { name: /Draft invoice/ }).waitFor();
      await page.getByRole('button', { name: 'Issue invoice…' }).click();
      await page.getByRole('button', { name: /Issue for ₹2,891\.00/ }).click();
      const heading = page.getByRole('heading', { name: /INV\/\d{2}-\d{2}\/\d{5}/ });
      await heading.waitFor();
      invoiceNumber = /INV\/\d{2}-\d{2}\/\d{5}/.exec(await heading.innerText())?.[0] ?? '';
      invoiceUrl = page.url();
      await page.getByRole('heading', { level: 1 }).getByText('Unpaid', { exact: true }).waitFor();
      await outstanding.getByText('₹2,891.00').waitFor();
    },
    page,
  );

  await check(
    'record a partial payment of ₹1,000 against the invoice',
    async () => {
      await page.getByRole('link', { name: 'Record payment' }).click();
      await page.waitForURL(/\/finance\/receipts\/new/);
      const amount = page.getByLabel('Amount received (₹)');
      // Prefilled from the invoice's outstanding amount.
      if ((await amount.inputValue()) !== '2891.00') throw new Error('amount was not prefilled');
      await amount.fill('1000.00');
      await page.getByLabel(`Allocate to ${invoiceNumber}`).fill('1000.00');
      await page.getByLabel('Reference').fill('E2E-UTR-1');
      await page.getByRole('button', { name: /^Record receipt/ }).click();
      await page.waitForURL(/\/finance\/receipts\/[0-9a-f-]{36}$/);
      await page.getByRole('heading', { name: /RCPT\// }).waitFor();
      await page.getByRole('cell', { name: invoiceNumber }).waitFor();
    },
    page,
  );

  await check(
    'invoice is part-paid with ₹1,891.00 outstanding (derived)',
    async () => {
      await page.goto(invoiceUrl);
      await page
        .getByRole('heading', { level: 1 })
        .getByText('Part-paid', { exact: true })
        .waitFor();
      await outstanding.getByText('₹1,891.00').waitFor();
      await page
        .getByRole('cell', { name: /RCPT\// })
        .first()
        .waitFor();
    },
    page,
  );

  await check(
    'overpay with ₹2,500: invoice settles, ₹609 stays on account',
    async () => {
      await page.getByRole('link', { name: 'Record payment' }).click();
      await page.waitForURL(/\/finance\/receipts\/new/);
      await page.getByLabel('Amount received (₹)').fill('2500.00');
      // The allocation is prefilled with the remaining outstanding (1891.00).
      const alloc = page.getByLabel(`Allocate to ${invoiceNumber}`);
      if ((await alloc.inputValue()) !== '1891.00') throw new Error('allocation was not prefilled');
      await page.getByText('Left on account').waitFor();
      await page.getByRole('button', { name: /^Record receipt/ }).click();
      await page.waitForURL(/\/finance\/receipts\/[0-9a-f-]{36}$/);
      await page.getByText('₹609.00').first().waitFor();
      await page.getByRole('heading', { name: 'Allocate the unallocated amount' }).waitFor();
    },
    page,
  );

  await check(
    'invoice is now paid in full',
    async () => {
      await page.goto(invoiceUrl);
      await page.getByRole('heading', { level: 1 }).getByText('Paid', { exact: true }).waitFor();
      await outstanding.getByText('₹0.00').waitFor();
      if ((await page.getByRole('link', { name: 'Record payment' }).count()) > 0) {
        throw new Error('a paid invoice still offers "Record payment"');
      }
    },
    page,
  );

  await check(
    'receivables shows the customer in credit (−₹609.00)',
    async () => {
      await page.goto(`${BASE_URL}/finance/receivables`);
      const row = page.getByRole('row').filter({ hasText: customerName });
      await row.waitFor();
      await row.getByText('-₹609.00').waitFor();
      await row.getByText('credit').waitFor();
    },
    page,
  );

  await check(
    'receipts list filters to receipts with unallocated money',
    async () => {
      await page.goto(`${BASE_URL}/finance/receipts`);
      await page.getByLabel('Only receipts with unallocated money').check();
      await page.getByRole('row').filter({ hasText: customerName }).waitFor();
    },
    page,
  );

  await check('no unexpected browser console errors', () => {
    if (consoleErrors.length) throw new Error(consoleErrors.join('\n'));
    return Promise.resolve();
  });

  process.stdout.write(`All ${steps()} receivables checks passed.\n`);
} finally {
  await browser.close();
}
