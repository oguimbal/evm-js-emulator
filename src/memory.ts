import { bigIntToBytes, setLengthLeft } from './bytes';
import { MemReader } from './mem-reader';

export class Memory extends MemReader<number[]> {
    onChange: (() => void) | null = null;

    constructor() {
        super([]);
    }


    set(index: number, byte: number) {
        if (byte < 0 || byte > 255) {
            throw new Error('Wrong byte value ' + byte);
        }
        this.resize(index + 1);
        this.mem[index] = byte;
        this.onChange?.();
    }

    setUint256(index: number, value: bigint) {
        this.resize(index + 32);
        const bytes = setLengthLeft(bigIntToBytes(value), 32)
        for (let i = 0; i < 32; i++) {
            this.mem[index + i] = bytes[i];
        }
        this.onChange?.();
    }

    resize(_toSize: number) {
        // only grow word by word
        const mod = _toSize % 32;
        const toSize = mod ? _toSize - mod + 32 : _toSize;

        // grow memory
        if (this.mem.length >= toSize) {
            return;
        }
        do {
            this.mem.push(0);
        } while (this.mem.length < toSize);
        this.onChange?.();
    }

    get(offset: number): bigint {
        this.resize(offset + 32); // getting memory triggers a resize if needed
        return super.get(offset);
    }

    getNoResize(offset: number): bigint | null {
        if (offset >= this.size) {
            return null;
        }
        return super.get(offset);
    }

    dump() {
        return [...this.mem];
    }
}