import { utils } from 'ethers';
import { KnownSequence } from './compiler';
import type { UInt256 } from './uint256';

export interface IStorage {
    get(location: UInt256): Promise<UInt256> | UInt256;
    set(location: UInt256, value: UInt256): IStorage;
    getBalance(): Promise<UInt256> | UInt256;
    decrementBalance(value: UInt256): IStorage;
    incrementBalance(value: UInt256): IStorage;
}


export type CompiledCode = ((exec: IExecutor) => () => void) & {
    readonly code: IMemReader;
    readonly contractName: string;
    readonly contractAbi: utils.Interface | undefined;
    readonly contractAddress: UInt256;
};


export interface IMemReader {
    readonly size: number;
    get(offset: number): UInt256;
    getByte(offset: number): number;
    slice(offset: number, size: number): Uint8Array;
    sliceNoPad(offset: number, size: number): Uint8Array;
}
export interface NewTxData {
    contract: UInt256;
    retdatasize: number;
    calldata: Uint8Array;
    gasPrice: UInt256;
    /** True when this is a static call (meaning that we cant modify anything) */
    static: boolean;
    /** User who sent this transaction */
    origin: UInt256;
    /** @deprecated use with care */
    caller?: UInt256;
    /** @deprecated use with care */
    address?: UInt256;
    /** How much ETH has been sent for this execution */
    callvalue: UInt256;
    gasLimit: UInt256;
    timestamp: number;
    difficulty?: UInt256;
}

export interface IRpc {
    getChainId(): Promise<Uint8Array>
    getBlock(): Promise<Uint8Array>
    getCode(contract: HexString): Promise<Uint8Array>
    getStorageAt(address: HexString, key: HexString): Promise<UInt256>
    getBalance(key: HexString): Promise<UInt256>
}
export interface ExecState {
    readonly timestamp: number;
    readonly difficulty: UInt256
    readonly address: UInt256;
    readonly caller: UInt256;
    readonly origin: UInt256;

    /** How much gas is left */
    readonly gas: UInt256;
    /** How much gas has been spent */
    readonly gasSpent: UInt256;
    readonly gasPrice: UInt256;
    readonly gasLimit: UInt256;
    readonly callvalue: UInt256;
    readonly calldata: IMemReader;
    readonly static: boolean
    readonly session: ISession;


    newTx(data: NewTxData): Promise<ExecState>;

    decrementGas(num: number | UInt256): void;

    getStorage(location: UInt256): Promise<UInt256> | UInt256;
    getStorageOf(dummy: HexString | UInt256): IStorage;
    getBalance(): Promise<UInt256> | UInt256;


    setStorage(location: UInt256, value: UInt256): ExecState;
    setStorageLocation(address: UInt256, storage: IStorage): ExecState;
    transfer(to: UInt256, value: UInt256): Promise<ExecState>;
    /** Augment to given address with the given ETH value (use for tests) */
    mintValue(to: UInt256, value: UInt256): ExecState;

    // call stack
    pushCallTo(contract: UInt256, callValue: UInt256, calldata: Uint8Array, returnDataSize: number, gasLimit: UInt256): Promise<ExecState>;
    pushDelegatecallTo(contract: UInt256, calldata: Uint8Array, returnDataSize: number, gasLimit: UInt256): ExecState;
    pushStaticcallTo(contract: UInt256, calldata: Uint8Array, returnDataSize: number, gasLimit: UInt256): ExecState;
    popCallStack(): ExecState;
}

export type HexString = `0x${string}`;

export interface DeployOpts {
    balance?: UInt256;
    name?: string;
    knownSequences?: KnownSequence[];
    forceId?: UInt256;
    onStartCall?: (executor: IExecutor) => void;
}

export interface SessionOpts {
    rpcUrl?: string;
    cacheDir?: string;
    /** Discard RPC cache after this period (defaults to 1 day) */
    maxRpcCacheTime?: number;
    contractsNames?: { [key: string]: string | { name: string; abi: utils.Interface } };
}

export interface ISession {
    readonly rpc: IRpc;
    readonly state: ExecState;
    getContract(contract: HexString | UInt256): Promise<CompiledCode>;
    prepareCall(input: NewTxData): Promise<IExecutor>;
    prepareStaticCall(contract: HexString | UInt256, calldata: string | Uint8Array, returnDataSize: number): Promise<IExecutor>;
    addNames(names?: SessionOpts['contractsNames']): this;
    deploy(code: string | Buffer | Uint8Array, opts: Omit<NewTxData, 'contract'>, deployOpts?: DeployOpts): Promise<UInt256>;
}


export type StopReason =
    | { type: 'stop', data?: null; newState: ExecState; gas: UInt256; }
    | { type: 'return'; data: Uint8Array; newState: ExecState; gas: UInt256; }
    | { type: 'end of code', data?: null; newState: ExecState; gas: UInt256; }
    | Revert;

type Revert = { type: 'revert'; data: Uint8Array; gas: UInt256 };

export function isSuccess(result: StopReason) {
    return result.type === 'stop' || result.type === 'end of code' || result.type === 'return';
}
export function isFailure(result: StopReason): result is Revert {
    return result.type === 'revert';
}

export interface IExecutor {
    readonly contractName: string;
    readonly contractAbi: utils.Interface | undefined;
    readonly state: ExecState;
    readonly contractAddress: UInt256;
    readonly stack: readonly UInt256[];
    readonly logs: readonly Log[];
    execute(): Promise<StopReason>
    watch(handler: (opcode: number, opName: string, paddedOpName: string, opSpy: string[], inKnownSequence: string | null) => any): void;
    onMemChange(fn: (bytes: () => number[]) => void): void;
    onStartingCall(fn: OnStartingCall): void;
    onLog(fn: OnLog): void;
    onEndingCall(fn: OnEndedCall): void;
    onResult(handler: (ret: StopReason) => void): void;
    pop(): UInt256;
    popAsNum(): number;
    popAsBool(): boolean;
    dumpCalldata(): string[];
    dumpMemory(): string[];
    dumpStack(): string[];
}

export type OnStartingCall = (exec: IExecutor, callType: 'call' | 'callcode' | 'staticcall' | 'delegatecall' | 'create2') => void;
export type OnEndedCall = (exec: IExecutor, callType: 'call' | 'callcode' | 'staticcall' | 'delegatecall' | 'create2', success: boolean, reason: StopReason | undefined) => void;
export type OnLog = (log: Log) => void;
export interface Log {
    readonly topics: readonly UInt256[];
    readonly data: Uint8Array;
    readonly address: UInt256;
}
