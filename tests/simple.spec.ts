import 'mocha';
import { expect } from 'chai';
import { executeBytecode, execWatchInstructions, incrementingArray, newTxData, TEST_SESSION_OPTS, toUintBuffer } from './test-utils';
import { dumpU256, generateAddress, to0xAddress, toUint } from '../src/utils';
import { Session } from '../src/session';
import { U256 } from '../src';

describe('Simple opcodes', () => {



    it('add', async () => {
        const { exec } = await executeBytecode([
            0x60, 0x1, // push1 1
            0x60, 0x2, // push1 2
            0x1, // add
        ]);

        expect(exec.popAsNum()).to.equal(3);
    });
    it('overflowing add', async () => {
        const { exec } = await executeBytecode([
            0x7f, ...toUint('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff').toByteArray(), // push32
            0x60, 0x2, // push1 2
            0x1, // add
        ]);

        expect(exec.popAsNum()).to.equal(1);
    });
    it('mul', async () => {
        const { exec } = await executeBytecode([
            0x60, 0x2, // push1 2
            0x60, 0x3, // push1 3
            0x2, // mul
        ]);

        expect(exec.popAsNum()).to.equal(6);
    });
    it('overflowing mul', async () => {
        const { exec } = await executeBytecode([
            // this is "0xffff.../2 + 3", which, multiplied by 2, will be 4
            0x7f, ...toUint('0x8000000000000000000000000000000000000000000000000000000000000002').toByteArray(), // push32
            0x60, 0x2, // push1 3
            0x2, // mul
        ]);

        expect(exec.popAsNum()).to.equal(4);
    });
    it('sub', async () => {
        const { exec } = await executeBytecode([
            0x60, 0x1, // push1 2
            0x60, 0x3, // push1 3
            0x3, // sub
        ]);

        expect(exec.popAsNum()).to.equal(2);
    });
    it('overflowing sub', async () => {
        const { exec } = await executeBytecode([
            0x60, 0x4, // push1 4
            0x60, 0x3, // push1 3
            0x3, // sub
        ]);

        expect(exec.pop()).to.deep.equal(toUint('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
    });
    it('div 1', async () => {
        const { exec } = await executeBytecode([
            0x60, 0x5, // push1 5
            0x60, 0xa, // push1 10
            0x4, // div
        ]);

        expect(exec.popAsNum()).to.equal(2);
    });
    it('div 2', async () => {
        const { exec } = await executeBytecode([
            0x60, 0x5, // push1 5
            0x60, 0xc, // push1 12
            0x4, // div
        ]);

        expect(exec.popAsNum()).to.equal(2);
    });


    describe('signextend', () => {


        it('0xFF - 0', async () => {
            const { exec } = await executeBytecode([
                0x60, 0xFF, // push1 0xFF
                0x60, 0, // push1 0
                0x0b, // signextend
            ]);

            expect(dumpU256(exec.pop())).to.equal('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
        });

        it('0xFA - 0', async () => {
            const { exec } = await executeBytecode([
                0x60, 0xFA, // push1 0xFA
                0x60, 0, // push1 0
                0x0b, // signextend
            ]);

            expect(dumpU256(exec.pop())).to.equal('fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa');
        });

        it('0x81 - 0', async () => {
            const { exec } = await executeBytecode([
                0x60, 0x81, // push1 0x81
                0x60, 0, // push1 0
                0x0b, // signextend
            ]);

            expect(dumpU256(exec.pop())).to.equal('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff81');
        });

        it('0x7F - 0', async () => {
            const { exec } = await executeBytecode([
                0x60, 0x7F, // push1 0x7F
                0x60, 0, // push1 0
                0x0b, // signextend
            ]);

            expect(dumpU256(exec.pop())).to.equal('7f');
        });

        it('0xaa7F - 0', async () => {
            const { exec } = await executeBytecode([
                0x61, 0xaa, 0x7F, // push2 0xaa7F
                0x60, 0, // push1 0
                0x0b, // signextend
            ]);

            expect(dumpU256(exec.pop())).to.equal('7f');
        });

        it('0xFFFF - 1', async () => {
            const { exec } = await executeBytecode([
                0x61, 0xFF, 0xFF, // push2 0xFFFF
                0x60, 1, // push1 1
                0x0b, // signextend
            ]);

            expect(dumpU256(exec.pop())).to.equal('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
        });

        it('0x7FAA - 1', async () => {
            const { exec } = await executeBytecode([
                0x61, 0x7F, 0xAA, // push2 0x7FAA
                0x60, 1, // push1 1
                0x0b, // signextend
            ]);

            expect(dumpU256(exec.pop())).to.equal('7faa');
        });
    })


    it('calldataload inside', async () => {
        const { exec } = await executeBytecode([
            0x60, 0x2, // push1 2
            0x35, // calldataload
        ], {
            calldata: incrementingArray(100),
        });

        const poped = exec.pop();
        expect([...poped.toByteArray()]).to.deep.equal(incrementingArray(32, 2, true));
    });

    it('calldataload outside', async () => {
        const { exec } = await executeBytecode([
            0x60, 0x20, // push1 0x20
            0x35, // calldataload
        ], {
            calldata: incrementingArray(10),
        });

        expect([...exec.pop().toByteArray()]).to.deep.equal(Array(32).fill(0));
    });

    it('calldataload overlaping', async () => {
        const { exec } = await executeBytecode([
            0x60, 0x9, // push1 0x20
            0x35, // calldataload
        ], {
            calldata: incrementingArray(10),
        });

        expect([...exec.pop().toByteArray()]).to.deep.eq([
            9,
            ...Array(31).fill(0),
        ]);
    });

    it('grows mem by reading', async () => {
        const { exec } = await executeBytecode([
            0x60, 0x0, // push1 0x1
            0x51, // mload
            0x59, // msize
        ]);
        expect(exec.popAsNum()).to.equal(0x20);
    })

    it('grows mem word by word 1', async () => {
        const { exec } = await executeBytecode([
            0x60, 0x1, // push1 0x1
            0x51, // mload
            0x59, // msize
        ]);
        expect(exec.popAsNum()).to.equal(0x40);
    })

    it('grows mem word by word 2', async () => {
        const { exec } = await executeBytecode([
            0x60, 0x21, // push1 0x1
            0x51, // mload
            0x59, // msize
        ]);
        expect(exec.popAsNum()).to.equal(0x60);
    })

    it('mload', async () => {
        const { exec } = await executeBytecode([
            // Put the state in memory
            0x7F, ...Array(31).fill(0), 0xFF, // PUSH32 0x00000000000000000000000000000000000000000000000000000000000000FF
            0x60, 0, // PUSH1 0
            0x52, // MSTORE

            // Example 1
            0x60, 0, // PUSH1 0
            0x51, // MLOAD

            // Example 2
            0x60, 1, // PUSH1 1
            0x51, // MLOAD

        ]);
        expect(exec.popAsNum()).to.equal(0xff00);
        expect(exec.popAsNum()).to.equal(0xff);
    })


    it('sha3', async () => {
        const { exec } = await executeBytecode([
            // store data to hash in memory
            0x7F, 0xFF, 0xFF, 0xFF, 0xFF, ...Array(32 - 4).fill(0), // PUSH32 0xFFFFFFFFFF00....
            0x60, 0, // PUSH1 0
            0x52, // MSTORE

            // Call sha3
            0x60, 4, // PUSH1 4
            0x60, 0, // PUSH1 0
            0x20, // SHA3
        ]);
        expect(dumpU256(exec.pop())).to.equal('29045a592007d0c246ef02c2223570da9522d0cf0f73282c79a1bc8f0bb2c238');
    })

    describe('signed comparison', () => {

        it('slt left 0 right positive', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0x0000000000000000000000000000000000000000000000000000000000000001'), // PUSH32
                0x60, 0, // push 0,
                0x12, // SLT
            ]);
            expect(exec.popAsNum()).to.equal(1);
        });

        it('slt left positive right 0', async () => {
            const { exec } = await executeBytecode([
                0x60, 0, // push 0,
                0x7F, ...toUintBuffer('0x0000000000000000000000000000000000000000000000000000000000000001'), // PUSH32
                0x12, // SLT
            ]);
            expect(exec.popAsNum()).to.equal(0);
        });

        it('slt left 0 right negative', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0x8000000000000000000000000000000000000000000000000000000000000001'), // PUSH32
                0x60, 0, // push 0,
                0x12, // SLT
            ]);
            expect(exec.popAsNum()).to.equal(0);
        });

        it('slt left negative right 0', async () => {
            const { exec } = await executeBytecode([
                0x60, 0, // push 0,
                0x7F, ...toUintBuffer('0x8000000000000000000000000000000000000000000000000000000000000001'), // PUSH32
                0x12, // SLT
            ]);
            expect(exec.popAsNum()).to.equal(1);
        });

        it('slt not same sign -> 0', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'), // PUSH32
                0x60, 0x9, // push1 9
                0x12, // SLT
            ]);
            expect(exec.popAsNum()).to.equal(0);
        });

        it('slt not same sign -> 1', async () => {
            const { exec } = await executeBytecode([
                0x60, 0x9, // push1 9
                0x7F, ...toUintBuffer('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'), // PUSH32
                0x12, // SLT
            ]);
            expect(exec.popAsNum()).to.equal(1);
        });

        it('slt equals', async () => {
            const { exec } = await executeBytecode([
                0x60, 10, // push1 10
                0x60, 10, // push1 10
                0x12, // SLT
            ]);
            expect(exec.popAsNum()).to.equal(0);
        });


        it('slt negatives -> 0', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0x8000000000000000000000000000000000000000000000000000000000000001'),
                0x7F, ...toUintBuffer('0x8000000000000000000000000000000000000000000000000000000000000002'),
                0x12, // SLT
            ]);
            expect(exec.popAsNum()).to.equal(0);
        });


        it('slt negatives -> 1', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0x8000000000000000000000000000000000000000000000000000000000000002'),
                0x7F, ...toUintBuffer('0x8000000000000000000000000000000000000000000000000000000000000001'),
                0x12, // SLT
            ]);
            expect(exec.popAsNum()).to.equal(1);
        });



        it('slt positives -> 0', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0x0000000000000000000000000000000000000000000000000000000000000001'),
                0x7F, ...toUintBuffer('0x0000000000000000000000000000000000000000000000000000000000000002'),
                0x12, // SLT
            ]);
            expect(exec.popAsNum()).to.equal(0);
        });


        it('slt positives -> 1', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0x0000000000000000000000000000000000000000000000000000000000000002'),
                0x7F, ...toUintBuffer('0x0000000000000000000000000000000000000000000000000000000000000001'),
                0x12, // SLT
            ]);
            expect(exec.popAsNum()).to.equal(1);
        });


        // ========= SGT


        it('sgt left 0 right positive', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0x0000000000000000000000000000000000000000000000000000000000000001'), // PUSH32
                0x60, 0, // push 0,
                0x13, // sgt
            ]);
            expect(exec.popAsNum()).to.equal(0);
        });

        it('sgt left positive right 0', async () => {
            const { exec } = await executeBytecode([
                0x60, 0, // push 0,
                0x7F, ...toUintBuffer('0x0000000000000000000000000000000000000000000000000000000000000001'), // PUSH32
                0x13, // sgt
            ]);
            expect(exec.popAsNum()).to.equal(1);
        });

        it('sgt left 0 right negative', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0x8000000000000000000000000000000000000000000000000000000000000001'), // PUSH32
                0x60, 0, // push 0,
                0x13, // sgt
            ]);
            expect(exec.popAsNum()).to.equal(1);
        });

        it('sgt left negative right 0', async () => {
            const { exec } = await executeBytecode([
                0x60, 0, // push 0,
                0x7F, ...toUintBuffer('0x8000000000000000000000000000000000000000000000000000000000000001'), // PUSH32
                0x13, // sgt
            ]);
            expect(exec.popAsNum()).to.equal(0);
        });


        it('sgt not same sign -> 0', async () => {
            const { exec } = await executeBytecode([
                0x60, 0x9, // push1 9
                0x7F, ...toUintBuffer('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'), // PUSH32
                0x13, // SGT
            ]);
            expect(exec.popAsNum()).to.equal(0);
        });

        it('sgt not same sign -> 1', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'), // PUSH32
                0x60, 0x9, // push1 9
                0x13, // SGT
            ]);
            expect(exec.popAsNum()).to.equal(1);
        });

        it('stg equals', async () => {
            const { exec } = await executeBytecode([
                0x60, 10, // push1 10
                0x60, 10, // push1 10
                0x13, // SGT
            ]);
            expect(exec.popAsNum()).to.equal(0);
        });



        it('sgt positives -> 1', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0x0000000000000000000000000000000000000000000000000000000000000001'),
                0x7F, ...toUintBuffer('0x0000000000000000000000000000000000000000000000000000000000000002'),
                0x13, // sgt
            ]);
            expect(exec.popAsNum()).to.equal(1);
        });


        it('sgt positives -> 0', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0x0000000000000000000000000000000000000000000000000000000000000002'),
                0x7F, ...toUintBuffer('0x0000000000000000000000000000000000000000000000000000000000000001'),
                0x13, // sgt
            ]);
            expect(exec.popAsNum()).to.equal(0);
        });

        it('sgt negatives -> 0', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0x8000000000000000000000000000000000000000000000000000000000000002'),
                0x7F, ...toUintBuffer('0x8000000000000000000000000000000000000000000000000000000000000001'),
                0x13, // sgt
            ]);
            expect(exec.popAsNum()).to.equal(0);
        });

        it('sgt negatives -> 1', async () => {
            const { exec } = await executeBytecode([
                0x7F, ...toUintBuffer('0x8000000000000000000000000000000000000000000000000000000000000001'),
                0x7F, ...toUintBuffer('0x8000000000000000000000000000000000000000000000000000000000000002'),
                0x13, // sgt
            ]);
            expect(exec.popAsNum()).to.equal(1);
        });
    });


    it('selfbalance when has sent value', async () => {
        const { exec } = await executeBytecode([
            0x47 // SELFBALANCE
        ], {
            callvalue: U256(123)
        }, U256(12345));
        expect(exec.popAsNum()).to.equal(123);
    });

    it('balance of self when has sent value', async () => {
        const { exec } = await executeBytecode([
            0x30, // ADDRESS
            0x31 // BALANCE
        ], {
            callvalue: U256(123),
            origin: U256(0x1234),
        }, U256(12345));
        expect(exec.popAsNum()).to.equal(123);
    });

    it('byte', async () => {
        const { exec } = await executeBytecode([
            0x61, 0xff, 0x00, // push2 0xff00
            0x60, 30, // push1 30
            0x1a, // BYTE
        ]);
        expect(exec.popAsNum()).to.equal(0xff);
    });


    it('dup1', async () => {
        const { exec } = await executeBytecode([
            0x60, 1, // push1 1
            0x60, 2, // push1 2
            0x80, // dup1
        ]);
        expect(exec.popAsNum()).to.equal(2);
    });



    it('dup2', async () => {
        const { exec } = await executeBytecode([
            0x60, 1, // push1 1
            0x60, 2, // push1 2
            0x81, // dup2
        ]);
        expect(exec.popAsNum()).to.equal(1);
    });

    it('dup3', async () => {
        const { exec } = await executeBytecode([
            0x60, 1, // push1 1
            0x60, 2, // push1 2
            0x60, 2, // push1 2
            0x82, // dup3
        ]);
        expect(exec.popAsNum()).to.equal(1);
    });


    async function callSomeCode(codeToCall: string, op: 'call' | 'staticcall' | 'delegatecall' | 'callcode') {

        const session = new Session(TEST_SESSION_OPTS);

        // this contract will call the right opcode
        // ... this is executed by the HyVM in Opcodes.t.sol:testOrigin_call, ...
        const addressGetterContract = await session.deployRaw(codeToCall);

        let opcode: number;
        let hasValue = false;
        switch (op) {
            case 'call':
                opcode = 0xf1;
                hasValue = true;
                break;
            case 'callcode':
                opcode = 0xf2;
                hasValue = true;
                break;
            case 'staticcall':
                opcode = 0xfa;
                break;
            case 'delegatecall':
                opcode = 0xf4;
                break;
            default:
                throw new Error('invalid op');
        }

        // this contract is just a relayer => it just calls the given bytecode
        // ... this is the unit test in Opcodes.t.sol
        const callerContract = await session.deployRaw(new Uint8Array([
            0x60, 0x20, // push1 retSize
            0x60, 0, // push1 retOffset
            0x60, 0, // push1 argSize
            0x60, 0, // push1 argOffset
            ...hasValue ? [0x60, 0] : [], // push 0 as value if necessary
            0x7f, ...addressGetterContract.toByteArray(), // push32 contract to call
            0x5a, // gas
            opcode, // delegatecall

            // load the result on stack
            0x60, 0, // push 0
            0x51, // mload

            0x90 // swap1 => [ok, callResult]
        ]));


        // generate addresses
        const origin = generateAddress('origin'); // this is the tx sender
        console.log(`Contracts:
        origin: ${to0xAddress(origin)}
        callerContract: ${to0xAddress(callerContract)}
        addressGetterContract: ${to0xAddress(addressGetterContract)}`);

        // call
        const exec = await session.prepareCall(newTxData(callerContract, {
            origin,
            static: op === 'staticcall',
        }));
        await execWatchInstructions(exec);

        expect(exec.popAsNum()).to.equal(1, 'expected call success');

        const result = to0xAddress(exec.pop());
        switch (result) {
            case to0xAddress(origin):
                return 'origin' as const;
            case to0xAddress(callerContract):
                return 'callerContract' as const;
            case to0xAddress(addressGetterContract):
                return 'addressGetterContract' as const;
            default:
                throw new Error('Unexpected address ' + result);
        }
    }

    describe('address', () => {

        it('address in delegatecall', async () => {
            // see testAddress_delegatecall() of HyVM
            const result = await callSomeCode('3060005260ff6000f3', 'delegatecall');
            expect(result).to.equal('callerContract');
        });

        it('address in call', async () => {
            // see testAddress_call() of HyVM
            const result = await callSomeCode('3060005260ff6000f3', 'call');
            expect(result).to.equal('addressGetterContract');
        });

        it('address in staticcall', async () => {
            // see testAddress_staticcall() of HyVM
            const result = await callSomeCode('3060005260ff6000f3', 'staticcall');
            expect(result).to.equal('addressGetterContract');
        });

    })



    describe('origin', () => {

        it('origin in delegatecall', async () => {
            // see testOrigin_delegatecall() of HyVM
            const result = await callSomeCode('3260005260ff6000f3', 'delegatecall');
            expect(result).to.equal('origin');
        });

        it('origin in call', async () => {
            // see testOrigin_call() of HyVM
            const result = await callSomeCode('3260005260ff6000f3', 'call');
            expect(result).to.equal('origin');
        });

        it('origin in staticcall', async () => {
            // see testOrigin_staticcall() of HyVM
            const result = await callSomeCode('3260005260ff6000f3', 'staticcall');
            expect(result).to.equal('origin');
        });
    })


    describe('caller', () => {

        it('caller in delegatecall', async () => {
            // see testCaller_delegatecall() of HyVM
            const result = await callSomeCode('3360005260ff6000f3', 'delegatecall');
            expect(result).to.equal('origin');
        });

        it('caller in call', async () => {
            // see testCaller_call() of HyVM
            const result = await callSomeCode('3360005260ff6000f3', 'call');
            expect(result).to.equal('callerContract');
        });

        it('caller in staticcall', async () => {
            // see testCaller_staticcall() of HyVM
            const result = await callSomeCode('3360005260ff6000f3', 'staticcall');
            expect(result).to.equal('callerContract');
        });
    })


});