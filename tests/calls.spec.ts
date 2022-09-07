import 'mocha';
import { assert, expect } from 'chai';
import { Session } from '../src/session';
import { balanceOf, execWatchInstructions, HAS_USDC, newDeployTxData, newTxData, TEST_SESSION_OPTS, transferUsdcTo } from './test-utils';
import { U256, UInt256 } from '../src/uint256';
import { DOUBLE_SWAP, DUMMY } from './bytecodes';
import { dumpU256, generateAddress, parseBuffer, to0xAddress, toNumberSafe, toUint } from '../src/utils';
import { USDC } from './known-contracts';
import { HexString, isSuccess } from '../src/interfaces';

describe('Calls', () => {

    let session: Session;
    beforeEach(() => {
        session = new Session(TEST_SESSION_OPTS);
    });

    it('can call a dummy contract', async () => {
        const dummy = await session.deploy(DUMMY.BYTECODE, newDeployTxData(), {
            name: 'dummy',
        });
        const contract = await session.deployRaw(DUMMY.CALL_SETTER(dummy), {
            name: 'call_dummy',
        })
        const exec = await session.prepareCall(newTxData(contract, { origin: HAS_USDC }));
        await execWatchInstructions(exec);

        // check that call has succeeded
        expect(exec.popAsNum()).to.equal(1, 'expecting call success');

        // check that the target contract has 0x42 in its storage at address 0
        const data = await session.state.getStorageOf(dummy).get(U256(0));
        expect(toNumberSafe(data)).to.equal(0x42);
    })

    it('staticcall balanceOf', async () => {
        const val = await balanceOf(session, '524a464e53208c1f87f6d56119acb667d042491a', true);
        // check that this address has more than 10M USDC (6 decimals)
        assert.isTrue(val.gt(U256(10).pow(6 + 7)));
        // check that this address less 100M USDC (6 decimals)
        assert.isTrue(val.lt(U256(10).pow(6 + 9)));
    })



    it('call transfer', async () => {

        // check that has no USDC
        const initialBalance = await balanceOf(session, 'b4c79dab8f259c7aee6e5b2aa729821864227e84');
        assert.isTrue(initialBalance.eq(0));

        // send 1000 USDC from 0x524a464e53208c1f87f6d56119acb667d042491a to 0xb4c79dab8f259c7aee6e5b2aa729821864227e84
        const exec = await session.prepareCall(newTxData(toUint(USDC), {
            calldata: parseBuffer('a9059cbb000000000000000000000000b4c79dab8f259c7aee6e5b2aa729821864227e84000000000000000000000000000000000000000000000000000000003b9aca00'),
            origin: HAS_USDC,
        }));
        await execWatchInstructions(exec);

        const newBalance = await balanceOf(session, 'b4c79dab8f259c7aee6e5b2aa729821864227e84');
        assert.isTrue(newBalance.gt(0));
    })

    it('DoubleSwap solidity', async () => {
        const doubleSwap = await session.deploy(DOUBLE_SWAP.NATIVE_BYTECODE, newDeployTxData(), {
            name: 'DoubleSwap_native',
        });
        await transferUsdcTo(session, doubleSwap, toUint('0xfffffffff'));

        const exec = await session.prepareCall(newTxData(doubleSwap, {
            calldata: parseBuffer('64c2c785'),
            origin: generateAddress('me'),
        }));
        await execWatchInstructions(exec);
    })


    it('DoubleSwap huff', async () => {
        const doubleSwap = await session.deployRaw(DOUBLE_SWAP.HUFF_BYTECODE, {
            name: 'DoubleSwap_huff',
        });
        await transferUsdcTo(session, doubleSwap, toUint('0xfffffffff'));

        const exec = await session.prepareCall(newTxData(doubleSwap, {
            origin: generateAddress('me'),
        }));
        await execWatchInstructions(exec);
    })
});
