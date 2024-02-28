import { utils } from 'ethers';
import { KnownSequence } from './compiler';

export interface IStorage {
    get(location: bigint): Promise<bigint> | bigint;
    set(location: bigint, value: bigint): IStorage;
    getBalance(): Promise<bigint> | bigint;
    decrementBalance(value: bigint): IStorage;
    incrementBalance(value: bigint): IStorage;
}


export type CompiledCode = ((exec: IExecutor) => () => void) & {
    readonly code: IMemReader;
    readonly contractName: string;
    readonly contractAbi: utils.Interface | undefined;
    readonly contractAddress: bigint;
};


export interface IMemReader {
    readonly size: number;
    get(offset: number): bigint;
    getByte(offset: number): number;
    slice(offset: number, size: number): Uint8Array;
    sliceNoPad(offset: number, size: number): Uint8Array;
}
export interface NewTxData {
    contract: bigint;
    retdatasize: number;
    calldata: Uint8Array;
    gasPrice: bigint;
    /** True when this is a static call (meaning that we cant modify anything) */
    static: boolean;
    /** User who sent this transaction */
    origin: bigint;
    /** @deprecated use with care */
    caller?: bigint;
    /** @deprecated use with care */
    address?: bigint;
    /** How much ETH has been sent for this execution */
    callvalue: bigint;
    gasLimit: bigint;
    /**
     * Force to a given timestamp.
     *
     * WARNING ! this is a bit dangerous when specified an RPC,
     *   as the timestamp you provide could be in the future
     *    => weird bugs to be expected while executing contracts (substraction overflows, ...)
     * ... prefer timestampDelta instead while using an RPC
     */
    timestamp?: number;
    /**
     * Place your transaction in the future compared to the blockchain by providing a timestamp delta
     */
    timestampDelta?: number;
    difficulty?: bigint;
}

export interface IRpc {
    getChainId(): Promise<Uint8Array>
    getBlock(): Promise<Uint8Array>
    getCode(contract: HexString): Promise<Uint8Array>
    getStorageAt(address: HexString, key: bigint): Promise<bigint>
    getBalance(key: HexString): Promise<bigint>
    getTimestamp(): Promise<number>;
}
export interface ExecState {
    readonly forceTimestamp: number | undefined;
    readonly timestampDelta: number | undefined;
    readonly difficulty: bigint
    readonly address: bigint;
    readonly caller: bigint;
    readonly origin: bigint;

    readonly gasPrice: bigint;
    readonly callvalue: bigint;
    readonly calldata: IMemReader;
    readonly static: boolean
    readonly session: ISession;


    newTx(data: NewTxData): Promise<ExecState>;

    getStorage(location: bigint): Promise<bigint> | bigint;
    getStorageOf(dummy: HexString | bigint): IStorage;
    getBalance(): Promise<bigint> | bigint;

    getContract(hex: HexString | bigint): Promise<CompiledCode>;
    setContract(contract: CompiledCode): ExecState;

    setStorage(location: bigint, value: bigint): ExecState;
    setStorageLocation(address: bigint, storage: IStorage): ExecState;
    transfer(to: bigint, value: bigint): Promise<ExecState>;
    /** Augment to given address with the given ETH value (use for tests) */
    mintValue(to: bigint, value: bigint): ExecState;

    // call stack
    pushCallTo(contract: bigint, callValue: bigint, calldata: Uint8Array, returnDataSize: number): Promise<ExecState>;
    pushDelegatecallTo(contract: bigint, calldata: Uint8Array, returnDataSize: number): ExecState;
    pushStaticcallTo(contract: bigint, calldata: Uint8Array, returnDataSize: number): ExecState;
    popCallStack(): ExecState;
}

export type HexString = `0x${string}`;

export interface DeployOpts {
    balance?: bigint;
    name?: string;
    knownSequences?: KnownSequence[];
    forceId?: bigint;
}

export interface SessionOpts {
    rpcUrl?: string;
    cacheDir?: string;
    rpcBlock?: HexString | number;
    /** Discard RPC cache after this period (defaults to 1 day) */
    maxRpcCacheTime?: number;
    contractsNames?: { [key: string]: string | { name: string; abi: utils.Interface } };
    /** EIPs to take into account (defaults to "all") */
    eips?: 'all' | EIP;
}

export interface EIP {
    eip_3855_push0?: boolean;
}

export interface ISession {
    readonly rpc: IRpc;
    readonly state: ExecState;
    readonly opts?: SessionOpts | undefined;
    getContract(contract: HexString | bigint): Promise<CompiledCode>;
    prepareCall(input: NewTxData): Promise<IExecutor>;
    prepareStaticCall(contract: HexString | bigint, calldata: string | Uint8Array, returnDataSize: number): Promise<IExecutor>;
    addNames(names?: SessionOpts['contractsNames']): this;
    deploy(code: string | Buffer | Uint8Array, opts: Omit<NewTxData, 'contract'>, deployOpts?: DeployOpts): Promise<bigint>;
    supports(eip: keyof EIP): boolean;
    checkSupports(eip: keyof EIP): void;
}


export type StopReason =
    | { type: 'stop', data?: null; newState: ExecState; gas: bigint; }
    | { type: 'return'; data: Uint8Array; newState: ExecState; gas: bigint; }
    | { type: 'end of code', data?: null; newState: ExecState; gas: bigint; }
    | Revert;

type Revert = { type: 'revert'; data: Uint8Array; gas: bigint };

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
    readonly contractAddress: bigint;
    readonly logs: readonly Log[];
    readonly gas: bigint;
    copyStack(): readonly bigint[];
    execute(): Promise<StopReason>
    watch(handler: (opcode: number, opName: string, paddedOpName: string, opSpy: string[], inKnownSequence: string | null) => any): void;
    onMemChange(fn: (bytes: () => number[]) => void): void;
    onStartingCall(fn: OnStartingCall): void;
    onLog(fn: OnLog): void;
    onEndingCall(fn: OnEndedCall): void;
    onResult(handler: (ret: StopReason) => void): void;
    pop(): bigint;
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
    readonly topics: readonly bigint[];
    readonly data: Uint8Array;
    readonly address: bigint;
}
