import * as dotenv from 'dotenv';
dotenv.config()
import { Buffer } from 'buffer';
import { compileCode, KnownSequence } from './compiler';
import { newBlockchain, setStorageInstance } from './blockchain-state';
import { Executor } from './executor';
import { CompiledCode, ExecState, NewTxData, HexString, IExecutor, ISession, isFailure, IStorage, SessionOpts } from './interfaces';
import { RPC } from './rpc';
import { MemStorage } from './storage';
import { U256, UInt256 } from './uint256';
import { from0x, getNodejsLibs, parseBuffer, to0xAddress, toUint } from './utils';

interface DeployOpts {
    balance?: UInt256;
    name?: string;
    knownSequences?: KnownSequence[];
    forceId?: UInt256,
}

export function newSession(opts?: SessionOpts) {
    return new Session(opts);
}
export class Session implements ISession {
    private contracts = new Map<string, CompiledCode>();
    readonly rpc: RPC;
    state: ExecState = newBlockchain(this);

    constructor(private opts?: SessionOpts) {
        this.rpc = new RPC(opts?.rpcUrl ?? process.env.RPC_URL, opts?.maxRpcCacheTime);
        if (opts?.contractsNames) {
            opts.contractsNames = Object.fromEntries(Object.entries(opts.contractsNames)
                .map(([k, v]) => [k.toLowerCase(), v]));
        }
    }

    addNames(names?: SessionOpts['contractsNames']) {
        if (!names) {
            return this;
        }
        this.opts ??= {};
        this.opts.contractsNames = {
            ...this.opts.contractsNames,
            ...Object.fromEntries(Object.entries(names)
                .map(([k, v]) => [k.toLowerCase(), v])),
        }
        return this;
    }

    /** Run deployment contract */
    async deploy(code: string | Buffer | Uint8Array, opts: Omit<NewTxData, 'contract'>, deployOpts?: DeployOpts) {
        // create a memory storage, that will be the deployed contract storage
        const storage = new MemStorage(deployOpts?.balance ?? U256(0));

        // deploy constructor & prepare its execution
        const deployer = this.deployRaw(code, {}, storage);
        const executor = await this.prepareCall({
            ...opts,
            contract: deployer,
        });

        // delete this intermediate deployer contract
        this.contracts.delete(this.contractKey(deployer));

        // execute constructor
        const result = await executor.execute();
        if (result.type !== 'return') {
            throw new Error('Was expecting a constructor in bytecode... use .deployRaw() if you want de deploy a raw contract code');
        }

        // deploy the actual code of this contract,
        // along with the storage initialized by the constructor
        const contract = await this.deployRaw(result.data, deployOpts, storage);
        return contract;
    }

    /** Deploy raw code (whihout running the constructor) */
    deployRaw(code: string | Buffer | Uint8Array, opts?: DeployOpts, rawStorage?: IStorage) {
        if (typeof code === 'string') {
            code = Buffer.from(code, 'hex');
        }
        if (code instanceof Buffer) {
            code = code.subarray()
        }
        const compiled = compileCode(code, opts?.name ?? (a => this.opts?.contractsNames?.[a]), opts?.forceId, opts?.knownSequences);
        this.contracts.set(to0xAddress(compiled.contractAddress), compiled);
        if (rawStorage) {
            setStorageInstance(this.state, compiled.contractAddress, rawStorage);
        }
        return compiled.contractAddress;
    }

    async prepareCall(input: NewTxData): Promise<IExecutor> {
        const code = await this.getContract(input.contract);
        const exec = new Executor(await this.state.newTx(input), code);
        exec.onResult(ret => {
            if (!isFailure(ret)) {
                this.state = ret.newState.popCallStack();
            }
        });
        return exec;
    }

    async prepareStaticCall(contract: HexString | UInt256, calldata: string | Uint8Array, returndatasize: number) {
        if (typeof calldata === 'string') {
            calldata = parseBuffer(calldata.startsWith('0x') ? calldata.substring(2) : calldata);
        }
        contract = typeof contract === 'string' ? from0x(contract) : contract

        return this.prepareCall({
            contract,
            static: true,
            calldata,
            origin: from0x('0x524a464e53208c1f87f6d56119acb667d042491a'),
            callvalue: U256(0),
            gasLimit: toUint('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
            gasPrice: U256(349834),
            retdatasize: returndatasize,
            timestamp: Date.now() / 1000,
        })
    }

    async getContract(contract: HexString | UInt256) {
        contract = typeof contract === 'string' ? from0x(contract) : contract
        const key = this.contractKey(contract);
        let compiled = this.contracts.get(key);
        if (!compiled) {
            const code = await this.getBytecodeFromCache(key);
            compiled = compileCode(code, this.opts?.contractsNames?.[key], contract);
            this.contracts.set(key, compiled);
        }
        return compiled!;
    }

    async getBytecodeFromCache(contract: HexString) {
        const { readCache, writeCache } = getNodejsLibs();
        const cacheFile = `bytecode/${contract}.bytecode`;

        if (readCache) {
            // when running nodejs, check if we have this contract in cache
            const cached = readCache(cacheFile);
            if (cached) {
                return Buffer.from(cached, 'hex').subarray();
            }
        }

        // download contract
        const online = await this.rpc.getCode(contract);

        if (writeCache) {
            // when running nodejs, cache the contract
            writeCache(cacheFile, Buffer.from(online).toString('hex'));
        }

        return online;
    }

    private contractKey(contract: HexString | UInt256) {
        return to0xAddress(typeof contract === 'string' ? from0x(contract) : contract);
    }
}
