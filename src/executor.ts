import { CompiledCode, ExecState, IExecutor, IMemReader, isFailure, isSuccess, Log, OnEndedCall, OnLog, OnStartingCall, StopReason } from './interfaces';
import { MemReader } from './mem-reader';
import { Memory } from './memory';
import { UInt256, U256 } from './uint256';
import { dumpU256, shaOf, toNumberSafe, toUint } from './utils';
import { Buffer } from 'buffer';
import { utils } from 'ethers';

const ZERO = U256(0);

function asyncOp() {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        target[propertyKey].isAsync = true;
    };
}

export class Executor implements IExecutor {

    stack: UInt256[] = [];
    private mem = new Memory();
    readonly logs: Log[] = [];
    private stop: StopReason | null = null;
    private _onResult: ((ret: StopReason) => void)[] = [];
    private opSpy: string[] | null = null;
    private _onMemChange: ((bytes: () => number[]) => void)[] | null = null;
    private _onStartCall: OnStartingCall[] | null = null;
    private _onEndCall: OnEndedCall[] | null = null;
    private _onLog: OnLog[] | null = null;
    private notifyMemChanged = false;
    private run: () => void;
    private lastReturndata: MemReader = new MemReader([]);
    private knownSequence: string | null = null;


    get contractName(): string {
        return this.code.contractName ?? dumpU256(this.code.contractAddress);
    }


    get contractAbi(): utils.Interface | undefined {
        return this.code.contractAbi;
    }


    get contractAddress(): UInt256 {
        return this.code.contractAddress;
    }

    //  private contract: ContractState, private opts: ExecutionOptions
    constructor(public state: ExecState, private code: CompiledCode) {
        this.run = code(this);
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
            gas: this.state.gasSpent,
        };
        for (const or of this._onResult) {
            or(result);
        }
        return result;
    }

    dumpStack() {
        return this.stack.map(i => dumpU256(i)).reverse();
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

    watch(handler: (opcode: number, opName: string, paddedOpName: string, opSpy: string[], knownSeq: string | null) => any) {
        this.spyOps((fn, opname, padded, opcode) => fn.isAsync
            ? async (...args: any[]) => {
                const spy = this.opSpy = [];
                await fn(...args);
                this.opSpy = null;
                handler(opcode, opname, padded, spy, this.knownSequence);
            } : (...args: any[]) => {
                const spy = this.opSpy = [];
                fn(...args);
                this.opSpy = null;
                handler(opcode, opname, padded, spy, this.knownSequence);
            });
    }

    onMemChange(fn: (bytes: () => number[]) => void) {
        this._onMemChange ??= [];
        this._onMemChange?.push(fn);
        this.mem.onChange = () => this.notifyMemChanged = true;
        const notif = () => {
            if (this.notifyMemChanged) {
                let dumped: number[] | undefined = undefined;
                const cloned = () => dumped ??= this.mem.dump();
                this._onMemChange?.forEach(c => c(cloned));
            }
        }
        this.spyOps(o => o.isAsync
            ? async (...args: any[]) => {
                this.notifyMemChanged = false;
                await o(...args);
                notif()
            } : (...args: any[]) => {
                this.notifyMemChanged = false;
                o(...args);
                notif()
            });
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

    onResult(handler: (ret: StopReason) => void) {
        this._onResult.push(handler);
    }
    pop(): UInt256 {
        const ret = this.stack.pop();
        if (!ret) {
            throw new Error('stack undeflow');
        }
        this.opSpy?.push(dumpU256(ret));
        return ret;
    }

    popAsNum(): number {
        const poped = this.pop();
        return toNumberSafe(poped);
    }

    popAsBool(): boolean {
        const poped = this.pop();
        return !poped.eq(0);
    }

    startKnownSequence(seq: string) {
        this.knownSequence = seq;
    }

    endKnownSequence() {
        this.knownSequence = null;
    }

    getStack(n: number) {
        const at = this.stack.length - n;
        if (at < 0) {
            throw new Error('not enough values on stack');
        }
        return this.stack[at].copy();
    }
    push(elt: UInt256) {
        this.opSpy?.push(`➡ ${dumpU256(elt)}`);
        this.stack.push(elt);
    }
    pushBool(elt: boolean) {
        this.opSpy?.push(`➡ ${elt ? '1' : '0'}`);
        this.stack.push(elt ? U256(1) : U256(0));
    }

    op_stop() {
        this.state.decrementGas(3);
        this.stop = {
            type: 'stop',
            newState: this.state,
            gas: this.state.gasSpent,
        };
    }
    op_add() {
        this.state.decrementGas(3);
        this.push(this.pop().add(this.pop()));
    }
    op_mul() {
        this.state.decrementGas(3);
        this.push(this.pop().mul(this.pop()));
    }
    op_sub() {
        this.state.decrementGas(3);
        this.push(this.pop().sub(this.pop()));
    }
    op_div() {
        this.state.decrementGas(3);
        this.push(this.pop().div(this.pop()));
    }
    op_sdiv() {
        this.state.decrementGas(3);
        throw new Error('not implemented: sdiv');
    }
    op_mod() {
        this.state.decrementGas(3);
        this.push(this.pop().mod(this.pop()));
    }
    op_smod() {
        this.state.decrementGas(3);
        throw new Error('not implemented: smod');
    }
    op_addmod() {
        this.state.decrementGas(3);
        throw new Error('not implemented: addmod');
    }
    op_mulmod() {
        this.state.decrementGas(3);
        this.push(this.pop().mul(this.pop()).mod(this.pop()))
    }
    op_exp() {
        this.state.decrementGas(3);
        const a = this.pop();
        const exp = this.popAsNum();
        this.push(a.pow(exp));
    }
    op_signextend() {
        this.state.decrementGas(3);
        // https://ethereum.stackexchange.com/questions/63062/evm-signextend-opcode-explanation
        const b = this.popAsNum();
        const x = this.pop();
        const leftMost = (b + 1) * 8 - 1;
        const isNeg = x.testBit(leftMost);
        const copy = x.copy();
        if (isNeg) {
            for (let i = leftMost; i < 256; i++) {
                copy.setBit(i, true);
            }
        } else {
            for (let i = leftMost; i < 256; i++) {
                copy.clearBit(i, true);
            }
        }
        this.push(copy);
    }
    op_unused() {
        this.state.decrementGas(3);
        throw new Error('not implemented: unused');
    }
    op_lt() {
        this.state.decrementGas(3);
        this.pushBool(this.pop().lt(this.pop()));
    }
    op_gt() {
        this.state.decrementGas(3);
        this.pushBool(this.pop().gt(this.pop()));
    }
    op_slt() {
        this.state.decrementGas(3);
        this.pushBool(this.pop().slt(this.pop()));
    }
    op_sgt() {
        this.state.decrementGas(3);
        this.pushBool(this.pop().sgt(this.pop()));
    }
    op_eq() {
        this.state.decrementGas(3);
        this.pushBool(this.pop().eq(this.pop()));
    }
    op_iszero() {
        this.state.decrementGas(3);
        this.pushBool(this.pop().eq(ZERO));
    }
    op_and() {
        this.state.decrementGas(3);
        this.push(this.pop().and(this.pop()));
    }
    op_or() {
        this.state.decrementGas(3);
        this.push(this.pop().or(this.pop()));
    }
    op_xor() {
        this.state.decrementGas(3);
        this.push(this.pop().xor(this.pop()));
    }
    op_not() {
        this.state.decrementGas(3);
        this.push(this.pop().not(true));
    }
    op_byte() {
        this.state.decrementGas(3);
        const i = this.popAsNum();
        const x = this.pop().toByteArray();
        this.push(U256(x[i]));
    }
    op_shl() {
        this.state.decrementGas(3);
        const n = this.popAsNum();
        this.push(this.pop().shiftLeft(n));
    }
    op_shr() {
        this.state.decrementGas(3);
        const n = this.popAsNum();
        this.push(this.pop().shiftRight(n));
    }
    op_sar() {
        this.state.decrementGas(3);
        throw new Error('not implemented: sar');
    }
    op_sha3() {
        this.state.decrementGas(3);
        const toHash = this.getData();
        this.push(shaOf(toHash));
    }
    op_address() {
        this.state.decrementGas(3);
        this.push(this.state.address);
    }
    @asyncOp()
    async op_balance() {
        this.state.decrementGas(100);
        const address = this.pop();
        const bal = await this.state.getStorageOf(address).getBalance();
        this.push(bal);
    }
    op_origin() {
        this.state.decrementGas(3);
        this.push(this.state.origin);
    }
    op_caller() {
        this.state.decrementGas(3);
        this.push(this.state.caller);
    }
    op_callvalue() {
        this.state.decrementGas(3);
        this.push(this.state.callvalue);
    }
    op_calldataload() {
        this.state.decrementGas(3);
        const addr = this.popAsNum();
        const data = this.state.calldata.slice(addr, 32);
        this.push(toUint(data));
    }
    op_calldatasize() {
        this.state.decrementGas(3);
        this.push(U256(this.state.calldata.size));
    }
    op_calldatacopy() {
        this.state.decrementGas(3);
        this.copyDataToMem(this.state.calldata);
    }
    op_codesize() {
        this.state.decrementGas(3);
        this.push(U256(this.code.code.size));
    }
    op_codecopy() {
        this.state.decrementGas(3);
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
        this.state.decrementGas(3);
        this.push(this.state.gasPrice);
    }
    @asyncOp()
    async op_extcodesize() {
        const address = this.pop();
        const contract = await this.state.session.getContract(address);
        this.push(U256(contract.code?.size ?? 0));
    }
    op_extcodecopy() {
        this.state.decrementGas(3);
        throw new Error('not implemented: extcodecopy');
    }
    op_returndatasize() {
        this.state.decrementGas(3);
        this.push(U256(this.lastReturndata.size));
    }
    op_returndatacopy() {
        this.state.decrementGas(3);
        const destOffset = this.popAsNum();
        const offset = this.popAsNum();
        const size = this.popAsNum();
        if (!size) {
            return;
        }
        if (offset >= this.lastReturndata.size) {
            throw new Error(`Cannot execute "returndatacopy" of ${size} bytes at an index (${offset}) that is higher than "returndatasize" (${this.lastReturndata.size})`);
        }
        for (let i = 0; i < size; i++) {
            this.mem.set(destOffset + i, this.lastReturndata.getByte(offset + i));
        }
    }
    op_extcodehash() {
        this.state.decrementGas(3);
        throw new Error('not implemented: extcodehash');
    }
    op_blockhash() {
        this.state.decrementGas(3);
        throw new Error('not implemented: blockhash');
    }
    op_coinbase() {
        this.state.decrementGas(3);
        throw new Error('not implemented: coinbase');
    }
    op_timestamp() {
        this.state.decrementGas(3);
        this.push(U256(this.state.timestamp));
    }
    op_number() {
        this.state.decrementGas(3);
        throw new Error('not implemented: number');
    }
    op_difficulty() {
        this.state.decrementGas(3);
        throw new Error('not implemented: difficulty');
    }
    op_gaslimit() {
        this.state.decrementGas(3);
        this.push(this.state.gasLimit);
    }
    op_chainid() {
        this.state.decrementGas(3);
        throw new Error('not implemented: chainid');
    }
    @asyncOp()
    async op_selfbalance() {
        this.push(await this.state.getBalance());
    }
    op_basefee() {
        this.state.decrementGas(3);
        throw new Error('not implemented: basefee');
    }
    op_pop() {
        this.state.decrementGas(3);
        this.pop();
    }
    op_mload() {
        this.state.decrementGas(3);
        this.push(this.mem.get(this.popAsNum()));
    }
    op_mstore() {
        this.state.decrementGas(3);
        this.mem.setUint256(this.popAsNum(), this.pop())
    }
    op_mstore8() {
        this.state.decrementGas(3);
        const byte = this.pop().shiftRight(0xF0);
        this.mem.setUint256(this.popAsNum(), byte);
    }

    @asyncOp()
    async op_sload() {
        this.push(await this.state.getStorage(this.pop()));
    }
    op_sstore() {
        this.state.decrementGas(3);
        this.state = this.state.setStorage(this.pop(), this.pop());
    }
    op_jump() {
        this.state.decrementGas(3);
        // NOP (special implementation)
    }
    op_jumpi() {
        this.state.decrementGas(3);
        // NOP (special implementation)
    }
    op_pc(num: number) {
        this.state.decrementGas(3);
        this.push(U256(num));
    }
    op_msize() {
        this.state.decrementGas(3);
        this.push(U256(this.mem.size))
    }
    op_gas() {
        this.state.decrementGas(3);
        this.push(this.state.gas);
    }
    op_jumpdest() {
        this.state.decrementGas(3);
        // do nothing
    }
    private doOpPush(toPush: number[]) {
        this.push(toUint(new Uint8Array(toPush)));
    }

    op_push1(num: number) {
        this.state.decrementGas(3);
        this.push(U256(num));
    }
    op_push2(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push3(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push4(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push5(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push6(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push7(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push8(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push9(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push10(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push11(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push12(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push13(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push14(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push15(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push16(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push17(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push18(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push19(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push20(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push21(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push22(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push23(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push24(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push25(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push26(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push27(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push28(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push29(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push30(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push31(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_push32(data: number[]) {
        this.state.decrementGas(3);
        this.doOpPush(data);
    }
    op_dup1() {
        this.state.decrementGas(3);
        this.push(this.getStack(1));
    }
    op_dup2() {
        this.state.decrementGas(3);
        this.push(this.getStack(2));
    }
    op_dup3() {
        this.state.decrementGas(3);
        this.push(this.getStack(3));
    }
    op_dup4() {
        this.state.decrementGas(3);
        this.push(this.getStack(4));
    }
    op_dup5() {
        this.state.decrementGas(3);
        this.push(this.getStack(5));
    }
    op_dup6() {
        this.state.decrementGas(3);
        this.push(this.getStack(6));
    }
    op_dup7() {
        this.state.decrementGas(3);
        this.push(this.getStack(7));
    }
    op_dup8() {
        this.state.decrementGas(3);
        this.push(this.getStack(8));
    }
    op_dup9() {
        this.state.decrementGas(3);
        this.push(this.getStack(9));
    }
    op_dup10() {
        this.state.decrementGas(3);
        this.push(this.getStack(10));
    }
    op_dup11() {
        this.state.decrementGas(3);
        this.push(this.getStack(11));
    }
    op_dup12() {
        this.state.decrementGas(3);
        this.push(this.getStack(12));
    }
    op_dup13() {
        this.state.decrementGas(3);
        this.push(this.getStack(13));
    }
    op_dup14() {
        this.state.decrementGas(3);
        this.push(this.getStack(14));
    }
    op_dup15() {
        this.state.decrementGas(3);
        this.push(this.getStack(15));
    }
    op_dup16() {
        this.state.decrementGas(3);
        this.push(this.getStack(16));
    }
    private doSwap(n: number) {
        const target = this.stack.length - n - 1;
        if (target < 0) {
            throw new Error('not enough values on stack');
        }
        const latest = this.stack.pop()!;
        this.stack.push(this.stack[target]);
        this.stack[target] = latest;
    }
    op_swap1() {
        this.state.decrementGas(3);
        this.doSwap(1);
    }
    op_swap2() {
        this.state.decrementGas(3);
        this.doSwap(2);
    }
    op_swap3() {
        this.state.decrementGas(3);
        this.doSwap(3);
    }
    op_swap4() {
        this.state.decrementGas(3);
        this.doSwap(4);
    }
    op_swap5() {
        this.state.decrementGas(3);
        this.doSwap(5);
    }
    op_swap6() {
        this.state.decrementGas(3);
        this.doSwap(6);
    }
    op_swap7() {
        this.state.decrementGas(3);
        this.doSwap(7);
    }
    op_swap8() {
        this.state.decrementGas(3);
        this.doSwap(8);
    }
    op_swap9() {
        this.state.decrementGas(3);
        this.doSwap(9);
    }
    op_swap10() {
        this.state.decrementGas(3);
        this.doSwap(10);
    }
    op_swap11() {
        this.state.decrementGas(3);
        this.doSwap(11);
    }
    op_swap12() {
        this.state.decrementGas(3);
        this.doSwap(12);
    }
    op_swap13() {
        this.state.decrementGas(3);
        this.doSwap(13);
    }
    op_swap14() {
        this.state.decrementGas(3);
        this.doSwap(14);
    }
    op_swap15() {
        this.state.decrementGas(3);
        this.doSwap(15);
    }
    op_swap16() {
        this.state.decrementGas(3);
        this.doSwap(16);
    }

    private getData(): Uint8Array {
        const offset = this.popAsNum();
        const size = this.popAsNum();
        return this.mem.slice(offset, size);
    }
    op_log0() {
        this.state.decrementGas(3);
        const log: Log = { address: this.contractAddress, data: this.getData(), topics: [], }
        this.logs.push(log);
        this._onLog?.forEach(fn => fn(log));
    }
    op_log1() {
        this.state.decrementGas(3);
        const log: Log = { address: this.contractAddress, data: this.getData(), topics: [this.pop()], }
        this.logs.push(log);
        this._onLog?.forEach(fn => fn(log));
    }
    op_log2() {
        this.state.decrementGas(3);
        const log: Log = { address: this.contractAddress, data: this.getData(), topics: [this.pop(), this.pop()], }
        this.logs.push(log);
        this._onLog?.forEach(fn => fn(log));
    }
    op_log3() {
        this.state.decrementGas(3);
        const log: Log = { address: this.contractAddress, data: this.getData(), topics: [this.pop(), this.pop(), this.pop()], }
        this.logs.push(log);
        this._onLog?.forEach(fn => fn(log));
    }
    op_log4() {
        this.state.decrementGas(3);
        const log: Log = { address: this.contractAddress, data: this.getData(), topics: [this.pop(), this.pop(), this.pop(), this.pop()], }
        this.logs.push(log);
        this._onLog?.forEach(fn => fn(log));
    }
    op_create() {
        this.state.decrementGas(3);
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
        const code = await this.state.session.getContract(contract);

        // setup context
        const calldata = this.mem.slice(argsOffset, argsSize);
        const newState = await this.state
            .pushCallTo(contract, value, calldata, retSize, gas);

        // execute
        const executor = new Executor(newState, code);
        this._onStartCall?.forEach(c => c(executor, 'call'));
        const result = await executor.execute();

        // push success flag on stack
        this.setCallResult(result, retOffset, retSize, executor.logs, 'call');
    }

    private setCallResult(result: StopReason, retOffset: number, retSize: number, logs: Log[], type: 'call' | 'delegatecall' | 'callcode' | 'staticcall') {
        const success = isSuccess(result);
        this.pushBool(success);
        this._onEndCall?.forEach(c => c(this, type, success, result));
        this.lastReturndata = new MemReader([]);


        if (isFailure(result)) {
            this.state.decrementGas(result.gas);
            return;
        }

        // on success, update the current state
        this.state = result.newState
            .popCallStack();

        this.logs.push(...logs);

        this.state.decrementGas(result.gas);

        if (!result.data?.length) {
            return;
        }

        // copy returndata to memory (when has return data)
        this.lastReturndata = new MemReader([...result.data]);
        for (let i = 0; i < retSize; i++) {
            this.mem.set(retOffset + i, result.data[i] ?? 0);
        }
    }

    op_callcode() {
        this.state.decrementGas(3);
        throw new Error('not implemented: callcode');
    }
    op_return() {
        this.state.decrementGas(3);
        this.stop = {
            type: 'return',
            data: this.getData(),
            gas: this.state.gasSpent,
            newState: this.state,
        }
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
        const code = await this.state.session.getContract(contract);

        // setup context
        const calldata = this.mem.slice(argsOffset, argsSize);
        const newState = this.state
            .pushDelegatecallTo(contract, calldata, retSize, gas);

        // execute
        const executor = new Executor(newState, code);
        this._onStartCall?.forEach(c => c(executor, 'delegatecall'));
        const result = await executor.execute();

        // push success flag on stack
        this.setCallResult(result, retOffset, retSize, executor.logs, 'delegatecall');

    }

    op_create2() {
        this.state.decrementGas(3);
        throw new Error('not implemented: create2');
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
        const code = await this.state.session.getContract(contract);

        // setup context
        const calldata = this.mem.slice(argsOffset, argsSize);
        const newState = this.state
            .pushStaticcallTo(contract, calldata, retSize, gas);

        // execute
        const executor = new Executor(newState, code);
        this._onStartCall?.forEach(c => c(executor, 'staticcall'));
        const result = await executor.execute();

        // push success flag on stack
        this.setCallResult(result, retOffset, retSize, executor.logs, 'staticcall');
    }
    op_revert() {
        this.state.decrementGas(3);
        this.stop = {
            type: 'revert',
            data: this.getData(),
            gas: this.state.gasSpent,
        }
    }
    op_invalid() {
        this.state.decrementGas(3);
        throw new Error('not implemented: invalid');
    }
    op_selfdestruct() {
        this.state.decrementGas(3);
        throw new Error('not implemented: selfdestruct');
    }
}

const p = Executor.prototype;
export type OpFn = (((...args: any[]) => void | Promise<void>) & { isAsync?: boolean });
export const ops: OpFn[] = [p.op_stop, p.op_add, p.op_mul, p.op_sub, p.op_div, p.op_sdiv, p.op_mod, p.op_smod, p.op_addmod, p.op_mulmod, p.op_exp, p.op_signextend, p.op_unused, p.op_unused, p.op_unused, p.op_unused,
p.op_lt, p.op_gt, p.op_slt, p.op_sgt, p.op_eq, p.op_iszero, p.op_and, p.op_or, p.op_xor, p.op_not, p.op_byte, p.op_shl, p.op_shr, p.op_sar, p.op_unused, p.op_unused,
p.op_sha3, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused,
p.op_address, p.op_balance, p.op_origin, p.op_caller, p.op_callvalue, p.op_calldataload, p.op_calldatasize, p.op_calldatacopy, p.op_codesize, p.op_codecopy, p.op_gasprice, p.op_extcodesize, p.op_extcodecopy, p.op_returndatasize, p.op_returndatacopy, p.op_extcodehash,
p.op_blockhash, p.op_coinbase, p.op_timestamp, p.op_number, p.op_difficulty, p.op_gaslimit, p.op_chainid, p.op_selfbalance, p.op_basefee, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused,
p.op_pop, p.op_mload, p.op_mstore, p.op_mstore8, p.op_sload, p.op_sstore, p.op_jump, p.op_jumpi, p.op_pc, p.op_msize, p.op_gas, p.op_jumpdest, p.op_unused, p.op_unused, p.op_unused, p.op_unused,
p.op_push1, p.op_push2, p.op_push3, p.op_push4, p.op_push5, p.op_push6, p.op_push7, p.op_push8, p.op_push9, p.op_push10, p.op_push11, p.op_push12, p.op_push13, p.op_push14, p.op_push15, p.op_push16,
p.op_push17, p.op_push18, p.op_push19, p.op_push20, p.op_push21, p.op_push22, p.op_push23, p.op_push24, p.op_push25, p.op_push26, p.op_push27, p.op_push28, p.op_push29, p.op_push30, p.op_push31, p.op_push32,
p.op_dup1, p.op_dup2, p.op_dup3, p.op_dup4, p.op_dup5, p.op_dup6, p.op_dup7, p.op_dup8, p.op_dup9, p.op_dup10, p.op_dup11, p.op_dup12, p.op_dup13, p.op_dup14, p.op_dup15, p.op_dup16,
p.op_swap1, p.op_swap2, p.op_swap3, p.op_swap4, p.op_swap5, p.op_swap6, p.op_swap7, p.op_swap8, p.op_swap9, p.op_swap10, p.op_swap11, p.op_swap12, p.op_swap13, p.op_swap14, p.op_swap15, p.op_swap16,
p.op_log0, p.op_log1, p.op_log2, p.op_log3, p.op_log4, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused,
p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused,
p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused,
p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused,
p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_unused,
p.op_create, p.op_call, p.op_callcode, p.op_return, p.op_delegatecall, p.op_create2, p.op_unused, p.op_unused, p.op_unused, p.op_unused, p.op_staticcall, p.op_unused, p.op_unused, p.op_revert, p.op_invalid, p.op_selfdestruct
];
