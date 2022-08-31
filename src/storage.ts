import { HexString, IRpc, IStorage } from './interfaces';
import { U256, UInt256 } from './uint256';
import { dumpU256 } from './utils';
import { List, Map as ImMap } from 'immutable';

export class MemStorage implements IStorage {
    constructor(private balance: UInt256, private storage = ImMap<string, UInt256>()) {
    }
    getBalance(): UInt256 | Promise<UInt256> {
        return this.balance.copy();
    }
    decrementBalance(value: UInt256): IStorage {
        return new MemStorage(this.balance.sub(value))
    }
    incrementBalance(value: UInt256): IStorage {
        return new MemStorage(this.balance.add(value))
    }
    get(location: UInt256): Promise<UInt256> | UInt256 {
        return this.storage.get(location.toString()) ?? U256(0);
    }
    set(location: UInt256, value: UInt256): IStorage {
        return new MemStorage(this.balance, this.storage.set(location.toString(), value));
    }
}

export class RpcStorage implements IStorage {
    constructor(private address: HexString,
        private rpc: IRpc,
        private balance: UInt256 | null = null,
        private adds: List<UInt256> = List(),
        private storage = ImMap<string, UInt256>()) { }

    async get(location: UInt256): Promise<UInt256> {
        const key = this.key(location);
        let cached = this.storage.get(key);
        if (cached) {
            return cached;
        }
        cached = await this.rpc.getStorageAt(this.address, key);
        cached ??= U256(0);
        this.storage.set(key, cached);
        return cached;
    }

    private key(location: UInt256): HexString {
        return `0x${dumpU256(location)}`;
    }

    set(location: UInt256, value: UInt256): IStorage {
        return new RpcStorage(this.address, this.rpc, this.balance, this.adds, this.storage.set(this.key(location), value));
    }

    async getBalance(): Promise<UInt256> {
        if (this.balance) {
            return this.balance;
        }
        this.balance = await this.rpc.getBalance(this.address) ?? U256(0);
        for (const a of this.adds) {
            this.balance = this.balance.add(a);
        }
        this.adds = List();
        return this.balance;
    }

    decrementBalance(value: UInt256): IStorage {
        if (!this.balance) {
            throw new Error('Should have checked balance first');
        }
        return new RpcStorage(this.address, this.rpc, this.balance.sub(value), this.adds, this.storage);
    }
    incrementBalance(value: UInt256): IStorage {
        if (this.balance) {
            return new RpcStorage(this.address, this.rpc, this.balance.add(value), this.adds, this.storage);
        }
        return new RpcStorage(this.address, this.rpc, this.balance, this.adds.push(value), this.storage);
    }
}
