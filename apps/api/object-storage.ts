import OSS from 'ali-oss';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

export interface ObjectStorage {
  driver: 'local' | 'oss';
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}
export interface OssOptions {
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  prefix?: string;
}
export type ObjectRef = { driver: ObjectStorage['driver']; key: string };
const validateKey = (key: string) => {
  if (!/^[a-zA-Z0-9_/-]{1,500}$/.test(key) || key.startsWith('/') || key.includes('//'))
    throw new Error('Invalid storage key');
  return key;
};
export class LocalObjectStorage implements ObjectStorage {
  readonly driver = 'local';
  constructor(private root: string) {}
  private path(key: string) {
    const path = resolve(this.root, validateKey(key));
    if (!path.startsWith(resolve(this.root) + sep)) throw new Error('Invalid storage path');
    return path;
  }
  async put(key: string, data: Buffer) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { mode: 0o600, flag: 'wx' });
  }
  get(key: string) {
    return readFile(this.path(key));
  }
  async stream(key: string) {
    return createReadStream(this.path(key));
  }
  async remove(key: string) {
    await unlink(this.path(key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}
export class OssObjectStorage implements ObjectStorage {
  readonly driver = 'oss';
  readonly client: OSS;
  private prefix: string;
  constructor(options: OssOptions) {
    if (!options.region || !options.bucket || !options.accessKeyId || !options.accessKeySecret)
      throw new Error('OSS configuration is incomplete');
    this.prefix = options.prefix || 'lightmao/v1/';
    validateKey(this.prefix.replace(/\/$/, ''));
    if (!this.prefix.endsWith('/')) this.prefix += '/';
    this.client = new OSS({
      region: options.region.startsWith('oss-') ? options.region : `oss-${options.region}`,
      bucket: options.bucket,
      accessKeyId: options.accessKeyId,
      accessKeySecret: options.accessKeySecret,
      secure: true,
      authorizationV4: true,
      timeout: 45000,
    });
  }
  private key(key: string) {
    return this.prefix + validateKey(key);
  }
  async put(key: string, data: Buffer, mime: string) {
    await this.client.put(this.key(key), data, {
      headers: {
        'Content-Type': mime,
        'x-oss-object-acl': 'private',
        'Cache-Control': 'private, no-store',
      },
    });
  }
  async get(key: string) {
    const result = await this.client.get(this.key(key));
    return Buffer.from(result.content);
  }
  async stream(key: string) {
    const result = await this.client.getStream(this.key(key));
    return result.stream;
  }
  async remove(key: string) {
    await this.client.delete(this.key(key));
  }
}
