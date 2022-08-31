import { Record, RecordOf, List, Map as ImMap } from 'immutable';
import { ExecState, HexString, IMemReader, IRpc, ISession, IStorage, NewTxData } from './interfaces';
import { MemReader } from './mem-reader';
import { RpcStorage } from './storage';
import { U256, UInt256 } from './uint256';
import { dumpU256, to0xAddress } from './utils';

interface TxInfo {
    /** tx origin */
    readonly origin: UInt256;
    readonly gasPrice: UInt256;
    readonly timestamp: number;
}

interface State {
    readonly session: ISession;
    /** Shared immutable state */
    readonly currentTx: TxInfo;
    /** List of modified/cached storages */
    readonly storages: ImMap<HexString, IStorage>;
    /** Current stack */
    readonly callStack: List<Stack>;
}
interface Stack {
    readonly gas: UInt256;
    readonly calldata: IMemReader;
    readonly gasLimit: UInt256;
    readonly static: boolean;
    readonly callValue: UInt256;
    readonly address: UInt256;
    readonly caller: UInt256;
    readonly retdatasize: number;
    readonly currentStorageCtx: UInt256;
}

const newStore = Record<State>({
    session: null!,
    currentTx: null!,
    storages: ImMap(),
    callStack: List(),
})
export function newBlockchain(session: ISession) {
    return new BlockchainState(newStore().set('session', session));
}

class BlockchainState implements ExecState {

    constructor(private store: RecordOf<State>) {
    }

    get stack() {
        const last = this.store.callStack.last();
        if (!last) {
            throw new Error('No running transaction');
        }
        return last;
    }
    get timestamp(): number {
        return this.store.currentTx.timestamp;
    }
    get gasLimit(): UInt256 {
        return this.stack.gasLimit;
    }
    get callvalue(): UInt256 {
        return this.stack.callValue;
    }
    get calldata(): IMemReader {
        return this.stack.calldata;
    }
    get static(): boolean {
        return this.stack.static;
    }
    get session(): ISession {
        return this.store.session;
    }
    get gas(): UInt256 {
        return this.stack.gas.copy();
    }
    get gasPrice(): UInt256 {
        return this.shared.gasPrice.copy();
    }
    get caller(): UInt256 {
        return this.stack.caller;
    }
    get shared(): TxInfo {
        return this.store.currentTx;
    }
    get address(): UInt256 {
        return this.stack.address;
    }
    get origin(): UInt256 {
        return this.stack.caller;
    }

    private get current0x() {
        return to0xAddress(this.stack.currentStorageCtx);
    }
    get currentStorage() {
        return this.getStorageOf(this.current0x);
    }

    getStorageOf(hex: HexString | UInt256): IStorage {
        hex = typeof hex === 'string' ? hex : to0xAddress(hex);
        let cached = this.store.storages.get(hex);
        if (!cached) {
            const storages = this.store.storages.set(hex, cached = new RpcStorage(hex, this.session.rpc));
            this.store = this.store.set('storages', storages);
        }
        return cached;
    }

    private _changeStorage(hex: HexString, fn: (storage: IStorage) => IStorage) {
        const currentStorage = this.getStorageOf(hex);
        const newStorage = fn(currentStorage);
        return new BlockchainState(this.store.set('storages', this.store.storages.set(hex, newStorage)));
    }

    getStorage(location: UInt256): UInt256 | Promise<UInt256> {
        return this.currentStorage.get(location);
    }

    getBalance(): UInt256 | Promise<UInt256> {
        return this.currentStorage.getBalance();
    }

    setStorage(location: UInt256, value: UInt256): ExecState {
        return this._changeStorage(this.current0x, s => s.set(location, value));
    }

    async transfer(_to: UInt256, value: UInt256): Promise<BlockchainState> {
        if (value.eq(0)) {
            return this;
        }
        const from = this.current0x;
        const to = to0xAddress(_to);

        // check has enough funds
        const fromBalance = await this.getBalance();
        if (fromBalance.lt(value)) {
            throw new Error(`Insufficient balance in ${from} to transfer ${dumpU256(value)} to ${to}`);
        }

        // modify state
        return this._changeStorage(from, s => s.decrementBalance(value))
            ._changeStorage(to, s => s.incrementBalance(value));
    }

    decrementGas(num: number | UInt256): void {
        if (this.gas.lt(num)) {
            throw new Error('Out of gas');
        }
        // decrement in a mutable way ()
        this.gas.sub(num, true);
    }

    newTx(data: NewTxData): ExecState {
        if (this.store.callStack.size) {
            throw new Error('A tx is already being executed');
        }
        const full: Stack = {
            address: data.contract,
            calldata: new MemReader(data.calldata),
            caller: data.caller ?? data.origin,
            callValue: data.callvalue,
            currentStorageCtx: data.contract,
            gas: data.gasLimit.copy(),
            gasLimit: data.gasLimit.copy(),
            retdatasize: data.retdatasize,
            static: data.static,
        };
        return new BlockchainState(this.store
            .set('currentTx', {
                timestamp: data.timestamp,
                gasPrice: data.gasPrice,
                origin: data.origin,
            })
        ).pushCallStack(full);
    }

    private pushCallStack(stack: Partial<Stack>): ExecState {
        return new BlockchainState(this.store.set('callStack', this.store.callStack.push({
            ...this.store.callStack.last(),
            ...stack,
            gas: (stack.gas ?? this.stack.gas).copy(),
        })));
    }

    setStorageLocation(address: UInt256, storage: IStorage): ExecState {
        throw new Error('Method not implemented.');
    }

    async pushCallTo(contract: UInt256, callValue: UInt256, calldata: Uint8Array, retdatasize: number, gasLimit: UInt256): Promise<ExecState> {
        if (this.static) {
            throw new Error('Opcode "call" is not valid on a static execution context');
        }

        // transfer value
        let ret = await this
            .transfer(contract, callValue);


        return ret.pushCallStack({
            ...this._buildStack(calldata, retdatasize, gasLimit),
            address: contract,
            currentStorageCtx: contract,  // switch to the called contract's context  (balance & storage)
            callValue,
        })
    }

    pushDelegatecallTo(contract: UInt256, calldata: Uint8Array, retdatasize: number, gasLimit: UInt256): ExecState {
        return this.pushCallStack({
            ...this._buildStack(calldata, retdatasize, gasLimit),
        });
    }

    pushStaticcallTo(contract: UInt256, calldata: Uint8Array, retdatasize: number, gasLimit: UInt256): ExecState {
        return this.pushCallStack({
            ...this._buildStack(calldata, retdatasize, gasLimit),
            address: contract, // only change contract address
            currentStorageCtx: contract,  // switch to the called contract's context  (balance & storage)
            static: true,
        });
    }

    private _buildStack(calldata: Uint8Array, retdatasize: number, gasLimit: UInt256): Partial<Stack> {
        if (this.gas.lt(gasLimit)) {
            throw new Error('Not enough gas');
        }
        return {
            calldata: new MemReader(calldata),
            retdatasize,
            gasLimit,
            gas: gasLimit,
        };
    }

    popCallStack(): ExecState {
        const ret = new BlockchainState(this.store.set('callStack', this.store.callStack.pop()));
        return ret;
    }

    /** @deprecated use with care */
    setStorageInstance(contract: UInt256, storage: IStorage) {
        this.store = this.store.set('storages', this.store.storages.set(to0xAddress(contract), storage));
    }

}

/** @deprecated use with care */
export function setStorageInstance(inState: ExecState, contract: UInt256, storage: IStorage) {
    return (inState as BlockchainState).setStorageInstance(contract, storage);
}
