import { Buffer } from 'buffer';
import { HexString } from './interfaces';
import keccak256 from 'keccak256';
import { bytesToBigInt, bytesToHex } from './bytes';
import seedRandom from 'seedrandom';
import { MAX_NUM } from './arithmetic';

export const MAX_UINT = toUint('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');

export type UIntSource = number | Uint8Array | HexString | string | bigint | number[];
export function toUint(buf: UIntSource): bigint {
    if (typeof buf === 'number') {
        return BigInt(buf);
    }
    if (typeof buf === 'bigint') {
        return buf;
    }
    if (typeof buf === 'string') {
        if (buf.startsWith('0x')) {
            buf = buf.substring(2);
        }
        buf = parseBuffer(buf);
    }
    if (Array.isArray(buf)) {
        buf = new Uint8Array(buf);
    }
    // const ab = new ArrayBuffer(32);
    // const view = new Uint8Array(ab);
    // for (let i = 0; i < buf.length; ++i) {
    //     view[i] = buf[buf.length - i - 1];
    // }
    // return U256(ab);
    return bytesToBigInt(buf);
}

export function nullish(val: any): val is null | undefined {
    return val === undefined || val === null;
}

const address_mask = toUint('000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
export function to0xAddress(address: HexString | bigint): HexString {
    if (typeof address === 'string') {
        return address;
    }
    const bn = address & address_mask;
    const ret = (address & address_mask).toString(16);
    return `0x${ret.padStart(40, '0')}`;
}

export function dumpU256(num: bigint): string {
    return num.toString(16);
}

export function generateAddress(seed: string | Buffer | Uint8Array): bigint {
    if (typeof seed === 'string') {
        seed = parseBuffer(seed);
    }
    if (seed instanceof Buffer) {
        seed = seed.subarray();
    }
    return deriveU256FromBuffer(seed, 32 - 20);
}

export function deriveU256FromBuffer(buffer: Uint8Array | Buffer, zerosUntil = 0): bigint {
    const prng = seedRandom(Buffer.from(buffer).toString('hex'));
    const ab = new ArrayBuffer(32);
    const buf = new Uint8Array(ab);
    for (let i = zerosUntil; i < 20; i++) {
        buf[i] = Math.floor(prng() * 256);
    }
    return toUint(buf);
}

export function toNumberSafe(num: bigint): number {
    if (num > MAX_NUM) {
        throw new Error('not expecting such a high number for this operation');
    }
    return parseInt(num.toString());
}

export function shaOf(buffer: Uint8Array): bigint {
    const hashed = keccak256(Buffer.from(buffer));
    return toUint(hashed.subarray());
}

const libByPath = new Map<string | undefined, NodejsLibs>();

export type NodejsLibs =
    | {
          require: undefined;
          writeCache: undefined;
          readCache: undefined;
      }
    | {
          require: (name: string) => any;
          writeCache: (file: string, content: string) => Promise<string>;
          readCache: (file: string) => Promise<string | null>;
      };

declare var __non_webpack_require__: any;
declare var require: any;
export function getNodejsLibs(cacheDir?: string): NodejsLibs {
    let cached = libByPath.get(cacheDir ?? undefined);
    if (cached) {
        return cached;
    }

    let req: any = undefined;
    if (typeof __non_webpack_require__ === 'function') {
        req = __non_webpack_require__;
    } else if (typeof require === 'function') {
        req = require;
    }
    if (req) {
        const fs = req('fs') as typeof import('fs');
        const path = req('path');
        const process = req('process');
        const exists = async (path: string) => {
            return await new Promise<boolean>((res, rej) => {
                fs.exists(path, res);
            });
        };
        const mkdir = async (path: string) => {
            return await new Promise<void>((res, rej) => {
                fs.mkdir(path, err => {
                    if (err && err.code !== 'EEXIST') {
                        rej(err);
                    } else {
                        res();
                    }
                });
            });
        };
        const ensured = new Set<string>();
        const ensureDir = async (dir: string) => {
            if (ensured.has(dir)) {
                return;
            }
            const parent = path.resolve(dir, '..');
            if (!(await exists(parent))) {
                await ensureDir(parent);
            }
            if (!(await exists(dir))) {
                await mkdir(dir);
            }
            ensured.add(dir);
        };
        const globalCache = cacheDir
            ? path.resolve(process.cwd(), cacheDir)
            : path.resolve(process.cwd(), '.evm-js-cache');
        cached = {
            require: req,
            writeCache: async (_file: string, content: string) => {
                const file = path.resolve(globalCache, _file);
                await ensureDir(path.resolve(file, '..'));
                await new Promise<void>((res, rej) => {
                    fs.writeFile(file, content, err => {
                        if (err) {
                            rej(err);
                        } else {
                            res();
                        }
                    });
                });
                return file;
            },
            readCache: async (_file: string) => {
                const file = path.resolve(globalCache, _file);
                if (!(await exists(file))) {
                    return null;
                }
                const result = await new Promise<string>((res, rej) => {
                    fs.readFile(file, 'utf-8', (err, data) => {
                        if (err) {
                            rej(err);
                        } else {
                            res(data);
                        }
                    });
                });
                return result ?? null;
            },
        };
    } else {
        cached = {
            require: undefined,
            writeCache: undefined,
            readCache: undefined,
        };
    }
    libByPath.set(cacheDir ?? undefined, cached);
    return cached;
}

export function parseBuffer(data: HexString | string): Uint8Array {
    if (data.startsWith('0x')) {
        data = data.substring(2);
    }
    if (data.length % 2) {
        data = '0' + data;
    }
    return Buffer.from(data, 'hex').subarray();
}

/**
 * Similar to Promise.all(), but limits parallelization to a certain numbe of parallel threads.
 */
export async function parallel<T>(
    concurrent: number,
    collection: Iterable<T>,
    processor: (item: T, i: number) => Promise<any>,
) {
    // queue up simultaneous calls
    const queue: any[] = [];
    const ret = [];
    let i = 0;
    for (const fn of collection) {
        // fire the async function, add its promise to the queue, and remove
        // it from queue when complete
        const p = processor(fn, i++).then(res => {
            queue.splice(queue.indexOf(p), 1);
            return res;
        });
        queue.push(p);
        ret.push(p);
        // if max concurrent, wait for one to finish
        if (queue.length >= concurrent) {
            // eslint-disable-next-line no-await-in-loop
            await Promise.race(queue);
        }
    }
    // wait for the rest of the calls to finish
    await Promise.all(queue);
}
