import 'mocha';
import { assert, expect } from 'chai';
import { Session } from '../src/session';
import { balanceOf, balanceOfNum, balanceOfUsdc, execWatchInstructions, HAS_USDC, HAS_USDC_RAW, newDeployTxData, newTxData, TEST_SESSION_OPTS, transferEthTo, transferUsdcTo } from './test-utils';
import { U256 } from '../src/uint256';
import { DOUBLE_SWAP, DUMMY, REENTRANT } from './bytecodes';
import { generateAddress, parseBuffer, toNumberSafe, toUint } from '../src/utils';
import { USDC } from './known-contracts';

describe('Calls', () => {

    let session: Session;
    beforeEach(() => {
        session = new Session(TEST_SESSION_OPTS);
    });

    it('check create2 with a Polygon Nested WalletFactory', async () => {
        const contract = U256("0xdd64da5ce84bc6f2c130ed2712be9452b5c45839")

        const exec = await session.prepareCall(newTxData(contract, { 
            calldata: parseBuffer("0xcebc2af4045393280000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000044bf94338e0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000") ,
            caller: U256("0x8b09ab0612d4e1d44cf0c1641b5d0be43a3aec9f")
        }));
        const buffer = await execWatchInstructions(exec);
        const result = [...buffer ?? []]
        const computedAddress = Buffer.from(result).toString('hex').slice(24, 64)

        // check that call has succeeded
        expect(computedAddress).equals("c3c64414186a912ce0eff30a392cf61bd216b00d")
    })

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
        const val = await balanceOfUsdc(session, HAS_USDC_RAW, true);
        // check that this address has more than 10M USDC (6 decimals)
        assert.isTrue(val.gt(U256(10).pow(6 + 7)));
        // check that this address less 100M USDC (6 decimals)
        assert.isTrue(val.lt(U256(10).pow(6 + 9)));
    })


    it('call transfer', async () => {

        // check that has no USDC
        const initialBalance = await balanceOfUsdc(session, 'b4c79dab8f259c7aee6e5b2aa729821864227e84');
        assert.isTrue(initialBalance.eq(0));

        // send 1000 USDC from usdc whale to 0xb4c79dab8f259c7aee6e5b2aa729821864227e84
        const exec = await session.prepareCall(newTxData(toUint(USDC), {
            calldata: parseBuffer('a9059cbb000000000000000000000000b4c79dab8f259c7aee6e5b2aa729821864227e84000000000000000000000000000000000000000000000000000000003b9aca00'),
            origin: HAS_USDC,
        }));
        await execWatchInstructions(exec);

        const newBalance = await balanceOfUsdc(session, 'b4c79dab8f259c7aee6e5b2aa729821864227e84');
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
    });

    it ('Reentrant', async () => {
        const reentrant = await session.deployRaw(REENTRANT.BYTECODE, {
            name: 'Reentrant',
        });

        await transferEthTo(session, reentrant, toUint(12345));
        expect(await balanceOfNum(session, reentrant)).to.equal(12345);

        // deposit to weth (wont be reentrant)
        let exec = await session.prepareCall(newTxData(reentrant, {
            origin: generateAddress('me'),
            calldata: parseBuffer(REENTRANT['deposit()']),
        }));
        await execWatchInstructions(exec);

        // check has no ETH left
        expect(await balanceOfNum(session, reentrant)).to.equal(0);

        // withdraw weth => the WETH contract will call back the contract (reentrant call)
        exec = await session.prepareCall(newTxData(reentrant, {
            origin: generateAddress('me'),
            calldata: parseBuffer(REENTRANT['withdraw()']),
        }));
        await execWatchInstructions(exec);

        // check that has received ETH back, and that the state change that was triggered by reentrancy was handled properly
        expect(await balanceOfNum(session, reentrant)).to.equal(12345);
    });
});
