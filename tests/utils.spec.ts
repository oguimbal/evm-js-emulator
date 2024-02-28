import 'mocha';
import { assert, expect } from 'chai';
import { deriveU256FromBuffer, dumpU256, to0xAddress, toUint } from '../src/utils';
import { Buffer } from 'buffer';
import { MemReader } from '../src/mem-reader';
import { incrementingArray, USDC } from './test-utils';
import { toBytes32 } from '../src/bytes';

describe('Utils', () => {
    it('deriveU256FromBuffer()', () => {
        const address = deriveU256FromBuffer(Buffer.from('random thing'), 32 - 20);
        expect(to0xAddress(address)).to.equal('0xdfe18ccb35e5a351000000000000000000000000');
    })

    it('to0xAddress()', () => {
        expect(to0xAddress(BigInt(1))).to.equal('0x0000000000000000000000000000000000000001');
        expect(to0xAddress(BigInt(0x12345AF))).to.equal('0x00000000000000000000000000000000012345af');
    });

    it ('from0x', () => {
        const asInt = toUint(USDC);
        expect(to0xAddress(asInt)).to.equal(USDC.toLowerCase());
    })

    it('toUint()', () => {
        const num = toUint(new Uint8Array([
            ...Array(32 - 4).fill(0),
            0x01,
            0x23,
            0x45,
            0xaf,
        ]));
        assert.equal(num, BigInt(0x12345af));
    });

    it('dumpU256()', () => {
        const num = toUint(new Uint8Array([
            ...Array(32 - 4).fill(0),
            0x01,
            0x23,
            0x45,
            0xaf,
        ]));
        expect(dumpU256(num)).to.equal('12345af');
    })

    it('u256 the expected layout', () => {
        const arr = toBytes32(0x12345AF);
        expect(arr.length).to.equal(32);
        const exp = Buffer.from([
            ...Array(32 - 4).fill(0),
            0x01,
            0x23,
            0x45,
            0xaf,
        ]);
        expect(arr).to.deep.equal(exp);
    });

    describe('MemReader', () => {
        it ('can read inside', () => {
            const reader = new MemReader(incrementingArray(100, 0, true));
            expect([...reader.slice(10, 10)]).to.deep.equal(incrementingArray(10, 10, true));
        });

        it ('can read outside', () => {
            const reader = new MemReader(incrementingArray(100, 0, true));
            expect([...reader.slice(1000, 10)]).to.deep.equal(Array(10).fill(0));
        });

        it ('can read overlap', () => {
            const reader = new MemReader(incrementingArray(100, 0, true));
            expect([...reader.slice(90, 20)]).to.deep.equal([
                ...incrementingArray(10, 90, true),
                ...Array(10).fill(0),
            ]);
        });
    })
})