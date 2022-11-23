import 'mocha';
import { assert, expect } from 'chai';
import { Buffer } from 'buffer';
import { Session } from '../src/session';
import { execWatchInstructions, newDeployTxData, newTxData, TEST_SESSION_OPTS, transferUsdcTo } from './test-utils';
import { from0x, generateAddress, parseBuffer, to0xAddress, toNumberSafe, toUint } from '../src/utils';
import { U256, UInt256 } from '../src/uint256';
import { NewTxData } from '../src/interfaces';
import { DOUBLE_SWAP, DUMMY, HyVM, HyVM_CALLER } from './bytecodes';

describe('HyVM executions', () => {
    let hyvmContract: UInt256;
    let session: Session;

    beforeEach(async () => {
        session = new Session(TEST_SESSION_OPTS);
        hyvmContract = await session.deploy(HyVM.BYTECODE, newDeployTxData(), {
            name: 'hyvm',
            knownSequences: HyVM.KNOWN_SEQUENCES
        });
    });


    async function executeHyVM(bytecode: string | Uint8Array, opts?: Partial<NewTxData>, noWatch?: boolean) {
        const exec = await session.prepareCall(newTxData(hyvmContract, {
            ...opts,
            calldata: typeof bytecode === 'string'
                ? parseBuffer(bytecode)
                : bytecode,
        }));
        return await execWatchInstructions(exec, { noWatch });
    }

    it('add', async () => {
        // see 'add' in HyVM tests
        const data = await executeHyVM('600360040160005260ff6000f3');
        const expected = new Uint8Array(0xff);
        expected[31] = 7;
        expect(data).to.deep.equal(expected);
    });

    async function callSetDummy(noWatch?: boolean) {
        const dummy = await session.deploy(DUMMY.BYTECODE, newDeployTxData(), {
            name: 'dummy',
        });
        await executeHyVM(DUMMY.CALL_SETTER(dummy), undefined, noWatch);
        return dummy;
    }



    it('can call dummy write', async () => {
        const dummy = await callSetDummy();

        // check that the target contract has 0x42 in its storage at address 0
        const data = await session.state.getStorageOf(dummy).get(U256(0));
        expect(toNumberSafe(data)).to.equal(0x42);
    })

    it('can call dummy read', async () => {

        const dummy = await callSetDummy(true);

        const result = await executeHyVM(DUMMY.CALL_GETTER(dummy))

        expect([...result ?? []]).to.deep.equal([...U256(0x42).toByteArray()]);
    })


    // it('staticcall balanceOf', async () => {
    //     const exec = await session.prepareStaticCall(USDC, '0x70a08231000000000000000000000000524a464e53208c1f87f6d56119acb667d042491a', 0xffff);
    //     const result = await execWatchInstructions(exec);

    //     // check that call has succeeded
    //     expect(exec.popAsNum()).to.equal(1, 'expecting call success');

    //     expect(result.length).to.equal(32);
    //     const val = toUint(result);
    //     // check that this address has more than 10M USDC (6 decimals)
    //     assert.isTrue(val.gt(U256(10).pow(6 + 7)));
    //     // check that this address less 100M USDC (6 decimals)
    //     assert.isTrue(val.lt(U256(10).pow(6 + 9)));
    // })

    async function executeWithUsdc(code: string) {
        // deploy HyVM caller
        const hyvmCaller = await session.deploy(HyVM_CALLER.BYTECODE, newDeployTxData(), {
            name: 'HyVMCaller',
            forceId: toUint('0x6b8c5b35a842ad24000000000000000000000000'),
        });

        await transferUsdcTo(session, hyvmCaller, toUint('0xfffffffff'));

        const callDataHex = HyVM_CALLER.ABI.encodeFunctionData('callNvm', [to0xAddress(hyvmContract), Buffer.from(code, 'hex')]);
        const calldata = parseBuffer(callDataHex);

        // call HyVM caller
        const exec = await session.prepareCall(newTxData(hyvmCaller, {
            calldata,
            origin: toUint('0x26ea9e2167ca463b000000000000000000000000'),
        }));
        await execWatchInstructions(exec);
    }

    it('DoubleSwap solidity', async () => {
        await executeWithUsdc(DOUBLE_SWAP.HyVM_BYTECODE);
    })

    it('DoubleSwap huff', async () => {
        await executeWithUsdc(DOUBLE_SWAP.HUFF_BYTECODE);
    })
});
