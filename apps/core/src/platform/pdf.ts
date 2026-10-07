import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';

/** Turns self-contained HTML into a PDF. Implementations must not fetch remote resources. */
export interface PdfRenderer {
  render(html: string): Promise<Buffer>;
  close(): Promise<void>;
}

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

export function findChromiumExecutable(configured?: string): string | undefined {
  if (configured) return existsSync(configured) ? configured : undefined;
  return CANDIDATES.find((p) => existsSync(p));
}

export class PdfRendererUnavailableError extends Error {
  constructor() {
    super('No Chromium/Chrome executable found for PDF rendering. Set PDF_BROWSER_EXECUTABLE.');
    this.name = 'PdfRendererUnavailableError';
  }
}

/** Headless Chromium via playwright-core (no bundled browser download). One browser, reused. */
export class ChromiumPdfRenderer implements PdfRenderer {
  readonly #executablePath: string | undefined;
  #browser: Promise<Browser> | undefined;

  constructor(executablePath?: string) {
    this.#executablePath = findChromiumExecutable(executablePath);
  }

  get available(): boolean {
    return this.#executablePath !== undefined;
  }

  async render(html: string): Promise<Buffer> {
    const browser = await this.#launch();
    // JavaScript off and all network requests blocked: the template is static HTML/CSS.
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    const b = this.#browser;
    this.#browser = undefined;
    if (b) await (await b).close();
  }

  #launch(): Promise<Browser> {
    if (!this.#executablePath) return Promise.reject(new PdfRendererUnavailableError());
    this.#browser ??= chromium
      .launch({
        executablePath: this.#executablePath,
        headless: true,
        // Chromium's sandbox cannot run as root (e.g. inside a container).
        args: process.getuid?.() === 0 ? ['--no-sandbox'] : [],
        // Our own graceful shutdown closes the browser AFTER in-flight outbox jobs finish;
        // Playwright's default handlers would kill it mid-render on SIGINT/SIGTERM.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      })
      .catch((err: unknown) => {
        this.#browser = undefined;
        throw err;
      });
    return this.#browser;
  }
}
