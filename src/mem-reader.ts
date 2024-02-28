import { IMemReader } from './interfaces';
import { toUint } from './utils';

export class MemReader<T extends number[] | Uint8Array = number[] | Uint8Array> implements IMemReader {

    constructor(protected mem: T) { }

    get size(): number {
        return this.mem.length;
    }

    get(offset: number): bigint {
        return toUint(this.mem.slice(offset, offset + 32));
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
