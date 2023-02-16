import { NewTxData, IExecutor, isSuccess, SessionOpts, ISession, HexString } from '../src/interfaces';
import { U256, UInt256 } from '../src/uint256';
import { Buffer } from 'buffer';
import { dumpU256, MAX_UINT, parseBuffer, to0xAddress, toNumberSafe, toUint } from '../src/utils';
import { KNOWN_CONTRACT, USDC } from './known-contracts';
import { utils } from 'ethers';
import { Session } from '../src/session';
import { setStorageInstance } from '../src/blockchain-state';
export * from './known-contracts';

export const VALID_CHAIN_IDS: number[] = [
    1,     // Ethereum
    56,    // BNB smart chain
    137,   // Polygon
    10,    // Optimism
    42161, // Arbitrum
    43114, // Avalanche
]

export const TEST_SESSION_OPTS: SessionOpts = {
    contractsNames: Object.fromEntries(KNOWN_CONTRACT.map(c => [c.address, c.name])),
}

export function newTxData(contract: UInt256, data?: Partial<NewTxData>): NewTxData {
    return {
        calldata: new Uint8Array(0),
        callvalue: U256(0),
        gasLimit: MAX_UINT,
        gasPrice: U256(0xffff),
        retdatasize: 0,
        static: false,
        origin: U256(0x1234),
        timestamp: Date.now() / 1000,
        ...data,
        contract,
    };
}

export function newDeployTxData(data?: Partial<NewTxData>): Omit<NewTxData, 'contract'> {
    return {
        calldata: new Uint8Array(0),
        callvalue: U256(0),
        gasLimit: U256(0xfffffffffff),
        gasPrice: U256(0xffff),
        retdatasize: 0,
        static: false,
        origin: U256(0x1234),
        timestamp: Date.now() / 1000,
        ...data,
    };
}


export async function executeBytecode(ops: string | number[], opts?: Partial<NewTxData>, mintSenderBalance?: UInt256) {
    const session = new Session(TEST_SESSION_OPTS);
    const contract = session.deployRaw(typeof ops === 'string' ? parseBuffer(ops) : Buffer.from(ops));
    const txData = newTxData(contract, opts);
    if (mintSenderBalance) {
        session.state = session.state.mintValue(txData.origin, mintSenderBalance);
    }
    const exec = await session.prepareCall(txData);
    const buffer = await execWatchInstructions(exec);
    return {
        result: [...buffer ?? []],
        exec,
    };
}

function showWelcome(newExec: IExecutor) {
    console.log(`ADDRESS: ${to0xAddress(newExec.state.address)}`);
    console.log(`CALLER: ${to0xAddress(newExec.state.caller)}`);
    console.log(`ORIGIN: ${to0xAddress(newExec.state.origin)}`);
    console.log(`GAS: 0x${dumpU256(newExec.state.gas)}`);
    console.log(`VALUE: 0x${dumpU256(newExec.state.callvalue)}`);
    const calldata = newExec.dumpCalldata();
    const key = to0xAddress(newExec.contractAddress);
    const knownAbi = newExec.contractAbi ?? KNOWN_CONTRACT.find(c => c.address === key)?.abi;
    if (knownAbi && calldata[0]?.length >= 8) {

        const raw = '0x' + calldata.join('');
        const sig = raw.substring(0, 10);
        try {
            const fn = knownAbi.getFunction(sig);
            const args = fn && knownAbi.decodeFunctionData(fn, raw);
            if (fn && args) {
                const argDump = !args.length ? '()' : `\n         -> ${args.join(',\n         -> ')}`;
                console.log(`DECODED CALLDATA:\n    ${fn.name}${argDump}`);
            } else {
                console.log(`💥 FAILED TO DECODE CALLDATA !`);
            }
        } catch (e: any) {
            console.log(`💥 FAILED TO DECODE CALLDATA (${e.message}) !`);
        }
    }
    console.log(`CALLDATA: \n    ${calldata.join('\n    ') || '<empty>'}\n`)
}

function watchInstructions(exec: IExecutor, level: number): boolean {
    if (!level) {
        return false;
    }
    const cname = exec.contractName;
    let inContinue = false;
    exec.watch((_, __, name, spy, seq) => {
        if (cname === 'hyvm') {
            if (seq === 'CONTINUE') { // ignore "continue" known sequence in HyVM
                if (!inContinue) {
                    console.log(' -> CONTINUE()');
                }
                inContinue = true;
                return;
            }
            if (inContinue && name.startsWith('op_jumpdest')) {
                return; // ignore first jumpdest after continue
            }
        }
        inContinue = false;
        const summary = `[${cname}${seq ? '.' + seq : ''}] ${name} ${spy.join(' ')} 👉 [${exec.dumpStack().join(', ')}]`;
        console.log(summary);
    });
    // exec.onMemChange((newMem) => {
    //     const msg = `📝 mem changed (size 0x${newMem.length.toString(16)})`;
    //     console.log(msg);
    // });
    exec.onStartingCall((newExec, type) => {
        if (!watchInstructions(newExec, level - 1)) {
            subscribeShowResult(newExec, false);
            console.log(` -----> Not logged child ${type} 🔜 ${newExec.contractName}`);
        } else {
            console.log(`========== stack activity: ${type} 🔜 ${newExec.contractName} (from ${cname}) ==============`);
        }
        showWelcome(newExec);

    });

    subscribeShowResult(exec, true);
    return true;
}

function subscribeShowResult(exec: IExecutor, fullyLogged: boolean) {
    exec.onEndingCall((exec, type, success, stop) => {
        if (fullyLogged) {
            console.log(`========== stack activity: ${success ? '✅' : '💥'} back to ${exec.contractName} (end of op "${type}" => ${stop?.type ?? 'unknown error'}) ==============`);
        } else {
            console.log(` -> sub call ended  ${success ? '✅' : '💥'}  ${stop?.type ?? 'unknown error'}`);
        }
    });
    exec.onResult(r => {
        const hexData = 'data' in r ? Buffer.from(r.data ?? []).toString('hex') : '';
        console.log(`[${exec.contractName}] => ${r.type} ${hexData}`);

        // try to decode revert errrors
        if (r.type === 'revert' && r.data && r.data.length % 32 === 4 && r.data.length > 4) {
            try {
                // discard selector
                const withoutSel = hexData.substring(8);
                const message = new utils.AbiCoder().decode(['string'], '0x' + withoutSel);
                console.log(`  👉 DECODED REVERT MSG: ${message}\n`)
            } catch (e: any) {
                console.log('  -> 💥 FAILED TO DECODE REVERT DATA !\n')
            }
        }
    })
}



export async function execWatchInstructions(exec: IExecutor, depth?: number): Promise<Uint8Array | null> {
    depth ??= 9999999999999
    if (depth) {
        showWelcome(exec);
    }
    watchInstructions(exec, depth);
    const ret = await exec.execute();
    if (!isSuccess(ret)) {
        throw new Error(`Stopped (${ret.type})`);
    }
    return ret.data ?? null;
}



export function uintBuffer(num: number, len = 32) {
    const b = Array(len).fill(0);
    let i = 32;
    while (num > 0) {
        const val = num % 256
        num -= val;
        num /= 256;
        b[--i] = val;
    }
    return b;
}

export function incrementingArray(count: number, start: number, array: true): number[];
export function incrementingArray(count: number, start?: number, array?: false): Uint8Array;
export function incrementingArray(count: number, start = 0, array?: boolean) {
    const ret = Array(count).fill(0).map((_, i) => start + i);
    return array ? ret : new Uint8Array(ret);
}


export function storeSignature(toMemOffset: number, signature: string) {
    if (signature.length !== 8) {
        throw new Error('Invalid sig: ' + signature);
    }
    if (toMemOffset > 255) {
        throw new Error('Cannot store sig that far');
    }
    return [
        0x63, ...parseBuffer(signature), // push4 signature
        0x60, 0xE0, // push1 0xE0
        0x1B, // shl (will shift signature by 0xE0, to the leftmost part)
        0x60, toMemOffset,
        0x52, // mstore
    ]
}


export function toUintBuffer(txt: string) {
    if (txt.startsWith('0x')) {
        txt = txt.substring(2);
    }
    return toUint(txt).toByteArray()
}


export async function balanceOfUsdc(session: ISession, address: string | HexString | UInt256, watch?: boolean) {
    if (typeof address !== 'string') {
        address = dumpU256(address).padStart(40, '0');
    }
    if (address.startsWith('0x')) {
        address = address.substring(2);
    }
    const exec = await session.prepareStaticCall(USDC, `0x70a08231000000000000000000000000${address}`, 0xffff);
    let result: Uint8Array | null;
    if (watch) {
        result = await execWatchInstructions(exec);
    } else {
        const opResult = await exec.execute();
        if (!isSuccess(opResult)) {
            throw new Error('Expected execution success');
        }
        result = opResult.data ?? null;
    }
    if (result?.length !== 32) {
        throw new Error(`Expected a 32 bytes value, but got ${result?.length ?? 0} bytes`);
    }
    return toUint(result!);
}

export async function balanceOf(session: ISession, address: UInt256): Promise<UInt256> {
    const ret = await session.state.getStorageOf(address).getBalance();
    return ret;
}

export function balanceOfNum(session: ISession, address: UInt256): Promise<number> {
    return balanceOf(session, address).then(n => toNumberSafe(n));
}

function addressToStr(address: string | HexString | UInt256): string {
    if (typeof address !== 'string') {
        address = dumpU256(address).padStart(40, '0');
    }
    if (address.startsWith('0x')) {
        address = address.substring(2);
    }
    return address;
}

export const HAS_USDC_RAW = '36d4311fed8f9a2a831b4bb06303de7fe95a3cc5'
export const HAS_USDC = toUint('0x' + HAS_USDC_RAW);
export async function transferUsdcTo(session: ISession, address: string | HexString | UInt256, qty: UInt256, watch?: boolean) {
    address = addressToStr(address);
    const exec = await session.prepareCall(newTxData(toUint(USDC), {
        // 5f5e100
        calldata: parseBuffer(`0xa9059cbb000000000000000000000000${address}${dumpU256(qty).padStart(64, '0')}`),
        origin: HAS_USDC,
    }));
    if (watch) {
        await execWatchInstructions(exec);
    } else {
        const opResult = await exec.execute();
        if (!isSuccess(opResult)) {
            throw new Error('Expected execution success');
        }
    }
}

export async function transferEthTo(session: ISession, address: string | HexString | UInt256, qty: UInt256) {
    address = toUint(address);
    const storage = session.state.getStorageOf(address);
    setStorageInstance(session.state, address, storage.incrementBalance(qty));
}
