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

declare var __non_webpack_require__: any;
declare var require: any;
export function getNodejsLibs(cacheDir?: string) {
    let req: any = undefined;
    if (typeof __non_webpack_require__ === 'function') {
        req = __non_webpack_require__;
    } else if (typeof require === 'function') {
        req = require;
    }
    if (req) {
        const fs = req('fs');
        const path = req('path');
        const process = req('process');
        const ensureDir = (dir: string) => {
            const parent = path.resolve(dir, '..');
            if (!fs.existsSync(parent)) {
                ensureDir(parent);
            }
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir);
            }
        };
        const globalCache = cacheDir
            ? path.resolve(process.cwd(), cacheDir)
            : path.resolve(process.cwd(), '.evm-js-cache');
        return {
            require: req,
            writeCache: (_file: string, content: string) => {
                const file = path.resolve(globalCache, _file);
                ensureDir(path.resolve(file, '..'));
                fs.writeFileSync(file, content);
                return file;
            },
            readCache: (_file: string, expire?: number) => {
                const file = path.resolve(globalCache, _file);
                if (!fs.existsSync(file)) {
                    return null;
                }
                return fs.readFileSync(file, 'utf-8');
            },
            expireDir: (_dir: string, expire: number) => {
                const cachePath = path.resolve(globalCache, _dir);
                if (!fs.existsSync(cachePath)) {
                    return;
                }
                const stat = fs.statSync(cachePath);
                if (Date.now() - stat.ctimeMs > expire) {
                    // invalidate cache
                    fs.rmSync(cachePath, { recursive: true, force: true });
                    fs.mkdirSync(cachePath);
                }
            },
        };
    }
    return {};
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
