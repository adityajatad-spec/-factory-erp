/**
 * E2E journeys — the sales correction path (cancellation and credit notes):
 *   1. invoice → issue → cancel → cancelled state, no receivable left
 *   2. invoice → issue → partial credit note → issue → outstanding reduced
 *   3. invoice → receipt → partial credit note → final balance
 *   4. invoice → full credit note → zero outstanding (CREDITED)
 *   5. over-credit attempt → clean rejection, nothing changed in the database
 *
 * Each journey uses its own customer (set up through the API), so balances are exact and the
 * file can run on any freshly seeded database. Every invoice is 10 × BA-100 @ ₹245 + 18 % GST
 * = ₹2,891.00; crediting 2 units is ₹578.20 → ₹578.00 after rounding.
 */
import type {
  CreditNoteDto,
  CreditNoteListItemDto,
  InvoiceDto,
  OpenInvoiceDto,
  PartyDto,
  ReceivablesSummaryDto,
} from '@factory-erp/contracts';
import type { Page } from 'playwright-core';
import {
  api,
  BASE_URL,
  createChecker,
  issueInvoiceViaUi,
  launchBrowser,
  login,
  watchConsole,
} from './harness';

const { check, steps } = createChecker('corr');
const run = Date.now().toString(36).toUpperCase();
const CN_NUMBER = /CN\/\d{2}-\d{2}\/\d{5}/;
const seq = (n: string) => Number(n.split('/')[2]);

async function newCustomer(page: Page, n: number): Promise<PartyDto> {
  const code = `E2E-C${n}-${run}`.slice(0, 20);
  return api<PartyDto>(page, 'POST', '/parties', {
    code,
    name: `E2E Customer ${code}`,
    isCustomer: true,
    isSupplier: false,
    stateCode: '27',
  });
}

/**
 * From an invoice page: draft a credit note for `units` × BA-100, or — with the literal
 * `'full'` — for the whole invoice via "Credit full invoice".
 */
async function draftCreditNote(page: Page, units: string, expectedTotal: string) {
  await page.getByRole('link', { name: 'Credit note', exact: true }).click();
  await page.waitForURL(/\/sales\/credit-notes\/new\?invoiceId=/);
  await page.getByLabel('Reason details').fill('Units returned — e2e journey');
  if (units === 'full') await page.getByRole('button', { name: 'Credit full invoice' }).click();
  else await page.getByLabel('Credit quantity for line 1').fill(units);
  await page.getByTestId('credit-total').getByText(expectedTotal).waitFor();
  await page.getByRole('button', { name: /^Save draft/ }).click();
  await page.getByRole('heading', { name: /Draft credit note/ }).waitFor();
  return page.url();
}

async function issueCreditNote(page: Page, total: string): Promise<string> {
  await page.getByRole('button', { name: 'Issue credit note…' }).click();
  await page.getByRole('button', { name: `Issue for ${total}` }).click();
  const heading = page.getByRole('heading', { name: CN_NUMBER });
  await heading.waitFor();
  return CN_NUMBER.exec(await heading.innerText())?.[0] ?? '';
}

const browser = await launchBrowser();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  // Journey 5 deliberately provokes a 422 (rejected over-credit).
  const consoleErrors = watchConsole(page, [422]);
  const outstanding = page.getByTestId('invoice-outstanding');
  const heading = page.getByRole('heading', { level: 1 });
  let lastCreditNote = '';

  process.stdout.write(`Factory ERP e2e corrections → ${BASE_URL}\n`);

  await check('accountant signs in', async () => {
    await login(page, 'accountant');
    await page.getByText("Today's sales").waitFor();
  });

  // ── Journey 1 ────────────────────────────────────────────────────────────────────────────
  const c1 = await newCustomer(page, 1);
  let inv1 = { url: '', number: '', id: '' };
  await check(
    'J1: issue an invoice, then cancel it with a reason',
    async () => {
      inv1 = await issueInvoiceViaUi(page, c1.code, '10', '₹2,891.00');
      await page.getByRole('button', { name: 'Cancel invoice…' }).click();
      const dialog = page.getByRole('dialog');
      const confirm = dialog.getByRole('button', { name: 'Cancel invoice', exact: true });
      if (await confirm.isEnabled()) throw new Error('cancel allowed without a reason');
      await dialog.getByLabel('Reason for cancelling').fill('Raised against the wrong PO (e2e)');
      await confirm.click();
      await heading.getByText('CANCELLED', { exact: true }).waitFor();
    },
    page,
  );

  await check(
    'J1: cancelled invoice keeps its number, shows who/why, and owes nothing',
    async () => {
      await page.reload();
      await heading.getByText(inv1.number).waitFor();
      await page.getByRole('status').getByText('Raised against the wrong PO (e2e)').waitFor();
      await outstanding.getByText('Cancelled — nothing due').waitFor();
      for (const action of ['Record payment', 'Credit note']) {
        if ((await page.getByRole('link', { name: action, exact: true }).count()) > 0)
          throw new Error(`a cancelled invoice still offers "${action}"`);
      }
      if ((await page.getByRole('button', { name: 'Cancel invoice…' }).count()) > 0)
        throw new Error('a cancelled invoice can be cancelled again');
      await page.getByText('Cancelled — Raised against the wrong PO (e2e)').waitFor(); // history
    },
    page,
  );

  await check(
    'J1: no receivable remains — not open, not in ageing, listed under Cancelled',
    async () => {
      const open = await api<OpenInvoiceDto[]>(
        page,
        'GET',
        `/receivables/open-invoices?customerId=${c1.id}`,
      );
      if (open.length) throw new Error('cancelled invoice is still an open receivable');
      const s = await api<ReceivablesSummaryDto>(page, 'GET', '/receivables/summary');
      const row = s.customers.find((c) => c.customerId === c1.id);
      if (row && row.balance !== '0.00') throw new Error(`balance is ${row.balance}, not 0.00`);
      await page.goto(`${BASE_URL}/finance/receivables`);
      await page.getByRole('heading', { name: 'Receivables' }).waitFor();
      if ((await page.getByRole('row').filter({ hasText: c1.name }).count()) > 0)
        throw new Error('customer with a cancelled invoice still listed with a balance');
      await page.goto(`${BASE_URL}/sales/invoices?status=CANCELLED`);
      await page.getByRole('cell', { name: inv1.number }).waitFor();
    },
    page,
  );

  // ── Journey 2 ────────────────────────────────────────────────────────────────────────────
  const c2 = await newCustomer(page, 2);
  await check(
    'J2: partial credit note (2 of 10 units) drafted from the invoice and issued',
    async () => {
      const inv = await issueInvoiceViaUi(page, c2.code, '10', '₹2,891.00');
      await draftCreditNote(page, '2', '₹578.00');
      lastCreditNote = await issueCreditNote(page, '₹578.00');
      await page.getByRole('link', { name: inv.number }).click();
      await page.waitForURL(inv.url);
      await outstanding.getByText('₹2,313.00').waitFor();
      await heading.getByText('Unpaid', { exact: true }).waitFor();
      await page.getByRole('link', { name: lastCreditNote }).waitFor();
    },
    page,
  );

  await check(
    'J2: the issued credit note gets its SPECIMEN PDF',
    async () => {
      await page.getByRole('link', { name: lastCreditNote }).click();
      const open = page.getByRole('link', { name: 'Open PDF' });
      await open.waitFor({ timeout: 20_000 });
      const href = await open.getAttribute('href');
      const pdf = await page.request.get(`${BASE_URL}${href ?? ''}`);
      const body = await pdf.body();
      if (
        pdf.headers()['content-type'] !== 'application/pdf' ||
        body.subarray(0, 5).toString() !== '%PDF-'
      )
        throw new Error('credit note PDF missing or not a PDF');
      await page.getByText('Credit note PDF generated').waitFor();
    },
    page,
  );

  // ── Journey 3 ────────────────────────────────────────────────────────────────────────────
  const c3 = await newCustomer(page, 3);
  await check(
    'J3: invoice → ₹1,000 receipt → 2-unit credit note → ₹1,313.00 left to pay',
    async () => {
      const inv = await issueInvoiceViaUi(page, c3.code, '10', '₹2,891.00');
      await page.getByRole('link', { name: 'Record payment' }).click();
      await page.waitForURL(/\/finance\/receipts\/new/);
      await page.getByLabel('Amount received (₹)').fill('1000.00');
      await page.getByLabel(`Allocate to ${inv.number}`).fill('1000.00');
      await page.getByRole('button', { name: /^Record receipt/ }).click();
      await page.getByRole('heading', { name: /RCPT\// }).waitFor();
      await page.goto(inv.url);
      await outstanding.getByText('₹1,891.00').waitFor();

      await draftCreditNote(page, '2', '₹578.00');
      lastCreditNote = await issueCreditNote(page, '₹578.00');
      await page.goto(inv.url);
      await outstanding.getByText('₹1,313.00').waitFor();
      await heading.getByText('Part-paid', { exact: true }).waitFor();
      await page.getByText('Credited (credit notes)').waitFor();
    },
    page,
  );

  await check(
    'J3: receivables agree — customer balance ₹1,313.00',
    async () => {
      await page.goto(`${BASE_URL}/finance/receivables`);
      await page
        .getByRole('row')
        .filter({ hasText: c3.name })
        .getByText('₹1,313.00')
        .first()
        .waitFor();
    },
    page,
  );

  // ── Journey 4 ────────────────────────────────────────────────────────────────────────────
  const c4 = await newCustomer(page, 4);
  await check(
    'J4: a full credit note leaves ₹0.00 outstanding and marks the invoice Credited',
    async () => {
      const inv = await issueInvoiceViaUi(page, c4.code, '10', '₹2,891.00');
      await draftCreditNote(page, 'full', '₹2,891.00');
      lastCreditNote = await issueCreditNote(page, '₹2,891.00');
      await page.goto(inv.url);
      await outstanding.getByText('₹0.00').waitFor();
      await heading.getByText('Credited', { exact: true }).waitFor();
      for (const action of ['Record payment', 'Credit note']) {
        if ((await page.getByRole('link', { name: action, exact: true }).count()) > 0)
          throw new Error(`a fully credited invoice still offers "${action}"`);
      }
      if ((await page.getByRole('button', { name: 'Cancel invoice…' }).count()) > 0)
        throw new Error('a credited invoice offers cancellation');
    },
    page,
  );

  // ── Journey 5 ────────────────────────────────────────────────────────────────────────────
  const c5 = await newCustomer(page, 5);
  let inv5 = { url: '', number: '', id: '' };
  let draftUrl = '';
  await check(
    'J5: the editor itself refuses to credit more than was invoiced',
    async () => {
      inv5 = await issueInvoiceViaUi(page, c5.code, '10', '₹2,891.00');
      await page.getByRole('link', { name: 'Credit note', exact: true }).click();
      await page.getByLabel('Reason details').fill('Over-credit attempt (e2e)');
      await page.getByLabel('Credit quantity for line 1').fill('11');
      await page.getByText('Only 10.000 NOS were invoiced').waitFor();
      if (await page.getByRole('button', { name: /^Save draft/ }).isEnabled())
        throw new Error('over-credit draft could be saved');
      await page.goto(inv5.url);
      draftUrl = await draftCreditNote(page, 'full', '₹2,891.00'); // valid when drafted
    },
    page,
  );

  await check(
    'J5: after a payment lands, issuing the full credit is rejected cleanly',
    async () => {
      await api(page, 'POST', '/receipts', {
        customerId: c5.id,
        receiptDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
          new Date(),
        ),
        amount: '1000.00',
        paymentMode: 'UPI',
        allocations: [{ invoiceId: inv5.id, amount: '1000.00' }],
      });
      await page.goto(draftUrl);
      await page.getByRole('button', { name: 'Issue credit note…' }).click();
      await page.getByRole('button', { name: 'Issue for ₹2,891.00' }).click();
      await page
        .getByRole('dialog')
        .getByRole('alert')
        .getByText(/₹1,891\.00 outstanding/)
        .waitFor();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.reload();
      await page.getByRole('heading', { name: /Draft credit note/ }).waitFor();
    },
    page,
  );

  await check(
    'J5: nothing changed — draft unnumbered, invoice untouched, numbering still gapless',
    async () => {
      const id = draftUrl.split('/').pop() ?? '';
      const cn = await api<CreditNoteDto>(page, 'GET', `/credit-notes/${id}`);
      if (cn.status !== 'DRAFT' || cn.creditNoteNumber !== null)
        throw new Error(`credit note is ${cn.status} ${cn.creditNoteNumber ?? ''}`);
      const inv = await api<InvoiceDto>(page, 'GET', `/sales-invoices/${inv5.id}`);
      if (inv.creditedAmount !== '0.00' || inv.outstandingAmount !== '1891.00')
        throw new Error(
          `invoice changed: credited ${inv.creditedAmount}, outstanding ${inv.outstandingAmount ?? ''}`,
        );
      const issued = await api<CreditNoteListItemDto[]>(
        page,
        'GET',
        `/credit-notes?invoiceId=${inv5.id}&status=ISSUED`,
      );
      if (issued.length) throw new Error('a credit note was issued despite the rejection');

      // Reduce the draft to 2 units and issue: it takes the very next number.
      await page.getByRole('link', { name: 'Edit', exact: true }).click();
      await page.getByLabel('Credit quantity for line 1').fill('2');
      await page.getByTestId('credit-total').getByText('₹578.00').waitFor();
      await page.getByRole('button', { name: /^Save draft/ }).click();
      await page.getByRole('heading', { name: /Draft credit note/ }).waitFor();
      const next = await issueCreditNote(page, '₹578.00');
      if (seq(next) !== seq(lastCreditNote) + 1)
        throw new Error(`numbering gap: ${lastCreditNote} → ${next}`);
      const after = await api<InvoiceDto>(page, 'GET', `/sales-invoices/${inv5.id}`);
      if (after.outstandingAmount !== '1313.00')
        throw new Error(`outstanding is ${after.outstandingAmount ?? ''}`);
    },
    page,
  );

  await check(
    'credit notes list and command palette find the new credit note',
    async () => {
      await page.goto(`${BASE_URL}/sales/credit-notes?status=ISSUED`);
      await page.getByRole('cell', { name: lastCreditNote }).waitFor();
      await page.keyboard.press('Control+k');
      await page.getByPlaceholder(/credit note/).fill(lastCreditNote);
      await page
        .getByRole('option', { name: new RegExp(lastCreditNote.replace(/\//g, '\\/')) })
        .click();
      await page.getByRole('heading', { name: lastCreditNote }).waitFor();
    },
    page,
  );

  await check(
    'mobile: invoice and credit note pages fit a phone screen',
    async () => {
      const phone = await browser.newPage({
        viewport: { width: 390, height: 844 },
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
      });
      try {
        await login(phone, 'accountant');
        for (const url of [inv1.url, draftUrl, `${BASE_URL}/sales/credit-notes`]) {
          await phone.goto(url);
          await phone.getByRole('heading', { level: 1 }).waitFor();
          const overflow = await phone.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          if (overflow > 1) throw new Error(`${url} scrolls sideways by ${overflow}px on a phone`);
        }
      } finally {
        await phone.close();
      }
    },
    page,
  );

  await check('no unexpected browser console errors', () => {
    if (consoleErrors.length) throw new Error(consoleErrors.join('\n'));
    return Promise.resolve();
  });

  process.stdout.write(`All ${steps()} correction checks passed.\n`);
} finally {
  await browser.close();
}
