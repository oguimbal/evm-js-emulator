import {
    CompiledCode,
    DeployOpts,
    ExecState,
    IExecutor,
    IMemReader,
    isFailure,
    isSuccess,
    Log,
    OnEndedCall,
    OnLog,
    OnStartingCall,
    StopReason,
} from './interfaces';
import { MemReader } from './mem-reader';
import { Memory } from './memory';
import { dumpU256, parseBuffer, toNumberSafe, toUint } from './utils';
import { Buffer } from 'buffer';
import { utils } from 'ethers';
import { compileCode } from './compiler';
import {
    BIGINT_0,
    BIGINT_1,
    BIGINT_160,
    BIGINT_2,
    BIGINT_224,
    BIGINT_255,
    BIGINT_256,
    BIGINT_2EXP160,
    BIGINT_2EXP224,
    BIGINT_2EXP96,
    BIGINT_31,
    BIGINT_32,
    BIGINT_7,
    BIGINT_8,
    BIGINT_96,
    exponentiation,
    fromTwos,
    MAX_INTEGER_BIGINT,
    MAX_NUM,
    mod,
    toTwos,
    TWO_POW256,
} from './arithmetic';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { bytesToHex } from './bytes';

// https://github.com/ethereumjs/ethereumjs-monorepo/blob/d89a96382716b028b5bcc04014e701cfa98eeda8/packages/evm/src/opcodes/functions.ts#L172

function asyncOp() {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        target[propertyKey].isAsync = true;
    };
}

const MAX_HEIGHT = 1024;

export class Executor implements IExecutor {
    private _stack: bigint[] = [];
    private _len = 0;
    private mem = new Memory();
    readonly logs: Log[] = [];
    private stop: StopReason | null = null;
    private _onResult: ((ret: StopReason) => void | Promise<void>)[] = [];
    private opSpy: string[] | null = null;
    private _onMemChange: ((bytes: () => number[]) => void)[] | null = null;
    private _onStartCall: OnStartingCall[] | null = null;
    private _onEndCall: OnEndedCall[] | null = null;
    private _onLog: OnLog[] | null = null;
    private notifyMemChanged = false;
    private run: () => void;
    private lastReturndata: MemReader = new MemReader([]);
    private knownSequence: string | null = null;
    gas: bigint;

    get contractName(): string {
        return this.code.contractName ?? dumpU256(this.code.contractAddress);
    }

    get contractAbi(): utils.Interface | undefined {
        return this.code.contractAbi;
    }

    get contractAddress(): bigint {
        return this.code.contractAddress;
    }

    //  private contract: ContractState, private opts: ExecutionOptions
    constructor(public state: ExecState, private gasLimit: bigint, private code: CompiledCode) {
        this.run = code(this);
        this.gas = gasLimit;
    }

    async execute(): Promise<StopReason> {
        this.stop = null;
        // step into this to debug the contract
        // while puting two watches: this.dumpStack() and this.dumpMemory()
        const p = this.run();
        await p;
        const result: StopReason = this.stop ?? {
            type: 'end of code',
            newState: this.state,
            gas: this.gasSpent,
        };
        for (const or of this._onResult) {
            await or(result);
        }
        return result;
    }

    copyStack(): readonly bigint[] {
        return this._stack.slice(0, this._len);
    }

    get gasSpent(): bigint {
        return this.gasLimit - this.gas;
    }

    dumpStack() {
        return this.copyStack()
            .map(i => dumpU256(i))
            .reverse();
    }

    dumpCalldata() {
        const dumped = [];
        let offset = 0;
        const cd = this.state.calldata;
        if (cd.size % 32 === 4) {
            // calldata most probably include a selector => dump it
            dumped.push(Buffer.from(cd.sliceNoPad(0, 4)).toString('hex'));
            offset = 4;
        }
        while (true) {
            const uint = cd.sliceNoPad(offset, 32);
            if (!uint.length) {
                return dumped;
            }
            dumped.push(Buffer.from(uint).toString('hex'));
            offset += 32;
        }
    }
    dumpMemory() {
        const dumped = [];
        let offset = 0;
        while (true) {
            const uint = this.mem.sliceNoPad(offset, 32);
            if (!uint.length) {
                return dumped;
            }
            dumped.push(Buffer.from(uint).toString('hex'));
            offset += 33;
        }
    }

    private spyOps(fn: (fn: OpFn, opname: string, paddedopname: string, opcode: number) => Function) {
        const nameLen = Math.max(...ops.map(o => o.name.length));
        for (let i = 0; i < ops.length; i++) {
            const o = ops[i];
            const paddedopname = o.name.padEnd(nameLen, ' ');
            const old = ((this as any)[o.name] ?? o).bind(this);
            old.isAsync = o.isAsync;
            (this as any)[o.name] = fn(old, o.name, paddedopname, i);
        }
    }

    watch(
        handler: (
            opcode: number,
            opName: string,
            paddedOpName: string,
            opSpy: string[],
            knownSeq: string | null,
        ) => any,
    ) {
        this.spyOps((fn, opname, padded, opcode) =>
            fn.isAsync
                ? async (...args: any[]) => {
                      const spy = (this.opSpy = []);
                      await fn(...args);
                      this.opSpy = null;
                      handler(opcode, opname, padded, spy, this.knownSequence);
                  }
                : (...args: any[]) => {
                      const spy = (this.opSpy = []);
                      fn(...args);
                      this.opSpy = null;
                      handler(opcode, opname, padded, spy, this.knownSequence);
                  },
        );
    }

    onMemChange(fn: (bytes: () => number[]) => void) {
        this._onMemChange ??= [];
        this._onMemChange?.push(fn);
        this.mem.onChange = () => (this.notifyMemChanged = true);
        const notif = () => {
            if (this.notifyMemChanged) {
                let dumped: number[] | undefined = undefined;
                const cloned = () => (dumped ??= this.mem.dump());
                this._onMemChange?.forEach(c => c(cloned));
            }
        };
        this.spyOps(o =>
            o.isAsync
                ? async (...args: any[]) => {
                      this.notifyMemChanged = false;
                      await o(...args);
                      notif();
                  }
                : (...args: any[]) => {
                      this.notifyMemChanged = false;
                      o(...args);
                      notif();
                  },
        );
    }
    onStartingCall(fn: OnStartingCall): void {
        this._onStartCall ??= [];
        this._onStartCall.push(fn);
    }
    onEndingCall(fn: OnEndedCall): void {
        this._onEndCall ??= [];
        this._onEndCall.push(fn);
    }

    onLog(fn: OnLog): void {
        this._onLog ??= [];
        this._onLog.push(fn);
    }

    onResult(handler: (ret: StopReason) => void | Promise<void>) {
        this._onResult.push(handler);
    }
    popN(num: number): bigint[] {
        if (this._len < num) {
            throw new Error('stack undeflow');
        }

        if (num === 0) {
            return [];
        }

        const arr = Array(num);
        const cache = this._stack;

        for (let pop = 0; pop < num; pop++) {
            // Note: this thus also (correctly) reduces the length of the internal array (without deleting items)
            arr[pop] = cache[--this._len];
        }

        if (this.opSpy) {
            for (const r of arr) {
                this.opSpy.push(dumpU256(r));
            }
        }
        return arr;
    }
    pop(): bigint {
        if (this._len < 1) {
            throw new Error('stack undeflow');
        }
        const ret = this._stack[--this._len];
        this.opSpy?.push(dumpU256(ret));
        return ret;
    }

    popAsNum(): number {
        const poped = this.pop();
        return toNumberSafe(poped);
    }

    popAsBool(): boolean {
        const poped = this.pop();
        return !!poped;
    }

    startKnownSequence(seq: string) {
        this.knownSequence = seq;
    }

    endKnownSequence() {
        this.knownSequence = null;
    }

    /**
     * Swap top of stack with an item in the stack.
     * @param position - Index of item from top of the stack (0-indexed)
     */
    swap(position: number) {
        if (this._len <= position) {
            throw new Error('stack undeflow');
        }

        const head = this._len - 1;
        const i = head - position;
        const storageCached = this._stack;

        const tmp = storageCached[head];
        storageCached[head] = storageCached[i];
        storageCached[i] = tmp;
    }

    /**
     * Pushes a copy of an item in the stack.
     * @param position - Index of item to be copied (1-indexed)
     */
    // I would say that we do not need this method any more
    // since you can't copy a primitive data type
    // Nevertheless not sure if we "loose" something here?
    // Will keep commented out for now
    dup(position: number) {
        const len = this._len;
        if (len < position) {
            throw new Error('stack undeflow');
        }

        // Note: this code is borrowed from `push()` (avoids a call)
        if (len >= MAX_HEIGHT) {
            throw new Error('stack overflow');
        }

        const i = len - position;
        this.opSpy?.push(`➡ ${dumpU256(this._stack[i])}`);
        this._stack[this._len++] = this._stack[i];
    }

    push(value: bigint) {
        this.opSpy?.push(`➡ ${dumpU256(value)}`);
        if (this._len >= MAX_HEIGHT) {
            throw new Error('stack overflow');
        }

        // Read current length, set `_store` to value, and then increase the length
        this._stack[this._len++] = value;
    }
    pushBool(elt: boolean) {
        this.push(elt ? 1n : 0n);
    }

    decrementGas(num: number | bigint): void {
        // todo implement this... seems to fail on EOA calls
        // if (this.gas.lt(num)) {
        //     throw new Error('Out of gas');
        // }
        // // decrement in a mutable way
        this.gas -= BigInt(num);
    }

    op_stop() {
        this.decrementGas(3);
        this.stop = {
            type: 'stop',
            newState: this.state,
            gas: this.gasSpent,
        };
    }
    op_add() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        const r = mod(a + b, TWO_POW256);
        this.push(r);
    }
    op_mul() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        const r = mod(a * b, TWO_POW256);
        this.push(r);
    }
    op_sub() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        const r = mod(a - b, TWO_POW256);
        this.push(r);
    }
    op_div() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        let r;
        if (b === BIGINT_0) {
            r = BIGINT_0;
        } else {
            r = mod(a / b, TWO_POW256);
        }
        this.push(r);
    }
    op_sdiv() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        let r;
        if (b === BIGINT_0) {
            r = BIGINT_0;
        } else {
            r = toTwos(fromTwos(a) / fromTwos(b));
        }
        this.push(r);
    }
    op_mod() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        let r;
        if (b === BIGINT_0) {
            r = b;
        } else {
            r = mod(a, b);
        }
        this.push(r);
    }
    op_smod() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        let r;
        if (b === BIGINT_0) {
            r = b;
        } else {
            r = fromTwos(a) % fromTwos(b);
        }
        this.push(toTwos(r));
    }
    op_addmod() {
        this.decrementGas(3);
        const [a, b, c] = this.popN(3);
        let r;
        if (c === BIGINT_0) {
            r = BIGINT_0;
        } else {
            r = mod(a + b, c);
        }
        this.push(r);
    }
    op_mulmod() {
        this.decrementGas(3);
        const [a, b, c] = this.popN(3);
        let r;
        if (c === BIGINT_0) {
            r = BIGINT_0;
        } else {
            r = mod(a * b, c);
        }
        this.push(r);
    }
    op_exp() {
        this.decrementGas(3);
        const [base, exponent] = this.popN(2);
        if (base === BIGINT_2) {
            switch (exponent) {
                case BIGINT_96:
                    this.push(BIGINT_2EXP96);
                    return;
                case BIGINT_160:
                    this.push(BIGINT_2EXP160);
                    return;
                case BIGINT_224:
                    this.push(BIGINT_2EXP224);
                    return;
            }
        }
        if (exponent === BIGINT_0) {
            this.push(BIGINT_1);
            return;
        }

        if (base === BIGINT_0) {
            this.push(base);
            return;
        }
        const r = exponentiation(base, exponent);
        this.push(r);
    }
    op_signextend() {
        this.decrementGas(3);
        // https://ethereum.stackexchange.com/questions/63062/evm-signextend-opcode-explanation
        let [k, val] = this.popN(2);
        if (k < BIGINT_31) {
            const signBit = k * BIGINT_8 + BIGINT_7;
            const mask = (BIGINT_1 << signBit) - BIGINT_1;
            if ((val >> signBit) & BIGINT_1) {
                val = val | BigInt.asUintN(256, ~mask);
            } else {
                val = val & mask;
            }
        }
        this.push(val);
    }
    op_unused() {
        this.decrementGas(3);
        throw new Error('not implemented: unused');
    }
    op_lt() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        const r = a < b ? BIGINT_1 : BIGINT_0;
        this.push(r);
    }
    op_gt() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        const r = a > b ? BIGINT_1 : BIGINT_0;
        this.push(r);
    }
    op_slt() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        const r = fromTwos(a) < fromTwos(b) ? BIGINT_1 : BIGINT_0;
        this.push(r);
    }
    op_sgt() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        const r = fromTwos(a) > fromTwos(b) ? BIGINT_1 : BIGINT_0;
        this.push(r);
    }
    op_eq() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        const r = a === b ? BIGINT_1 : BIGINT_0;
        this.push(r);
    }
    op_iszero() {
        this.decrementGas(3);
        const a = this.pop();
        const r = a === BIGINT_0 ? BIGINT_1 : BIGINT_0;
        this.push(r);
    }
    op_and() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        const r = a & b;
        this.push(r);
    }
    op_or() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        const r = a | b;
        this.push(r);
    }
    op_xor() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        const r = a ^ b;
        this.push(r);
    }
    op_not() {
        this.decrementGas(3);
        const a = this.pop();
        const r = BigInt.asUintN(256, ~a);
        this.push(r);
    }
    op_byte() {
        this.decrementGas(3);
        const [pos, word] = this.popN(2);
        if (pos > BIGINT_32) {
            this.push(BIGINT_0);
            return;
        }

        const r = (word >> ((BIGINT_31 - pos) * BIGINT_8)) & BIGINT_255;
        this.push(r);
    }
    op_shl() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        if (a > BIGINT_256) {
            this.push(BIGINT_0);
            return;
        }

        const r = (b << a) & MAX_INTEGER_BIGINT;
        this.push(r);
    }
    op_shr() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);
        if (a > 256) {
            this.push(BIGINT_0);
            return;
        }

        const r = b >> a;
        this.push(r);
    }
    op_sar() {
        this.decrementGas(3);
        const [a, b] = this.popN(2);

        let r;
        const bComp = BigInt.asIntN(256, b);
        const isSigned = bComp < 0;
        if (a > 256) {
            if (isSigned) {
                r = MAX_INTEGER_BIGINT;
            } else {
                r = BIGINT_0;
            }
            this.push(r);
            return;
        }

        const c = b >> a;
        if (isSigned) {
            const shiftedOutWidth = BIGINT_255 - a;
            const mask = (MAX_INTEGER_BIGINT >> shiftedOutWidth) << shiftedOutWidth;
            r = c | mask;
        } else {
            r = c;
        }
        this.push(r);
    }
    op_sha3() {
        this.decrementGas(3);
        const toHash = this.getData();
        const r = BigInt(bytesToHex(keccak256(toHash)));
        this.push(r);
    }
    op_address() {
        this.decrementGas(3);
        this.push(this.state.address);
    }
    @asyncOp()
    async op_balance() {
        this.decrementGas(100);
        const address = this.pop();
        const bal = await this.state.getStorageOf(address).getBalance();
        this.push(bal);
    }
    op_origin() {
        this.decrementGas(3);
        this.push(this.state.origin);
    }
    op_caller() {
        this.decrementGas(3);
        this.push(this.state.caller);
    }
    op_callvalue() {
        this.decrementGas(3);
        this.push(this.state.callvalue);
    }
    op_calldataload() {
        this.decrementGas(3);
        const addrBig = this.pop();
        if (addrBig > MAX_NUM) {
            this.push(0n);
            return;
        }
        const addr = Number(addrBig);
        const data = this.state.calldata.slice(addr, 32);
        this.push(toUint(data));
    }
    op_calldatasize() {
        this.decrementGas(3);
        this.push(BigInt(this.state.calldata.size));
    }
    op_calldatacopy() {
        this.decrementGas(3);
        this.copyDataToMem(this.state.calldata);
    }
    op_codesize() {
        this.decrementGas(3);
        this.push(BigInt(this.code.code.size));
    }
    op_codecopy() {
        this.decrementGas(3);
        this.copyDataToMem(this.code.code);
    }
    private copyDataToMem(from: IMemReader) {
        const destOffset = this.popAsNum();
        const offset = this.popAsNum();
        const size = this.popAsNum();
        for (let i = 0; i < size; i++) {
            const byte = from.getByte(offset + i) ?? 0;
            this.mem.set(destOffset + i, byte);
        }
    }
    op_gasprice() {
        this.decrementGas(3);
        this.push(this.state.gasPrice);
    }
    @asyncOp()
    async op_extcodesize() {
        const address = this.pop();
        const contract = await this.state.getContract(address);
        this.push(BigInt(contract.code?.size ?? 0));
    }
    op_extcodecopy() {
        this.decrementGas(3);
        throw new Error('not implemented: extcodecopy');
    }
    op_returndatasize() {
        this.decrementGas(3);
        this.push(BigInt(this.lastReturndata.size));
    }
    op_returndatacopy() {
        this.decrementGas(3);
        const destOffset = this.popAsNum();
        const offset = this.popAsNum();
        const size = this.popAsNum();
        if (!size) {
            return;
        }
        if (offset >= this.lastReturndata.size) {
            throw new Error(
                `Cannot execute "returndatacopy" of ${size} bytes at an index (${offset}) that is higher than "returndatasize" (${this.lastReturndata.size})`,
            );
        }
        for (let i = 0; i < size; i++) {
            this.mem.set(destOffset + i, this.lastReturndata.getByte(offset + i));
        }
    }
    @asyncOp()
    async op_extcodehash() {
        this.decrementGas(3);
        const contract = this.pop();
        const compiledCode = await this.state.getContract(contract);

        if (compiledCode.code.size === 0) {
            console.warn(
                'Potential divergence with EVM "extcodehash" instruction: Cannot differenciate a non existing account from an EOA => returning 0 like an EOA',
            );
            this.push(0n);
        } else {
            const code = compiledCode.code.slice(0, compiledCode.code.size);

            // Hash the code
            const hashedCode = keccak256(code);
            const hash = toUint(hashedCode.subarray());

            this.push(hash);
        }
    }
    op_blockhash() {
        this.decrementGas(3);
        throw new Error('not implemented: blockhash');
    }
    op_coinbase() {
        this.decrementGas(3);
        throw new Error('not implemented: coinbase');
    }
    @asyncOp()
    async op_timestamp() {
        this.decrementGas(3);
        if (this.state.forceTimestamp) {
            this.push(BigInt(this.state.forceTimestamp));
            return;
        }
        const delta = this.state.timestampDelta ?? 0;
        const ts = await this.state.session.rpc.getTimestamp();
        this.push(BigInt(ts + delta));
    }
    @asyncOp()
    async op_number() {
        this.decrementGas(3);
        let number = toUint(await this.state.session.rpc.getBlock());
        this.push(toUint(number));
    }
    op_difficulty() {
        this.decrementGas(3);
        this.push(this.state.difficulty);
    }
    op_gaslimit() {
        this.decrementGas(3);
        this.push(this.gasLimit);
    }
    @asyncOp()
    async op_chainid() {
        this.decrementGas(3);
        const chainRaw = await this.state.session.rpc.getChainId();
        let chainId = toUint(chainRaw);
        this.push(toUint(chainId));
    }
    @asyncOp()
    async op_selfbalance() {
        this.push(await this.state.getBalance());
    }
    op_basefee() {
        this.decrementGas(3);
        throw new Error('not implemented: basefee');
    }
    op_pop() {
        this.decrementGas(3);
        this.pop();
    }
    op_mload() {
        this.decrementGas(3);
        this.push(this.mem.get(this.popAsNum()));
    }
    op_mstore() {
        this.decrementGas(3);
        this.mem.setUint256(this.popAsNum(), this.pop());
    }
    op_mstore8() {
        this.decrementGas(3);
        const at = this.popAsNum();
        const byte = this.pop();
        const toSet = toNumberSafe(byte & 255n);
        this.mem.set(at, toSet);
    }

    @asyncOp()
    async op_sload() {
        const data = await this.state.getStorage(this.pop());
        this.push(data);
    }
    op_sstore() {
        this.decrementGas(3);
        this.state = this.state.setStorage(this.pop(), this.pop());
    }
    op_jump() {
        this.decrementGas(3);
        // NOP (special implementation)
    }
    op_jumpi() {
        this.decrementGas(3);
        // NOP (special implementation)
    }
    op_pc(num: number) {
        this.decrementGas(3);
        this.push(BigInt(num));
    }
    op_msize() {
        this.decrementGas(3);
        this.push(BigInt(this.mem.size));
    }
    op_gas() {
        this.decrementGas(2);
        this.push(this.gas);
    }
    op_jumpdest() {
        this.decrementGas(3);
        // do nothing
    }
    private doOpPush(toPush: number[]) {
        this.push(toUint(new Uint8Array(toPush)));
    }

    op_push0(num: number) {
        this.state.session.checkSupports('eip_3855_push0');
        this.decrementGas(2);
        this.push(0n);
    }
    op_push1(num: number) {
        this.decrementGas(3);
        this.push(BigInt(num));
    }
    op_push2(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push3(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push4(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push5(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push6(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push7(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push8(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push9(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push10(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push11(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push12(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push13(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push14(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push15(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push16(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push17(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push18(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push19(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push20(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push21(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push22(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push23(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push24(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push25(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push26(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push27(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push28(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push29(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push30(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push31(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_push32(data: number[]) {
        this.decrementGas(3);
        this.doOpPush(data);
    }
    op_dup1() {
        this.decrementGas(3);
        this.dup(1);
    }
    op_dup2() {
        this.decrementGas(3);
        this.dup(2);
    }
    op_dup3() {
        this.decrementGas(3);
        this.dup(3);
    }
    op_dup4() {
        this.decrementGas(3);
        this.dup(4);
    }
    op_dup5() {
        this.decrementGas(3);
        this.dup(5);
    }
    op_dup6() {
        this.decrementGas(3);
        this.dup(6);
    }
    op_dup7() {
        this.decrementGas(3);
        this.dup(7);
    }
    op_dup8() {
        this.decrementGas(3);
        this.dup(8);
    }
    op_dup9() {
        this.decrementGas(3);
        this.dup(9);
    }
    op_dup10() {
        this.decrementGas(3);
        this.dup(10);
    }
    op_dup11() {
        this.decrementGas(3);
        this.dup(11);
    }
    op_dup12() {
        this.decrementGas(3);
        this.dup(12);
    }
    op_dup13() {
        this.decrementGas(3);
        this.dup(13);
    }
    op_dup14() {
        this.decrementGas(3);
        this.dup(14);
    }
    op_dup15() {
        this.decrementGas(3);
        this.dup(15);
    }
    op_dup16() {
        this.decrementGas(3);
        this.dup(16);
    }

    op_swap1() {
        this.decrementGas(3);
        this.swap(1);
    }
    op_swap2() {
        this.decrementGas(3);
        this.swap(2);
    }
    op_swap3() {
        this.decrementGas(3);
        this.swap(3);
    }
    op_swap4() {
        this.decrementGas(3);
        this.swap(4);
    }
    op_swap5() {
        this.decrementGas(3);
        this.swap(5);
    }
    op_swap6() {
        this.decrementGas(3);
        this.swap(6);
    }
    op_swap7() {
        this.decrementGas(3);
        this.swap(7);
    }
    op_swap8() {
        this.decrementGas(3);
        this.swap(8);
    }
    op_swap9() {
        this.decrementGas(3);
        this.swap(9);
    }
    op_swap10() {
        this.decrementGas(3);
        this.swap(10);
    }
    op_swap11() {
        this.decrementGas(3);
        this.swap(11);
    }
    op_swap12() {
        this.decrementGas(3);
        this.swap(12);
    }
    op_swap13() {
        this.decrementGas(3);
        this.swap(13);
    }
    op_swap14() {
        this.decrementGas(3);
        this.swap(14);
    }
    op_swap15() {
        this.decrementGas(3);
        this.swap(15);
    }
    op_swap16() {
        this.decrementGas(3);
        this.swap(16);
    }

    private getData(): Uint8Array {
        const offset = this.popAsNum();
        const size = this.popAsNum();
        return this.mem.slice(offset, size);
    }
    op_log0() {
        this.decrementGas(3);
        const log: Log = { address: this.state.address, data: this.getData(), topics: [] };
        this.logs.push(log);
        this._onLog?.forEach(fn => fn(log));
    }
    op_log1() {
        this.decrementGas(3);
        const log: Log = { address: this.state.address, data: this.getData(), topics: [this.pop()] };
        this.logs.push(log);
        this._onLog?.forEach(fn => fn(log));
    }
    op_log2() {
        this.decrementGas(3);
        const log: Log = { address: this.state.address, data: this.getData(), topics: [this.pop(), this.pop()] };
        this.logs.push(log);
        this._onLog?.forEach(fn => fn(log));
    }
    op_log3() {
        this.decrementGas(3);
        const log: Log = {
            address: this.state.address,
            data: this.getData(),
            topics: [this.pop(), this.pop(), this.pop()],
        };
        this.logs.push(log);
        this._onLog?.forEach(fn => fn(log));
    }
    op_log4() {
        this.decrementGas(3);
        const log: Log = {
            address: this.state.address,
            data: this.getData(),
            topics: [this.pop(), this.pop(), this.pop(), this.pop()],
        };
        this.logs.push(log);
        this._onLog?.forEach(fn => fn(log));
    }

    op_create() {
        this.decrementGas(3);
        throw new Error('not implemented: create');
    }

    @asyncOp()
    async op_call() {
        // pick arguments
        const gas = this.pop();
        const contract = this.pop();
        const value = this.pop();
        const argsOffset = this.popAsNum();
        const argsSize = this.popAsNum();
        const retOffset = this.popAsNum();
        const retSize = this.popAsNum();

        // get/download/compile contract
        const code = await this.state.getContract(contract);

        // setup context
        const calldata = this.mem.slice(argsOffset, argsSize);
        const newState = await this.state.pushCallTo(contract, value, calldata, retSize);

        // execute
        const executor = new Executor(newState, gas, code);
        this._onStartCall?.forEach(c => c(executor, 'call'));
        const result = await executor.execute();

        // push success flag on stack
        this.setCallResult(result, retOffset, retSize, executor.logs, 'call');
    }

    private setCallResult(
        result: StopReason,
        retOffset: number,
        retSize: number,
        logs: Log[],
        type: 'call' | 'delegatecall' | 'callcode' | 'staticcall' | 'create2',
    ) {
        const success = isSuccess(result);
        if (type !== 'create2') {
            this.pushBool(success);
        }
        this._onEndCall?.forEach(c => c(this, type, success, result));
        if (type !== 'create2') {
            this.lastReturndata = new MemReader([]);
        }

        if (isFailure(result)) {
            this.decrementGas(result.gas);
            return;
        }

        // on success, update the current state
        this.state = result.newState.popCallStack();

        this.logs.push(...logs);

        this.decrementGas(result.gas);

        if (!result.data?.length) {
            return;
        }

        // copy returndata to memory (when has return data)
        if (type !== 'create2') {
            this.lastReturndata = new MemReader([...result.data]);
        }
        for (let i = 0; i < retSize; i++) {
            this.mem.set(retOffset + i, result.data[i] ?? 0);
        }
    }

    op_callcode() {
        this.decrementGas(3);
        throw new Error('not implemented: callcode');
    }
    op_return() {
        this.decrementGas(3);
        const data = this.getData();
        this.stop = {
            type: 'return',
            data,
            gas: this.gasSpent,
            newState: this.state,
        };
    }

    @asyncOp()
    async op_delegatecall() {
        const gas = this.pop();
        const contract = this.pop();
        const argsOffset = this.popAsNum();
        const argsSize = this.popAsNum();
        const retOffset = this.popAsNum();
        const retSize = this.popAsNum();

        // get/download/compile contract
        const code = await this.state.getContract(contract);

        // setup context
        const calldata = this.mem.slice(argsOffset, argsSize);
        const newState = this.state.pushDelegatecallTo(contract, calldata, retSize);

        // execute
        const executor = new Executor(newState, gas, code);
        this._onStartCall?.forEach(c => c(executor, 'delegatecall'));
        const result = await executor.execute();

        // push success flag on stack
        this.setCallResult(result, retOffset, retSize, executor.logs, 'delegatecall');
    }

    @asyncOp()
    async op_create2() {
        this.decrementGas(3);
        const value = this.pop();
        const offset = this.popAsNum();
        const size = this.popAsNum();
        const salt = this.pop();

        // Extract code from the memory
        const code = this.mem.slice(offset, size);

        // Compute the new account address
        const accountAddress = await this.doCreate2(salt, code, value);

        // todo decrement gas based on the size of the deployed contract
        this.push(accountAddress);
    }

    async doCreate2(salt: bigint, code: Uint8Array, value: bigint) {
        const accountAddress = this.computeCreate2Address(salt, code);

        const newState = await this.state.pushCallTo(accountAddress, value, code, 0x20);

        // compile the deployer code
        const compiledDeployer = await compileCode(code, undefined, accountAddress, undefined, undefined);
        const executor = new Executor(newState, this.gas, compiledDeployer);

        // execute deployer
        this._onStartCall?.forEach(c => c(executor, 'create2'));
        const result = await executor.execute();
        this.setCallResult(result, 0, 0, executor.logs, 'create2');

        if (!result.data) {
            throw new Error('no data returned from deployer');
        }

        // compile the contract code (returned by the deployer)
        const compiledContract = await compileCode(result.data, undefined, accountAddress, undefined, undefined);
        this.state = this.state.setContract(compiledContract);

        this.decrementGas(result.gas);

        return accountAddress;
    }

    private computeCreate2Address(salt: bigint, code: Uint8Array): bigint {
        // Bases HEX strings
        const stringSender = this.state.address.toString(16).padStart(40, '0');
        const stringSalt = salt.toString(16).padStart(64, '0');
        const stringCode = Buffer.from(code).toString('hex');

        // Hash the creation code
        const bytesCode = parseBuffer(stringCode);
        const hashedCode = keccak256(bytesCode);

        // Final bytes to hash
        const hexStringToHash = 'ff' + stringSender + stringSalt + Buffer.from(hashedCode).toString('hex');
        const bytesToHash = parseBuffer(hexStringToHash);

        // Final hash
        const hash = keccak256(bytesToHash);

        // Final address
        const address = '0x' + Buffer.from(hash).toString('hex').slice(-40);

        return toUint(address);
    }

    @asyncOp()
    async op_staticcall() {
        const gas = this.pop();
        const contract = this.pop();
        const argsOffset = this.popAsNum();
        const argsSize = this.popAsNum();
        const retOffset = this.popAsNum();
        const retSize = this.popAsNum();

        // get/download/compile contract
        const code = await this.state.getContract(contract);

        // setup context
        const calldata = this.mem.slice(argsOffset, argsSize);
        const newState = this.state.pushStaticcallTo(contract, calldata, retSize);

        // execute
        const executor = new Executor(newState, gas, code);
        this._onStartCall?.forEach(c => c(executor, 'staticcall'));
        const result = await executor.execute();

        // push success flag on stack
        this.setCallResult(result, retOffset, retSize, executor.logs, 'staticcall');
    }
    op_revert() {
        this.decrementGas(3);
        this.stop = {
            type: 'revert',
            data: this.getData(),
            gas: this.gasSpent,
        };
    }
    op_invalid() {
        this.decrementGas(3);
        throw new Error('not implemented: invalid');
    }
    op_selfdestruct() {
        this.decrementGas(3);
        throw new Error('not implemented: selfdestruct');
    }
}

const p = Executor.prototype;
export type OpFn = ((...args: any[]) => void | Promise<void>) & { isAsync?: boolean };
export const ops: OpFn[] = [
    p.op_stop,
    p.op_add,
    p.op_mul,
    p.op_sub,
    p.op_div,
    p.op_sdiv,
    p.op_mod,
    p.op_smod,
    p.op_addmod,
    p.op_mulmod,
    p.op_exp,
    p.op_signextend,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_lt,
    p.op_gt,
    p.op_slt,
    p.op_sgt,
    p.op_eq,
    p.op_iszero,
    p.op_and,
    p.op_or,
    p.op_xor,
    p.op_not,
    p.op_byte,
    p.op_shl,
    p.op_shr,
    p.op_sar,
    p.op_unused,
    p.op_unused,
    p.op_sha3,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_address,
    p.op_balance,
    p.op_origin,
    p.op_caller,
    p.op_callvalue,
    p.op_calldataload,
    p.op_calldatasize,
    p.op_calldatacopy,
    p.op_codesize,
    p.op_codecopy,
    p.op_gasprice,
    p.op_extcodesize,
    p.op_extcodecopy,
    p.op_returndatasize,
    p.op_returndatacopy,
    p.op_extcodehash,
    p.op_blockhash,
    p.op_coinbase,
    p.op_timestamp,
    p.op_number,
    p.op_difficulty,
    p.op_gaslimit,
    p.op_chainid,
    p.op_selfbalance,
    p.op_basefee,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_pop,
    p.op_mload,
    p.op_mstore,
    p.op_mstore8,
    p.op_sload,
    p.op_sstore,
    p.op_jump,
    p.op_jumpi,
    p.op_pc,
    p.op_msize,
    p.op_gas,
    p.op_jumpdest,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_push0,
    p.op_push1,
    p.op_push2,
    p.op_push3,
    p.op_push4,
    p.op_push5,
    p.op_push6,
    p.op_push7,
    p.op_push8,
    p.op_push9,
    p.op_push10,
    p.op_push11,
    p.op_push12,
    p.op_push13,
    p.op_push14,
    p.op_push15,
    p.op_push16,
    p.op_push17,
    p.op_push18,
    p.op_push19,
    p.op_push20,
    p.op_push21,
    p.op_push22,
    p.op_push23,
    p.op_push24,
    p.op_push25,
    p.op_push26,
    p.op_push27,
    p.op_push28,
    p.op_push29,
    p.op_push30,
    p.op_push31,
    p.op_push32,
    p.op_dup1,
    p.op_dup2,
    p.op_dup3,
    p.op_dup4,
    p.op_dup5,
    p.op_dup6,
    p.op_dup7,
    p.op_dup8,
    p.op_dup9,
    p.op_dup10,
    p.op_dup11,
    p.op_dup12,
    p.op_dup13,
    p.op_dup14,
    p.op_dup15,
    p.op_dup16,
    p.op_swap1,
    p.op_swap2,
    p.op_swap3,
    p.op_swap4,
    p.op_swap5,
    p.op_swap6,
    p.op_swap7,
    p.op_swap8,
    p.op_swap9,
    p.op_swap10,
    p.op_swap11,
    p.op_swap12,
    p.op_swap13,
    p.op_swap14,
    p.op_swap15,
    p.op_swap16,
    p.op_log0,
    p.op_log1,
    p.op_log2,
    p.op_log3,
    p.op_log4,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_create,
    p.op_call,
    p.op_callcode,
    p.op_return,
    p.op_delegatecall,
    p.op_create2,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_unused,
    p.op_staticcall,
    p.op_unused,
    p.op_unused,
    p.op_revert,
    p.op_invalid,
    p.op_selfdestruct,
];
