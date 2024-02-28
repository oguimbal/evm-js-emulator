import { HexString, IRpc, IStorage } from './interfaces';
import { dumpU256, nullish } from './utils';
import { List, Map as ImMap } from 'immutable';

export class MemStorage implements IStorage {
    constructor(private balance: bigint, private storage = ImMap<bigint, bigint>()) {
        if (balance < 0) {
            throw new Error('Balance cannot be negative');
        }
    }
    getBalance(): bigint | Promise<bigint> {
        return this.balance;
    }
    decrementBalance(value: bigint): IStorage {
        return new MemStorage(this.balance - value);
    }
    incrementBalance(value: bigint): IStorage {
        return new MemStorage(this.balance + value);
    }
    get(location: bigint): Promise<bigint> | bigint {
        return this.storage.get(location) ?? 0n;
    }
    set(location: bigint, value: bigint): IStorage {
        return new MemStorage(this.balance, this.storage.set(location, value));
    }
}

export class RpcStorage implements IStorage {
    constructor(
        private address: HexString,
        private rpc: IRpc,
        private balance: bigint | null = null,
        private adds: List<bigint> = List(),
        private storage = ImMap<bigint, bigint>(),
    ) {}

    async get(location: bigint): Promise<bigint> {
        let cached = this.storage.get(location);
        if (cached) {
            return cached;
        }
        cached = await this.rpc.getStorageAt(this.address, location);
        cached ??= 0n;
        this.storage.set(location, cached);
        return cached;
    }

    private key(location: bigint): HexString {
        return `0x${dumpU256(location)}`;
    }

    set(location: bigint, value: bigint): IStorage {
        return new RpcStorage(this.address, this.rpc, this.balance, this.adds, this.storage.set(location, value));
    }

    async getBalance(): Promise<bigint> {
        if (!nullish(this.balance)) {
            return this.balance;
        }
        this.balance = (await this.rpc.getBalance(this.address)) ?? 0n;
        for (const a of this.adds) {
            this.balance += a;
        }
        this.adds = List();
        return this.balance;
    }

    decrementBalance(value: bigint): IStorage {
        if (nullish(this.balance)) {
            throw new Error('Should have checked balance first');
        }
        const nb = this.balance - value;
        if (nb < 0) {
            throw new Error('Balance cannot be negative');
        }
        return new RpcStorage(this.address, this.rpc, nb, this.adds, this.storage);
    }
    incrementBalance(value: bigint): IStorage {
        if (!nullish(this.balance)) {
            return new RpcStorage(this.address, this.rpc, this.balance + value, this.adds, this.storage);
        }
        return new RpcStorage(this.address, this.rpc, this.balance, this.adds.push(value), this.storage);
    }
}
