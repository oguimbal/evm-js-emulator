import { Record, RecordOf, List, Map as ImMap } from 'immutable';
import { compileCode } from './compiler';
import { CompiledCode, ExecState, HexString, IMemReader, IRpc, ISession, IStorage, NewTxData } from './interfaces';
import { MemReader } from './mem-reader';
import { RpcStorage } from './storage';
import { dumpU256, getNodejsLibs, to0xAddress, toUint } from './utils';

interface TxInfo {
    /** tx origin */
    readonly origin: bigint;
    readonly gasPrice: bigint;
    readonly forceTimestamp: number | undefined;
    readonly timestampDelta: number | undefined;
    readonly difficulty: bigint;
}

interface State {
    readonly session: ISession;
    /** Shared immutable state */
    readonly currentTx: TxInfo;
    /** List of modified/cached storages */
    readonly storages: ImMap<bigint, IStorage>;
    /** Current stack */
    readonly callStack: List<Stack>;
    /** Deployed contracts */
    readonly contracts: ImMap<bigint, CompiledCode>;
}
interface Stack {
    readonly calldata: IMemReader;
    readonly static: boolean;
    readonly callValue: bigint;
    readonly address: bigint;
    readonly caller: bigint;
    readonly retdatasize: number;
    readonly currentStorageCtx: bigint;
}

const newStore = Record<State>({
    session: null!,
    currentTx: null!,
    storages: ImMap(),
    callStack: List(),
    contracts: ImMap(),
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
    get forceTimestamp(): number | undefined {
        return this.store.currentTx.forceTimestamp;
    }

    get timestampDelta(): number | undefined {
        return this.store.currentTx.timestampDelta;
    }

    get difficulty(): bigint {
        return this.store.currentTx.difficulty;
    }
    get callvalue(): bigint {
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
    get gasPrice(): bigint {
        return this.shared.gasPrice;
    }
    get caller(): bigint {
        return this.stack.caller;
    }
    get shared(): TxInfo {
        return this.store.currentTx;
    }
    get address(): bigint {
        return this.stack.address;
    }
    get origin(): bigint {
        return this.store.currentTx.origin;
    }

    private get current0x() {
        return this.stack.currentStorageCtx;
    }
    get currentStorage() {
        return this.getStorageOf(this.current0x);
    }


    async getContract(hex: HexString | bigint): Promise<CompiledCode> {
        const contractAddress = typeof hex === 'string' ? toUint(hex) : hex;
        let compiled = this.store.contracts.get(contractAddress);

        if (!compiled) {
            const hex = to0xAddress(contractAddress);
            const code = await this.getBytecodeFromCache(contractAddress);
            compiled = compileCode(code, this.session.opts?.contractsNames?.[hex], contractAddress, undefined, this.session.opts?.cacheDir);
            const contracts = this.store.contracts.set(contractAddress, compiled);
            // it is ok to mutate store, since this is repeteable in case the current tx reverts
            this.store = this.store.set('contracts', contracts);
        }
        return compiled!;
    }

    private async getBytecodeFromCache(contractAddr: bigint) {
        const contract = to0xAddress(contractAddr);
        const { readCache, writeCache } = getNodejsLibs(this.session.opts?.cacheDir);
        const cacheFile = `bytecode/${contract}.bytecode`;

        if (readCache) {
            // when running nodejs, check if we have this contract in cache
            const cached = readCache(cacheFile);
            if (cached) {
                return Buffer.from(cached, 'hex').subarray();
            }
        }

        // download contract
        const online = await this.session.rpc.getCode(contract);

        if (writeCache) {
            // when running nodejs, cache the contract
            writeCache(cacheFile, Buffer.from(online).toString('hex'));
        }

        return online;
    }

    setContract(contract: CompiledCode): ExecState {
        const contracts = this.store.contracts.set(contract.contractAddress, contract);
        return new BlockchainState(this.store.set('contracts', contracts));
    }

    getStorageOf(hex: HexString | bigint): IStorage {
        hex = typeof hex === 'string' ? toUint(hex) : hex;
        let cached = this.store.storages.get(hex);
        if (!cached) {
            const storages = this.store.storages.set(hex, cached = new RpcStorage(to0xAddress(hex), this.session.rpc));
            this.store = this.store.set('storages', storages);
        }
        return cached;
    }

    private _changeStorage(account: bigint, fn: (storage: IStorage) => IStorage) {
        const currentStorage = this.getStorageOf(account);
        const newStorage = fn(currentStorage);
        return new BlockchainState(this.store.set('storages', this.store.storages.set(account, newStorage)));
    }

    getStorage(location: bigint): bigint | Promise<bigint> {
        return this.currentStorage.get(location);
    }

    getBalance(): bigint | Promise<bigint> {
        return this.currentStorage.getBalance();
    }

    setStorage(location: bigint, value: bigint): ExecState {
        return this._changeStorage(this.current0x, s => s.set(location, value));
    }



    async transferFrom(from: bigint, to: bigint, value: bigint): Promise<BlockchainState> {
        if (value === 0n) {
            return this;
        }

        // check has enough funds
        const fromBalance = await this.getStorageOf(from).getBalance();
        if (fromBalance<value) {
            throw new Error(`Insufficient balance in ${to0xAddress(from)} to transfer ${dumpU256(value)} to ${to}`);
        }

        // modify state
        return this._changeStorage(from, s => s.decrementBalance(value))
            ._changeStorage(to, s => s.incrementBalance(value));
    }


    transfer(_to: bigint, value: bigint): Promise<BlockchainState> {
        return this.transferFrom(this.stack.currentStorageCtx, _to, value);
    }

    mintValue(toAddress: bigint, value: bigint) {
        return this._changeStorage(toAddress, s => s.incrementBalance(value));
    }

    async newTx(data: NewTxData): Promise<ExecState> {
        if (this.store.callStack.size) {
            throw new Error('A tx is already being executed');
        }
        const full: Stack = {
            address: data.address ?? data.contract,
            calldata: new MemReader(data.calldata),
            caller: data.caller ?? data.origin,
            callValue: data.callvalue,
            currentStorageCtx: data.contract,
            retdatasize: data.retdatasize,
            static: data.static,
        };
        if (data.timestamp && data.timestampDelta) {
            throw new Error('Cannot set both timestamp and timestampDelta');
        }
        let ret = new BlockchainState(this.store
            .set('currentTx', {
                forceTimestamp: data.timestamp,
                timestampDelta: data.timestampDelta,
                gasPrice: data.gasPrice,
                origin: data.origin,
                difficulty: data.difficulty ?? 0n,
            })
        )
        ret = await ret.transferFrom(full.caller, full.address, full.callValue)
        return ret.pushCallStack(full);
    }

    private pushCallStack(stack: Partial<Stack>): ExecState {
        return new BlockchainState(this.store.set('callStack', this.store.callStack.push({
            ...this.store.callStack.last(),
            ...stack,
        })));
    }

    setStorageLocation(address: bigint, storage: IStorage): ExecState {
        throw new Error('Method not implemented.');
    }

    async pushCallTo(contract: bigint, callValue: bigint, calldata: Uint8Array, retdatasize: number): Promise<ExecState> {
        if (this.static) {
            throw new Error('Opcode "call" is not valid on a static execution context');
        }

        // transfer value
        let ret = await this
            .transfer(contract, callValue);


        return ret.pushCallStack({
            ...this._buildStack(calldata, retdatasize),
            address: contract,
            currentStorageCtx: contract,  // switch to the called contract's context  (balance & storage)
            callValue,
            caller: this.address,
        })
    }

    pushDelegatecallTo(contract: bigint, calldata: Uint8Array, retdatasize: number): ExecState {
        return this.pushCallStack({
            ...this._buildStack(calldata, retdatasize),
        });
    }

    pushStaticcallTo(contract: bigint, calldata: Uint8Array, retdatasize: number): ExecState {
        return this.pushCallStack({
            ...this._buildStack(calldata, retdatasize),
            address: contract, // only change contract address
            currentStorageCtx: contract,  // switch to the called contract's context  (balance & storage)
            caller: this.address,
            callValue: 0n,
            static: true,
        });
    }

    private _buildStack(calldata: Uint8Array, retdatasize: number): Partial<Stack> {
        // TODO implement gas properly
        // if (this.gas.lt(gasLimit)) {
        //     throw new Error('Not enough gas');
        // }
        return {
            calldata: new MemReader(calldata),
            retdatasize,
        };
    }

    popCallStack(): ExecState {
        const ret = new BlockchainState(this.store.set('callStack', this.store.callStack.pop()));
        return ret;
    }

    /** @deprecated use with care */
    setStorageInstance(contract: bigint, storage: IStorage) {
        this.store = this.store.set('storages', this.store.storages.set(contract, storage));
    }

}

/** @deprecated use with care */
export function setStorageInstance(inState: ExecState, contract: bigint, storage: IStorage) {
    return (inState as BlockchainState).setStorageInstance(contract, storage);
}
