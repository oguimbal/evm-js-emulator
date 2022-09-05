import 'mocha';
import { assert, expect } from 'chai';
import { Buffer } from 'buffer';
import { Session } from '../src/session';
import { execWatchInstructions, newDeployTxData, newTxData, TEST_SESSION_OPTS, transferUsdcTo } from './test-utils';
import { from0x, generateAddress, parseBuffer, to0xAddress, toNumberSafe, toUint } from '../src/utils';
import { U256, UInt256 } from '../src/uint256';
import { NewTxData } from '../src/interfaces';
import { DOUBLE_SWAP, DUMMY, NVM, NVM_CALLER } from './bytecodes';

describe('NVM executions', () => {
    let nvmContract: UInt256;
    let session: Session;

    beforeEach(async () => {
        session = new Session(TEST_SESSION_OPTS);
        nvmContract = await session.deploy(NVM.BYTECODE, newDeployTxData(), {
            name: 'nvm',
            knownSequences: NVM.KNOWN_SEQUENCES
        });
    });


    async function deal(erc20: UInt256, owner: UInt256, amt: UInt256) {
        // TODO... transfer from 0x0000 ?
    }

    async function executeNvm(bytecode: string | Uint8Array, opts?: Partial<NewTxData>, noWatch?: boolean) {
        const exec = await session.prepareCall(newTxData(nvmContract, {
            ...opts,
            calldata: typeof bytecode === 'string'
                ? parseBuffer(bytecode)
                : bytecode,
        }));
        return await execWatchInstructions(exec, noWatch);
    }

    it('add', async () => {
        // see 'add' in NVM tests
        const data = await executeNvm('600360040160005260ff6000f3');
        const expected = new Uint8Array(0xff);
        expected[31] = 7;
        expect(data).to.deep.equal(expected);
    });

    async function callSetDummy(noWatch?: boolean) {
        const dummy = await session.deploy(DUMMY.BYTECODE, newDeployTxData(), {
            name: 'dummy',
        });
        await executeNvm(DUMMY.CALL_SETTER(dummy), undefined, noWatch);
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

        const result = await executeNvm(DUMMY.CALL_GETTER(dummy))

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

    it('DoubleSwap', async () => {
        // deploy NVM caller
        const nvmCaller = await session.deploy(NVM_CALLER.BYTECODE, newDeployTxData(), {
            name: 'NvmCaller',
            forceId: toUint('0x6b8c5b35a842ad24000000000000000000000000'),
        });

        await transferUsdcTo(session, nvmCaller, toUint('0xfffffffff'));

        const callDataHex = NVM_CALLER.ABI.encodeFunctionData('callNvm', [to0xAddress(nvmContract), Buffer.from(DOUBLE_SWAP.NVM_BYTECODE, 'hex')]);
        const calldata = parseBuffer(callDataHex);

        // call NVM caller
        const exec = await session.prepareCall(newTxData(nvmCaller, {
            calldata,
            origin: toUint('0x26ea9e2167ca463b000000000000000000000000'),
        }));
        await execWatchInstructions(exec);


        // // deal some USDC to some owner
        // const owner = generateAddress('me');
        // const USDC = from0x('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
        // const balance = U256(1000).mul(U256(10).pow(6));
        // deal(USDC, owner, balance);

        // // execute swap
        // await executeNvm(DOUBLE_SWAP.NVM_BYTECODE, {
        //     origin: owner,
        // });
        // debugger;
        // assert.fail('todo');
    })
});
