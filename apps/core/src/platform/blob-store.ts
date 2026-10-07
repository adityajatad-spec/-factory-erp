import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { uuidv7 } from './ids';
import { sha256Hex } from './json';

export interface StoredBlob {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

/** Content-addressed blob storage. Local filesystem now; an S3-compatible store later. */
export interface BlobStore {
  put(bytes: Buffer): Promise<StoredBlob>;
  read(storageKey: string): Promise<Buffer>;
}

const KEY_PATTERN = /^sha256\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

export class FileBlobStore implements BlobStore {
  readonly #root: string;

  constructor(rootDir: string) {
    this.#root = path.resolve(rootDir);
  }

  async put(bytes: Buffer): Promise<StoredBlob> {
    const sha256 = sha256Hex(bytes);
    const storageKey = `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
    const target = this.#resolve(storageKey);
    const exists = await stat(target).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await mkdir(path.dirname(target), { recursive: true });
      // Write-then-rename so readers never observe a partial file.
      const tmp = `${target}.${uuidv7()}.tmp`;
      await writeFile(tmp, bytes, { flag: 'wx' });
      await rename(tmp, target);
    }
    return { storageKey, sha256, sizeBytes: bytes.length };
  }

  async read(storageKey: string): Promise<Buffer> {
    return readFile(this.#resolve(storageKey));
  }

  #resolve(storageKey: string): string {
    if (!KEY_PATTERN.test(storageKey)) throw new Error(`Invalid storage key: ${storageKey}`);
    return path.join(this.#root, storageKey);
  }
}
