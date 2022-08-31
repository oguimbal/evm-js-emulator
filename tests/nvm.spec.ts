import 'mocha';
import { assert, expect } from 'chai';
import { Buffer } from 'buffer';
import { Session } from '../src/session';
import { execWatchInstructions,  newDeployTxData,  newTxData,  TEST_SESSION_OPTS } from './test-utils';
import { from0x, generateAddress, parseBuffer, toNumberSafe } from '../src/utils';
import { U256, UInt256 } from '../src/uint256';
import { NewTxData } from '../src/interfaces';
import { DOUBLE_SWAP, DUMMY, NVM_BYTECODE } from './bytecodes';

describe('NVM executions', () => {
    let contract: UInt256;
    let session: Session;

    beforeEach(async () => {
        session = new Session(TEST_SESSION_OPTS);
        contract = await session.deploy(NVM_BYTECODE, newDeployTxData(), { name: 'nvm' });
    });


    async function deal(erc20: UInt256, owner: UInt256, amt: UInt256) {
        // TODO... transfer from 0x0000 ?
    }

    async function executeNvm(bytecode: string | Uint8Array, opts?: Partial<NewTxData>) {
        const exec = await session.prepareCall(newTxData(contract, {
            ...opts,
            calldata: typeof bytecode === 'string'
                ? parseBuffer(bytecode)
                : bytecode,
        }));
        return await execWatchInstructions(exec);
    }

    it('add', async () => {
        // see 'add' in NVM tests
        const data = await executeNvm('600360040160005260ff6000f3');
        const expected = new Uint8Array(0xff);
        expected[31] = 7;
        expect(data).to.deep.equal(expected);
    });

    it('can call a dummy contract', async () => {
        const dummy = await session.deploy(DUMMY.BYTECODE, newDeployTxData(), {
            name: 'dummy',
        });
        await executeNvm(DUMMY.CALL_SETTER(dummy))

        // check that the target contract has 0x42 in its storage at address 0
        const data = await session.state.getStorageOf(dummy).get(U256(0));
        expect(toNumberSafe(data)).to.equal(0x42);
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
        // deal some USDC to some owner
        const owner = generateAddress('me');
        const USDC = from0x('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
        const balance = U256(1000).mul(U256(10).pow(6));
        deal(USDC, owner, balance);

        // execute swap
        await executeNvm(DOUBLE_SWAP.NVM_BYTECODE, {
            origin: owner,
        });
        debugger;
        assert.fail('todo');
    })
});
