import { U256, UInt256 } from './uint256';
import { Buffer } from 'buffer';
import { IMemReader } from './interfaces';

export class MemReader<T extends number[] | Uint8Array = number[] | Uint8Array> implements IMemReader {

    constructor(protected mem: T) { }

    get size(): number {
        return this.mem.length;
    }

    get(offset: number): UInt256 {
        const ab = new ArrayBuffer(32);
        const view = new Uint8Array(ab);
        const max = Math.max(32, this.mem.length - offset - 32);
        for (let i = 0; i < max; i++) {
            view[31 - i] = this.mem[offset + i] ?? 0;
        }
        return U256(ab);
    }
    getByte(offset: number): number {
        return this.mem[offset] ?? 0;
    }

    slice(offset: number, size: number): Uint8Array {
        const data = this.mem.slice(offset, offset + size);
        if (data.length >= size) {
            return new Uint8Array(data);
        }
        // extend with zeros
        const ret = new Uint8Array(size);
        for (let i = 0; i < data.length; i++) {
            ret[i] = data[i];
        }
        return ret;
    }

    sliceNoPad(offset: number, size: number): Uint8Array {
        return new Uint8Array(this.mem.slice(offset, offset + size));
    }
}
