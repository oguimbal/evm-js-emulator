import 'mocha';
import { assert, expect } from 'chai';
import { Session } from '../src/session';
import { execWatchInstructions, newDeployTxData, newTxData } from './test-utils';
import { U256 } from '../src/uint256';
import { DOUBLE_SWAP, DUMMY } from './bytecodes';
import { parseBuffer, toNumberSafe, toUint } from '../src/utils';
import { USDC } from './known-contracts';
import { isSuccess } from '../src/interfaces';

describe('Calls', () => {
    const hasUsdc = toUint('0x524a464e53208c1f87f6d56119acb667d042491a');

    let session: Session;
    beforeEach(() => {
        session = new Session();
    });

    it('can call a dummy contract', async () => {
        const dummy = await session.deploy(DUMMY.BYTECODE, newDeployTxData(), {
            name: 'dummy',
        });
        const contract = await session.deployRaw(DUMMY.CALL_SETTER(dummy), {
            name: 'call_dummy',
        })
        const exec = await session.prepareCall(newTxData(contract, { origin: hasUsdc }));
        await execWatchInstructions(exec);

        // check that call has succeeded
        expect(exec.popAsNum()).to.equal(1, 'expecting call success');

        // check that the target contract has 0x42 in its storage at address 0
        const data = await session.state.getStorageOf(dummy).get(U256(0));
        expect(toNumberSafe(data)).to.equal(0x42);
    })

    async function balanceOf(address: string, watch?: boolean) {
        if (address.startsWith('0x')) {
            address = address.substring(2);
        }
        const exec = await session.prepareStaticCall(USDC, `0x70a08231000000000000000000000000${address}`, 0xffff);
        let result: Uint8Array | null;
        if (watch) {
            result = await execWatchInstructions(exec);
        } else {
            const opResult = await exec.execute();
            assert.isTrue(isSuccess(opResult));
            result = opResult.data ?? null;
        }
        expect(result?.length).to.equal(32);
        return toUint(result!);
    }

    it('staticcall balanceOf', async () => {
        const val = await balanceOf('524a464e53208c1f87f6d56119acb667d042491a', true);
        // check that this address has more than 10M USDC (6 decimals)
        assert.isTrue(val.gt(U256(10).pow(6 + 7)));
        // check that this address less 100M USDC (6 decimals)
        assert.isTrue(val.lt(U256(10).pow(6 + 9)));
    })



    it('call transfer', async () => {

        // check that has no USDC
        const initialBalance = await balanceOf('b4c79dab8f259c7aee6e5b2aa729821864227e84');
        assert.isTrue(initialBalance.eq(0));

        // send 1000 USDC from 0x524a464e53208c1f87f6d56119acb667d042491a to 0xb4c79dab8f259c7aee6e5b2aa729821864227e84
        const exec = await session.prepareCall(newTxData(toUint(USDC), {
            calldata: parseBuffer('a9059cbb000000000000000000000000b4c79dab8f259c7aee6e5b2aa729821864227e84000000000000000000000000000000000000000000000000000000003b9aca00'),
            origin: hasUsdc,
        }));
        await execWatchInstructions(exec);

        const newBalance = await balanceOf('b4c79dab8f259c7aee6e5b2aa729821864227e84');
        assert.isTrue(newBalance.gt(0));
    })

    it('DoubleSwap', async () => {
        const doubleSwap = await session.deploy(DOUBLE_SWAP.NATIVE_BYTECODE, newDeployTxData(), { name: 'DoubleSwap_native' });
        const exec = await session.prepareCall(newTxData(doubleSwap, {
            calldata: parseBuffer('64c2c785'),
            origin: hasUsdc,
        }));
        await execWatchInstructions(exec);
    })
});