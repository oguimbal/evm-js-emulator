import { Buffer } from 'buffer';
import { U256, UInt256 } from './uint256';
import seedRandom from 'seedrandom';
import { HexString } from './interfaces';
import keccak256 from 'keccak256';


export const MAX_UINT = toUint('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');

export function toUint(buf: Uint8Array | HexString | string): UInt256 {
    if (typeof buf === 'string') {
        if (buf.startsWith('0x')) {
            buf = buf.substring(2);
        }
        buf = parseBuffer(buf);
    }
    const ab = new ArrayBuffer(32);
    const view = new Uint8Array(ab);
    for (let i = 0; i < buf.length; ++i) {
        view[i] = buf[buf.length - i - 1];
    }
    return U256(ab);
}

export function deriveU256FromBuffer(buffer: Uint8Array | Buffer, zerosUntil = 0): UInt256 {
    const prng = seedRandom(Buffer.from(buffer).toString('hex'));
    const ab = new ArrayBuffer(32);
    const buf = new Uint8Array(ab);
    for (let i = zerosUntil; i < 20; i++) {
        buf[i] = Math.floor(prng() * 256);
    }
    return U256(ab);
}

export function to0xAddress(address: UInt256): HexString {
    // const ret = dumpU256(address);
    const ret = address.toString(16);
    if (!/^0*[a-fA-F\d]{0,40}$/.test(ret)) {
        throw new Error(`Not an address: ${ret}`);
    }
    return `0x${ret.padStart(40, '0')}`;
}

export function from0x(address: HexString): UInt256 {
    const hex = address.substring(2);
    return toUint(parseBuffer(hex));
}

export function dumpU256(num: UInt256): string {
    return num.toString(16);
}

export function generateAddress(seed: string | Buffer | Uint8Array) {
    if (typeof seed === 'string') {
        seed = parseBuffer(seed);
    }
    if (seed instanceof Buffer) {
        seed = seed.subarray()
    }
    return deriveU256FromBuffer(seed, 32 - 20);
}

const MAX_NUM = U256(Number.MAX_SAFE_INTEGER);
export function toNumberSafe(num: UInt256): number {
    if (num.gt(MAX_NUM)) {
        throw new Error('not expecting such a high number for this operation');
    }
    return parseInt(num.toString());
}

export function shaOf(buffer: Uint8Array): UInt256 {
    const hashed = keccak256(Buffer.from(buffer));
    return toUint(hashed.subarray());
}


declare var require: any;
export function getNodejsLibs() {
    if (typeof require === 'function') {
        const fs = require('fs');
        const path = require('path');
        const process = require('process');
        return { require, fs, path, process };
    }
    return {};
}

export function parseBuffer(data: HexString | string): Uint8Array {
    if (data.startsWith('0x')) {
        data = data.substring(2);
    }
    return Buffer.from(data, 'hex').subarray();
}