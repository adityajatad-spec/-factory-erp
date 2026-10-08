/**
 * E2E journey — running the factory without a developer (Slice 0):
 *   1. the owner creates an accountant's sign-in (first password generated, shown once)
 *   2. the accountant must choose their own password before anything else works
 *   3. the accountant renames a customer; the invoice already issued keeps the old name
 *   4. a customer with money still owed cannot be archived
 *   5. the accountant cannot reach user administration
 *   6. the owner deactivates the sign-in; it stops working
 *   7. repeated wrong passwords make the next attempt wait
 */
import type { PartyDto } from '@factory-erp/contracts';
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

const { check, steps } = createChecker('admin');
const run = Date.now().toString(36).toLowerCase();
const username = `acct-${run}`;
const VIEW = {
  viewport: { width: 1440, height: 900 },
  locale: 'en-IN',
  timezoneId: 'Asia/Kolkata',
};

async function signInAs(page: Page, user: string, password: string) {
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const browser = await launchBrowser();
try {
  const owner = await browser.newPage(VIEW);
  // Expected refusals: the accountant's 403 (admin page) and 422 (archive while money is owed).
  const ownerErrors = watchConsole(owner);
  let firstPassword = '';
  let ownPassword = '';
  let customer: PartyDto | undefined;
  let invoiceUrl = '';

  process.stdout.write(`Factory ERP e2e administration → ${BASE_URL}\n`);

  await check(
    'owner creates an accountant; the first password is shown once',
    async () => {
      await login(owner, 'owner');
      await owner.getByRole('link', { name: 'Users & roles' }).click();
      await owner.getByRole('heading', { name: 'Users & roles' }).waitFor();
      await owner.getByRole('button', { name: 'New user' }).click();
      const dialog = owner.getByRole('dialog');
      await dialog.getByLabel('Username').fill(username);
      await dialog.getByLabel('Full name').fill('E2E Accountant');
      await dialog.getByLabel(/^Accountant/).check();
      firstPassword = await dialog.getByLabel('First password').inputValue();
      if (firstPassword.length < 10) throw new Error('no generated first password');
      await dialog.getByRole('button', { name: 'Create user' }).click();
      const shown = await owner.getByTestId('new-user-password').innerText();
      if (shown !== firstPassword) throw new Error('the password shown is not the one set');
      await owner.getByRole('button', { name: 'Done' }).click();
      const row = owner.getByRole('row', { name: new RegExp(username) });
      await row.getByText('Temporary password').waitFor();
    },
    owner,
  );

  const acct = await browser.newPage(VIEW);
  const acctErrors = watchConsole(acct, [403, 422]);
  await check(
    'the accountant must choose their own password before anything else',
    async () => {
      await signInAs(acct, username, firstPassword);
      await acct.getByRole('heading', { name: 'Choose your own password' }).waitFor();
      await acct.goto(`${BASE_URL}/sales/invoices`);
      await acct.getByRole('heading', { name: 'Choose your own password' }).waitFor();
      ownPassword = `my own ${run} phrase`;
      await acct.getByLabel('Current password').fill(firstPassword);
      await acct.getByLabel('New password', { exact: true }).fill(ownPassword);
      await acct.getByLabel('New password again').fill(ownPassword);
      await acct.getByRole('button', { name: 'Change password' }).click();
      await acct.getByRole('heading', { name: 'Invoices' }).waitFor();
    },
    acct,
  );

  await check(
    'renaming a customer leaves the issued invoice unchanged',
    async () => {
      const code = `E2E-R-${run}`.toUpperCase().slice(0, 20);
      customer = await api<PartyDto>(acct, 'POST', '/parties', {
        code,
        name: `${code} before rename`,
        isCustomer: true,
        isSupplier: false,
        stateCode: '27',
      });
      const inv = await issueInvoiceViaUi(acct, customer.code, '1', '₹289.00');
      invoiceUrl = inv.url;
      await acct.goto(`${BASE_URL}/sales/customers`);
      await acct.getByPlaceholder(/Search name, code, GSTIN/).fill(customer.code);
      await acct.getByRole('cell', { name: customer.code, exact: true }).click();
      const dialog = acct.getByRole('dialog');
      await dialog.getByLabel('Name').fill(`${code} after rename`);
      await dialog.getByLabel('City').fill('Nashik');
      await dialog.getByRole('button', { name: 'Save changes' }).click();
      await acct.getByRole('cell', { name: `${code} after rename` }).waitFor();
      await acct.goto(invoiceUrl);
      await acct.getByText(`${code} before rename`).first().waitFor();
      if (await acct.getByText(`${code} after rename`).count())
        throw new Error('the issued invoice shows the new name');
    },
    acct,
  );

  await check(
    'a customer who still owes money cannot be archived',
    async () => {
      if (!customer) throw new Error('no customer');
      await acct.goto(`${BASE_URL}/sales/customers`);
      await acct.getByPlaceholder(/Search name, code, GSTIN/).fill(customer.code);
      await acct.getByRole('cell', { name: customer.code, exact: true }).click();
      await acct.getByRole('dialog').getByRole('button', { name: 'Archive' }).click();
      await acct
        .getByRole('dialog')
        .getByText(/cannot be archived while it has ₹289.00 still receivable/)
        .waitFor();
      await acct.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    },
    acct,
  );

  await check(
    'the accountant cannot reach user administration',
    async () => {
      if (await acct.getByRole('link', { name: 'Users & roles' }).count())
        throw new Error('accountant sees the admin link');
      await acct.goto(`${BASE_URL}/admin/users`);
      await acct.getByText(/do not have permission/).waitFor();
    },
    acct,
  );

  await check(
    'the owner deactivates the sign-in; it stops working at once',
    async () => {
      await owner.reload();
      await owner.getByRole('row', { name: new RegExp(username) }).click();
      await owner.getByRole('button', { name: 'Deactivate sign-in' }).click();
      await owner
        .getByRole('row', { name: new RegExp(username) })
        .getByText('Deactivated')
        .waitFor();
      // The open session is gone…
      await acct.goto(`${BASE_URL}/sales/invoices`);
      await acct.waitForURL(/\/login/);
      // …and signing in again is refused.
      await signInAs(acct, username, ownPassword);
      await acct.getByText('Incorrect username or password').waitFor();
    },
    owner,
  );

  await check(
    'repeated wrong passwords make the next attempt wait (for any username)',
    async () => {
      const probe = await browser.newPage(VIEW);
      try {
        for (let i = 0; i < 5; i++) {
          await signInAs(probe, `nobody-${run}`, `wrong ${i}`);
          await probe.getByText('Incorrect username or password').waitFor();
        }
        await signInAs(probe, `nobody-${run}`, 'wrong again');
        await probe.getByText(/Too many failed sign-in attempts/).waitFor();
      } finally {
        await probe.close();
      }
    },
    owner,
  );

  await check('no unexpected browser console errors', () => {
    const errors = [...ownerErrors, ...acctErrors];
    if (errors.length) throw new Error(errors.join('\n'));
    return Promise.resolve();
  });

  process.stdout.write(`All ${steps()} administration checks passed.\n`);
} finally {
  await browser.close();
}
