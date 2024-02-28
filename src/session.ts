import * as dotenv from 'dotenv';
dotenv.config();
import { Buffer } from 'buffer';
import { compileCode } from './compiler';
import { newBlockchain, setStorageInstance } from './blockchain-state';
import { Executor } from './executor';
import {
    ExecState,
    NewTxData,
    HexString,
    IExecutor,
    ISession,
    isFailure,
    IStorage,
    SessionOpts,
    DeployOpts,
    EIP,
} from './interfaces';
import { RPC } from './rpc';
import { U256, UInt256 } from './uint256';
import { parseBuffer, to0xAddress, toAddress, toUint } from './utils';

export function newSession(opts?: SessionOpts) {
    return new Session(opts);
}
export class Session implements ISession {
    readonly rpc: RPC;
    state: ExecState = newBlockchain(this);

    constructor(public opts?: SessionOpts) {
        this.rpc = new RPC(opts?.rpcUrl ?? process.env.RPC_URL, opts?.maxRpcCacheTime, opts?.rpcBlock, opts?.cacheDir);
        if (opts?.contractsNames) {
            opts.contractsNames = Object.fromEntries(
                Object.entries(opts.contractsNames).map(([k, v]) => [k.toLowerCase(), v]),
            );
        }
    }

    supports(eip: keyof EIP): boolean {
        return !this.opts?.eips || this.opts?.eips === 'all' || !!this.opts.eips[eip];
    }

    checkSupports(eip: keyof EIP): void {
        if (!this.supports(eip)) {
            throw new Error(`EIP ${eip} is not supported. Activate it with the 'eips' argument in options`);
        }
    }

    addNames(names?: SessionOpts['contractsNames']) {
        if (!names) {
            return this;
        }
        this.opts ??= {};
        this.opts.contractsNames = {
            ...this.opts.contractsNames,
            ...Object.fromEntries(Object.entries(names).map(([k, v]) => [k.toLowerCase(), v])),
        };
        return this;
    }

    /** Run deployment contract */
    async deploy(
        code: string | Buffer | Uint8Array,
        opts: Omit<NewTxData, 'contract'>,
        deployOpts?: DeployOpts,
    ): Promise<UInt256> {
        const exec = new Executor(
            await this.state.newTx({
                ...opts,
                contract: toAddress('0x00'),
            }),
            opts.gasLimit,
            (() => {}) as any,
        ); // hack

        const codeBuffer = toCode(code);
        const contractAddress = await exec.doCreate2(U256(0), codeBuffer, deployOpts?.balance ?? U256(0));
        this.state = exec.state.popCallStack();
        return contractAddress;
    }

    /** Deploy raw code (whihout running the constructor) */
    deployRaw(code: string | Buffer | Uint8Array, opts?: DeployOpts, rawStorage?: IStorage) {
        const compiled = compileCode(
            toCode(code),
            opts?.name ?? (a => this.opts?.contractsNames?.[a]),
            opts?.forceId,
            opts?.knownSequences,
            this.opts?.cacheDir,
        );
        this.state = this.state.setContract(compiled);
        if (rawStorage) {
            setStorageInstance(this.state, compiled.contractAddress, rawStorage);
        }
        return compiled.contractAddress;
    }

    async prepareCall(input: NewTxData): Promise<IExecutor> {
        const code = await this.getContract(input.contract);
        const exec = new Executor(await this.state.newTx(input), input.gasLimit, code);
        exec.onResult(ret => {
            if (!isFailure(ret)) {
                this.state = ret.newState.popCallStack();
            }
        });
        return exec;
    }

    async prepareStaticCall(_contract: HexString | UInt256, calldata: string | Uint8Array, returndatasize: number) {
        if (typeof calldata === 'string') {
            calldata = parseBuffer(calldata.startsWith('0x') ? calldata.substring(2) : calldata);
        }
        const contract = toAddress(_contract);

        return this.prepareCall({
            contract,
            static: true,
            calldata,
            origin: U256(0),
            callvalue: U256(0),
            gasLimit: toUint('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
            gasPrice: U256(349834),
            retdatasize: returndatasize,
        });
    }

    async getContract(_contract: HexString | UInt256) {
        return await this.state.getContract(_contract);
    }

    private contractKey(contract: HexString | UInt256) {
        return to0xAddress(toAddress(contract));
    }
}

function toCode(code: string | Buffer | Uint8Array): Uint8Array {
    if (typeof code === 'string') {
        return Buffer.from(code, 'hex');
    }
    if (code instanceof Buffer) {
        return code.subarray();
    }
    return code;
}
