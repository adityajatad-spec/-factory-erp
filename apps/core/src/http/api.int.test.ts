import type {
  CreditNoteDto,
  CreditNoteListItemDto,
  DashboardDto,
  InvoiceDto,
  ProblemDetails,
  SessionUser,
} from '@factory-erp/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, TEST_PASSWORD, type Fixture } from '../../test/fixtures';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import { ChromiumPdfRenderer } from '../platform/pdf';
import { buildApp } from './app';

const pdfRenderer = new ChromiumPdfRenderer(process.env.PDF_BROWSER_EXECUTABLE);

let env: TestEnv;
let fx: Fixture;
let app: FastifyInstance;
let key = 0;
const idem = () => ({ 'idempotency-key': `test-key-${Date.now()}-${++key}` });

beforeAll(async () => {
  env = await createTestEnv({ pdfRenderer });
  fx = await createFixture(env.services);
  app = await buildApp(env.services);
});
afterAll(async () => {
  await app.close();
  await env.destroy();
});

async function login(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password: TEST_PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'ferp_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  return `ferp_session=${cookie?.value ?? ''}`;
}

describe('health', () => {
  it('reports service and database health without authentication', async () => {
    expect((await app.inject('/api/v1/health')).json()).toMatchObject({ status: 'ok' });
    expect((await app.inject('/api/v1/health/db')).json()).toMatchObject({ status: 'ok' });
  });
});

describe('authentication', () => {
  it('rejects bad credentials with problem+json and no cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'owner', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json<ProblemDetails>().code).toBe('INVALID_CREDENTIALS');
    expect(res.cookies).toHaveLength(0);
  });

  it('gives the same answer for unknown users (no username enumeration)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'nobody', password: 'wrong' },
    });
    expect(res.json<ProblemDetails>().code).toBe('INVALID_CREDENTIALS');
  });

  it('logs in, reports the session user, and logs out (revoking the session)', async () => {
    const cookie = await login('accountant');
    const me = await app.inject({ url: '/api/v1/auth/me', headers: { cookie } });
    const user = me.json<SessionUser>();
    expect(user.roles).toEqual(['ACCOUNTANT']);
    expect(user.permissions).toContain('sales.invoice.issue');
    expect(user.company.legalName).toBe('Test Works Pvt Ltd');

    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } }))
        .statusCode,
    ).toBe(204);
    expect((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(
      401,
    );
  });

  it('requires a session for business routes', async () => {
    const res = await app.inject('/api/v1/sales-invoices');
    expect(res.statusCode).toBe(401);
    expect(res.json<ProblemDetails>().code).toBe('UNAUTHENTICATED');
  });

  it('sets security headers', async () => {
    const res = await app.inject('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('invoice flow over HTTP', () => {
  it('requires an Idempotency-Key on commands', async () => {
    const cookie = await login('accountant');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-invoices',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ProblemDetails>().issues?.[0]?.path).toBe('Idempotency-Key');
  });

  it('rejects text/plain bodies (CSRF hardening)', async () => {
    const cookie = await login('accountant');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/parties',
      headers: { cookie, 'content-type': 'text/plain', ...idem() },
      payload: '{"code":"X"}',
    });
    expect(res.statusCode).toBe(415);
  });

  it('drafts, issues, generates the PDF and shows up on the dashboard', async () => {
    const cookie = await login('accountant');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-invoices',
      headers: { cookie, ...idem() },
      payload: {
        customerId: fx.customers.inter.id,
        invoiceDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
          new Date(),
        ),
        lines: [
          { itemId: fx.items.widget.id, quantity: '3', unitRate: '999.99', discountPercent: '5' },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json<InvoiceDto>();
    expect(draft.totals.igstAmount).toBe('512.99');
    expect(draft.totals.grandTotal).toBe('3363.00');

    const issuedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-invoices/${draft.id}/issue`,
      headers: { cookie, ...idem() },
      payload: { expectedVersion: draft.version },
    });
    expect(issuedRes.statusCode).toBe(200);
    const issued = issuedRes.json<InvoiceDto>();
    expect(issued.invoiceNumber).toMatch(/^INV\//);

    const dash = (
      await app.inject({ url: '/api/v1/dashboard', headers: { cookie } })
    ).json<DashboardDto>();
    const kpi = (id: string) => dash.kpis.find((k) => k.id === id)?.value;
    expect(kpi('sales.today')).toBe('3363.00');
    expect(kpi('finance.receivables_outstanding')).toBe('3363.00');
    expect(kpi('sales.invoices_this_month')).toBe('1');
    expect(dash.recentInvoices?.[0]?.invoiceNumber).toBe(issued.invoiceNumber);

    const history = await app.inject({
      url: `/api/v1/audit-events?entityType=sales.invoice&entityId=${draft.id}`,
      headers: { cookie },
    });
    expect(history.json<Array<{ command: string }>>().map((e) => e.command)).toEqual([
      'sales.invoice.createDraft',
      'sales.invoice.issue',
    ]);

    if (!pdfRenderer.available) return; // PDF rendering needs a Chromium/Chrome binary
    expect(await env.services.outbox.runOnce()).toBe(1);
    const withPdf = (
      await app.inject({ url: `/api/v1/sales-invoices/${draft.id}`, headers: { cookie } })
    ).json<InvoiceDto>();
    expect(withPdf.pdfDocumentId).toBeTruthy();
    const pdf = await app.inject({
      url: `/api/v1/documents/${withPdf.pdfDocumentId ?? ''}/content`,
      headers: { cookie },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    // Idempotent outbox: nothing left to do, and no second PDF.
    expect(await env.services.outbox.runOnce()).toBe(0);
    const docs = await env.services.db.selectFrom('docs.documents').select('id').execute();
    expect(docs).toHaveLength(1);
  });

  it('filters dashboard KPIs by permission', async () => {
    const cookie = await login('worker');
    const dash = (
      await app.inject({ url: '/api/v1/dashboard', headers: { cookie } })
    ).json<DashboardDto>();
    expect(dash.kpis).toEqual([]);
    expect(dash.recentInvoices).toBeNull();
    const res = await app.inject({ url: '/api/v1/sales-invoices', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 problem+json for unknown API routes', async () => {
    const res = await app.inject('/api/v1/does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.json<ProblemDetails>().code).toBe('NOT_FOUND');
  });
});

describe('sales corrections over HTTP', () => {
  const today = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

  async function issuedInvoice(cookie: string): Promise<InvoiceDto> {
    const draft = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/sales-invoices',
        headers: { cookie, ...idem() },
        payload: {
          customerId: fx.customers.intra.id,
          invoiceDate: today(),
          lines: [{ itemId: fx.items.widget.id, quantity: '4', unitRate: '250' }],
        },
      })
    ).json<InvoiceDto>();
    return (
      await app.inject({
        method: 'POST',
        url: `/api/v1/sales-invoices/${draft.id}/issue`,
        headers: { cookie, ...idem() },
        payload: { expectedVersion: draft.version },
      })
    ).json<InvoiceDto>(); // 4 × 250 + 18 % = ₹1,180.00
  }

  it('drafts, rejects, edits, issues and renders a credit note through the API', async () => {
    const cookie = await login('accountant');
    const inv = await issuedInvoice(cookie);
    const url = `/api/v1/sales-invoices/${inv.id}/credit-notes`;
    const body = (lines: unknown[]) => ({
      customerId: inv.customerId,
      creditNoteDate: today(),
      reasonCode: 'SALES_RETURN',
      reason: 'One unit returned',
      lines,
    });

    const noKey = await app.inject({
      method: 'POST',
      url,
      headers: { cookie },
      payload: body([{ invoiceLineNo: 1, quantity: '1', unitRate: '250' }]),
    });
    expect(noKey.statusCode).toBe(400);

    const over = await app.inject({
      method: 'POST',
      url,
      headers: { cookie, ...idem() },
      payload: body([{ invoiceLineNo: 1, quantity: '5', unitRate: '250' }]),
    });
    expect(over.statusCode).toBe(422);
    expect(over.headers['content-type']).toContain('application/problem+json');
    expect(over.json<ProblemDetails>()).toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      detail: 'EXCEEDS_LINE_QUANTITY',
      issues: [{ path: 'lines.0.quantity' }],
    });

    const created = await app.inject({
      method: 'POST',
      url,
      headers: { cookie, ...idem() },
      payload: body([{ invoiceLineNo: 1, quantity: '1', unitRate: '250' }]),
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json<CreditNoteDto>();
    expect(draft).toMatchObject({ status: 'DRAFT', grandTotal: '295.00' });

    const edited = await app.inject({
      method: 'PUT',
      url: `/api/v1/credit-notes/${draft.id}`,
      headers: { cookie, ...idem() },
      payload: {
        ...body([{ invoiceLineNo: 1, quantity: '2', unitRate: '250' }]),
        expectedVersion: 1,
      },
    });
    expect(edited.json<CreditNoteDto>()).toMatchObject({ version: 2, grandTotal: '590.00' });

    const issued = await app.inject({
      method: 'POST',
      url: `/api/v1/credit-notes/${draft.id}/issue`,
      headers: { cookie, ...idem() },
      payload: { expectedVersion: 2 },
    });
    expect(issued.statusCode).toBe(200);
    expect(issued.json<CreditNoteDto>().creditNoteNumber).toMatch(/^CN\/\d{2}-\d{2}\/00001$/);

    const invoiceAfter = (
      await app.inject({ url: `/api/v1/sales-invoices/${inv.id}`, headers: { cookie } })
    ).json<InvoiceDto>();
    expect(invoiceAfter).toMatchObject({ creditedAmount: '590.00', outstandingAmount: '590.00' });
    const listed = (
      await app.inject({ url: `/api/v1/credit-notes?invoiceId=${inv.id}`, headers: { cookie } })
    ).json<CreditNoteListItemDto[]>();
    expect(listed.map((c) => c.id)).toEqual([draft.id]);

    if (!pdfRenderer.available) return; // PDF rendering needs a Chromium/Chrome binary
    await env.services.outbox.runOnce();
    const withPdf = (
      await app.inject({ url: `/api/v1/credit-notes/${draft.id}`, headers: { cookie } })
    ).json<CreditNoteDto>();
    const pdf = await app.inject({
      url: `/api/v1/documents/${withPdf.pdfDocumentId ?? ''}/content`,
      headers: { cookie },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('cancels an invoice once, for authorised users only', async () => {
    const cookie = await login('accountant');
    const inv = await issuedInvoice(cookie);
    const cancel = (c: string, version: number) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/sales-invoices/${inv.id}/cancel`,
        headers: { cookie: c, ...idem() },
        payload: { expectedVersion: version, reason: 'Raised against the wrong PO' },
      });

    const forbidden = await cancel(await login('worker'), inv.version);
    expect(forbidden.statusCode).toBe(403);

    const ok = await cancel(cookie, inv.version);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<InvoiceDto>()).toMatchObject({
      status: 'CANCELLED',
      invoiceNumber: inv.invoiceNumber,
      outstandingAmount: null,
      cancellation: { reason: 'Raised against the wrong PO' },
    });

    const again = await cancel(cookie, inv.version + 1);
    expect(again.statusCode).toBe(422);
    expect(again.json<ProblemDetails>().detail).toBe('INVOICE_ALREADY_CANCELLED');
  });
});
