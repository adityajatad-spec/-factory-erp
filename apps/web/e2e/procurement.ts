/**
 * E2E journey — procure-to-pay, each step by the person whose job it is:
 *   purchase manager: new supplier → draft PO (cannot approve it)
 *   owner: approve PO
 *   supervisor: receive 40 of 100 (partial) → receive the remaining 60
 *   accountant: enter the supplier's bill against the PO → three-way match → post
 *   accountant: record the payment (cannot approve it) → owner approves (maker-checker)
 *   → bill paid, nothing owed, stock up by exactly 100; the maker cannot approve their own.
 *
 * Self-contained: creates its own supplier, so it can run repeatedly on any database.
 */
import { Dec } from '@factory-erp/money';
import type { Browser, Page } from 'playwright-core';
import { api, BASE_URL, createChecker, launchBrowser, login, watchConsole } from './harness';

const { check, steps } = createChecker('p2p');
const code = `S-E2E-${Date.now().toString(36).toUpperCase()}`;
const supplierName = `E2E Supplier ${code}`;

async function signedIn(browser: Browser, username: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  const page = await context.newPage();
  await login(page, username);
  return page;
}

const browser = await launchBrowser();
try {
  process.stdout.write(`Factory ERP e2e procure-to-pay → ${BASE_URL}\n`);
  const purchase = await signedIn(browser, 'purchase');
  const owner = await signedIn(browser, 'owner');
  const supervisor = await signedIn(browser, 'supervisor');
  const accountant = await signedIn(browser, 'accountant');
  // One live array per page; flattened only when checked.
  const watched = [purchase, owner, supervisor, accountant].map((p) => watchConsole(p));
  const allErrors = () => watched.flat();

  let orderUrl = '';
  let poNumber = '';
  let billUrl = '';
  let billNumber = '';
  let paymentUrl = '';
  let stockBefore = '0';
  const item = (
    await api<Array<{ id: string; code: string }>>(owner, 'GET', '/items?q=RM-MS2')
  ).find((i) => i.code === 'RM-MS2');
  if (!item) throw new Error('demo item RM-MS2 missing');
  const stockOf = async (warehouseId: string) =>
    (
      await api<Array<{ quantity: string }>>(
        owner,
        'GET',
        `/inventory/stock?itemId=${item.id}&warehouseId=${warehouseId}&includeZero=true`,
      )
    )[0]?.quantity ?? '0';

  await check(
    'purchase manager creates a supplier',
    async () => {
      await purchase.goto(`${BASE_URL}/purchasing/suppliers`);
      await purchase.getByRole('button', { name: 'New supplier' }).click();
      await purchase.getByLabel('Code', { exact: true }).fill(code);
      await purchase.getByLabel('Name', { exact: true }).fill(supplierName);
      await purchase.getByLabel('Credit days').fill('30');
      await purchase.getByRole('button', { name: 'Create' }).click();
      await purchase.getByRole('cell', { name: supplierName }).waitFor();
    },
    purchase,
  );

  await check(
    'purchase manager drafts a PO: 100 kg MS sheet @ ₹50 → ₹5,900.00, and cannot approve it',
    async () => {
      await purchase.goto(`${BASE_URL}/purchasing/orders/new`);
      const supplier = purchase.getByLabel('Supplier');
      await supplier.fill(code);
      await purchase.getByRole('option', { name: new RegExp(code) }).waitFor();
      await supplier.press('Enter');
      const line = purchase.getByPlaceholder('Search item').first();
      await line.click();
      await line.fill('RM-MS2');
      await purchase.getByRole('option', { name: /RM-MS2/ }).waitFor();
      await line.press('Enter');
      await purchase.getByLabel('Quantity').first().fill('100');
      await purchase.getByLabel('Unit rate').first().fill('50');
      await purchase.keyboard.press('Control+Enter');
      await purchase.getByRole('heading', { name: /Draft purchase order/ }).waitFor();
      await purchase.getByText('₹5,900.00').first().waitFor();
      orderUrl = purchase.url();
      if ((await purchase.getByRole('button', { name: 'Approve' }).count()) > 0) {
        throw new Error('the purchase manager can approve their own PO');
      }
    },
    purchase,
  );

  await check(
    'owner approves: numbered, frozen, PDF prepared in the background',
    async () => {
      await owner.goto(orderUrl);
      await owner.getByRole('button', { name: 'Approve' }).click();
      await owner.getByRole('button', { name: 'Approve ₹5,900.00' }).click();
      const heading = owner.getByRole('heading', { name: /PO\/\d{2}-\d{2}\/\d{5}/ });
      await heading.waitFor();
      poNumber = /PO\/\d{2}-\d{2}\/\d{5}/.exec(await heading.innerText())?.[0] ?? '';
      await owner.getByRole('heading', { level: 1 }).getByText('Approved').waitFor();
      await owner.getByRole('button', { name: 'View PDF' }).waitFor({ timeout: 20_000 });
    },
    owner,
  );

  const orderId = orderUrl.split('/').pop() ?? '';
  const order = await api<{ warehouseId: string }>(owner, 'GET', `/purchase-orders/${orderId}`);
  stockBefore = await stockOf(order.warehouseId);

  await check(
    'supervisor receives 40 of 100 (partial receipt): order part-received, 60 to come',
    async () => {
      await supervisor.goto(orderUrl);
      await supervisor.getByRole('link', { name: 'Receive goods' }).click();
      await supervisor.waitForURL(/\/purchasing\/receipts\/new/);
      const accepted = supervisor.getByLabel('Accepted quantity, line 1');
      if ((await accepted.inputValue()) !== '100') throw new Error('accepted was not prefilled');
      await accepted.fill('40');
      await supervisor.getByLabel('Supplier challan / delivery note').fill('E2E-DC-1');
      await supervisor.getByRole('button', { name: 'Record receipt' }).click();
      await supervisor.waitForURL(/\/purchasing\/receipts\/[0-9a-f-]{36}$/);
      await supervisor.getByRole('heading', { name: /GRN\// }).waitFor();
      await supervisor.goto(orderUrl);
      await supervisor.getByRole('heading', { level: 1 }).getByText('Part-received').waitFor();
      const row = supervisor.getByRole('row').filter({ hasText: 'RM-MS2' });
      await row.getByRole('cell', { name: '60', exact: true }).waitFor();
    },
    supervisor,
  );

  await check(
    'stock rose by exactly 40 (through the inventory module, not the browser)',
    async () => {
      const diff = new Dec(await stockOf(order.warehouseId)).minus(stockBefore);
      if (!diff.equals(40)) throw new Error(`stock moved by ${diff.toString()}, expected 40`);
    },
  );

  await check(
    'supervisor receives the remaining 60: order received in full',
    async () => {
      await supervisor.getByRole('link', { name: 'Receive goods' }).click();
      const accepted = supervisor.getByLabel('Accepted quantity, line 1');
      if ((await accepted.inputValue()) !== '60') throw new Error('remaining was not prefilled');
      await supervisor.getByRole('button', { name: 'Record receipt' }).click();
      await supervisor.waitForURL(/\/purchasing\/receipts\/[0-9a-f-]{36}$/);
      await supervisor.goto(orderUrl);
      await supervisor
        .getByRole('heading', { level: 1 })
        .getByText('Received', { exact: true })
        .waitFor();
    },
    supervisor,
  );

  await check(
    "accountant enters the supplier's bill against the PO; the three-way match agrees",
    async () => {
      await accountant.goto(orderUrl);
      await accountant.getByRole('link', { name: 'Enter supplier bill' }).click();
      await accountant.waitForURL(/\/purchasing\/bills\/new/);
      const qty = accountant.getByLabel('Quantity billed, line 1');
      await qty.waitFor();
      if ((await qty.inputValue()) !== '100') throw new Error('billed quantity was not prefilled');
      await accountant.getByLabel("Supplier's bill number").fill(`${code}/001`);
      await accountant.getByLabel('Total on the bill (₹)').fill('5900.00');
      await accountant.getByRole('button', { name: 'Save draft' }).click();
      await accountant.getByRole('heading', { name: /Draft bill/ }).waitFor();
      billUrl = accountant.url();
      await accountant.getByText('The bill agrees with the purchase order').waitFor();
    },
    accountant,
  );

  await check(
    'accountant posts the bill: numbered, owed to the supplier',
    async () => {
      await accountant.getByRole('button', { name: 'Post bill' }).click();
      await accountant.getByRole('button', { name: 'Post ₹5,900.00' }).click();
      const heading = accountant.getByRole('heading', { name: /PI\/\d{2}-\d{2}\/\d{5}/ });
      await heading.waitFor();
      billNumber = /PI\/\d{2}-\d{2}\/\d{5}/.exec(await heading.innerText())?.[0] ?? '';
      await accountant.getByRole('heading', { level: 1 }).getByText('Unpaid').waitFor();
      await accountant.getByTestId('bill-outstanding').getByText('₹5,900.00').waitFor();
    },
    accountant,
  );

  await check(
    'accountant records the payment, which waits for a second person',
    async () => {
      await accountant.getByRole('link', { name: 'Record payment' }).click();
      await accountant.waitForURL(/\/finance\/supplier-payments\/new/);
      const amount = accountant.getByLabel('Amount (₹)');
      await amount.waitFor();
      if ((await amount.inputValue()) !== '5900.00') throw new Error('amount was not prefilled');
      const alloc = accountant.getByLabel(`Pay ${billNumber}`);
      if ((await alloc.inputValue()) !== '5900.00') throw new Error('allocation not prefilled');
      await accountant.getByLabel('Reference (UTR / cheque no.)').fill('E2E-NEFT-1');
      await accountant.getByRole('button', { name: 'Send for approval' }).click();
      await accountant.waitForURL(/\/finance\/supplier-payments\/[0-9a-f-]{36}$/);
      paymentUrl = accountant.url();
      await accountant.getByText('Awaiting approval').first().waitFor();
      if ((await accountant.getByRole('button', { name: 'Approve' }).count()) > 0) {
        throw new Error('the accountant can approve a payment');
      }
      // Nothing is paid until it is approved.
      await accountant.goto(billUrl);
      await accountant.getByTestId('bill-outstanding').getByText('₹5,900.00').waitFor();
    },
    accountant,
  );

  await check(
    'owner approves the payment: numbered, the bill is settled',
    async () => {
      await owner.goto(paymentUrl);
      await owner.getByRole('button', { name: 'Approve' }).click();
      await owner.getByRole('button', { name: 'Approve ₹5,900.00' }).click();
      await owner.getByRole('heading', { name: /PAY\/\d{2}-\d{2}\/\d{5}/ }).waitFor();
      await owner.getByRole('cell', { name: billNumber }).waitFor();
    },
    owner,
  );

  await check(
    'the bill is paid and nothing is owed to the supplier (derived on the server)',
    async () => {
      await accountant.goto(billUrl);
      await accountant
        .getByRole('heading', { level: 1 })
        .getByText('Paid', { exact: true })
        .waitFor();
      await accountant.getByTestId('bill-outstanding').getByText('₹0.00').waitFor();
      await accountant.goto(`${BASE_URL}/finance/payables`);
      const row = accountant.getByRole('row').filter({ hasText: supplierName });
      await row.waitFor();
      await row.getByText('₹0.00').first().waitFor();
    },
    accountant,
  );

  await check('stock rose by exactly 100 in total', async () => {
    const diff = new Dec(await stockOf(order.warehouseId)).minus(stockBefore);
    if (!diff.equals(100)) throw new Error(`stock moved by ${diff.toString()}, expected 100`);
  });

  await check(
    'maker-checker: whoever records a payment cannot approve it',
    async () => {
      await owner.goto(`${BASE_URL}/finance/supplier-payments/new`);
      const supplier = owner.getByLabel('Supplier');
      await supplier.fill(code);
      await owner.getByRole('option', { name: new RegExp(code) }).waitFor();
      await supplier.press('Enter');
      await owner.getByLabel('Amount (₹)').fill('1000.00');
      await owner.getByText('No unpaid bills for this supplier').waitFor();
      await owner.getByRole('button', { name: 'Send for approval' }).click();
      await owner.waitForURL(/\/finance\/supplier-payments\/[0-9a-f-]{36}$/);
      await owner.getByText('You recorded this payment.').waitFor();
      if (await owner.getByRole('button', { name: 'Approve' }).isEnabled()) {
        throw new Error('the maker can approve their own payment');
      }
    },
    owner,
  );

  await check('no unexpected browser console errors', () => {
    const errors = allErrors();
    if (errors.length) throw new Error(errors.join('\n'));
    return Promise.resolve();
  });

  process.stdout.write(`All ${steps()} procure-to-pay checks passed (PO ${poNumber}).\n`);
} finally {
  await browser.close();
}
