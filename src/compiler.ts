import { utils } from 'ethers';
import keccak256 from 'keccak256';
import { Executor, ops } from './executor';
import { CompiledCode, HexString } from './interfaces';
import { MemReader } from './mem-reader';
import { generateAddress, getNodejsLibs, to0xAddress } from './utils';

const p = Executor.prototype;

type CP = {
    address: number;
    isAsync: boolean;
    codeLines: string[];
    mayReturn: Ret;
};
type Ret = 'always' | 'maybe' | 'no';

type Nm = string | Def | null | undefined;
type Def = { name: string; abi?: utils.Interface };

export function compileCode(
    contractCode: Uint8Array,
    _def: Nm | ((address: HexString) => Nm),
    forceAddress?: bigint,
    knownSequences?: KnownSequence[],
    cacheDir?: string,
): CompiledCode {
    // compute all labels
    let codeParts = computeCodeparts(contractCode);

    // compute known sequences
    const { knownDetector, additionalCode } = detectKnownSequences(knownSequences);
    codeParts = codeParts.map(knownDetector);

    // compute final code
    const address = forceAddress ?? generateAddress(contractCode);
    const defGot = typeof _def === 'function' ? _def(to0xAddress(address)) : _def;
    const def: Def | null | undefined = typeof defGot === 'string' ? { name: defGot } : defGot;
    const contractName = def?.name;
    const hasAsync = codeParts.some(c => c.isAsync);

    const label = contractName ? `${contractName}_label_` : 'label_';
    const code = `
// step into this to debug the contract
// while puting watches: e.dumpStack(), e.dumpMemory(), e.dumpCalldata()

function ${contractName ?? 'entry'}(e) {
let mem, stack;

${codeParts
    .map(
        (c, i) => `const ${label}${c.address.toString(16)} = ${c.isAsync ? 'async' : ''} () =>  {
    ${c.codeLines.join('\n    ')}
${
    i !== codeParts.length - 1 && c.mayReturn !== 'always'
        ? `    return ${label}${codeParts[i + 1].address.toString(16)};`
        : ''
}
}`,
    )
    .join('\n\n')}

${additionalCode()
    .map(
        c => `const ${c.name} = ${c.code.isAsync ? 'async' : ''} () =>  {
try {
    e.startKnownSequence('${c.name}');
    ${c.code.codeLines.join('\n    ')}
} finally { e.endKnownSequence(); }
}`,
    )
    .join('\n\n')}

const labels = new Map([${codeParts
        .map(c => `[0x${c.address.toString(16)}, ${label}${c.address.toString(16)}]`)
        .join(',')}])
function getLabel(address) {
    const label = labels.get(address);
    if (!label) {
        throw new Error('Expected a JUMPDEST op at 0x' + address.toString(16));
    }
    return label;
}

return ${hasAsync ? 'async' : ''} () =>  {
    stack = e.stack;
    mem = e.mem;
    let current = ${label}0; // start at address 0
    while (current && !e.stop) {
        current = ${hasAsync ? 'await ' : ''}current();
    }
};
}`;

    const { require, writeCache } = getNodejsLibs(cacheDir);
    let bind: any;
    if (writeCache) {
        // when running NodeJS, lets write this in a file, in order to run it

        // create an unique file name based on its hash, or starting by "µ" (so unnamed contracts appear last in alphabetical order)
        const hash = (contractName ?? 'µ') + '_' + keccak256(Buffer.from(contractCode)).toString('hex');

        // write code
        const target = writeCache(
            `contracts/${hash}.js`,
            `${code}
module.exports = ${contractName ?? 'entry'}`,
        );

        // init
        bind = require(target);
    } else {
        // when running in a navigator, then eval this file.
        bind = eval(`${code}
${contractName ?? 'entry'} // return the program entry`);
    }
    bind.code = new MemReader(contractCode);
    bind.contractName = contractName ?? null;
    bind.contractAddress = address;
    bind.contractAbi = def?.abi;
    return bind;
}

function computeCodeparts(contractCode: Uint8Array) {
    let codeParts: CP[] = [];
    let currentAddress = 0;
    let current: string[] = [];
    let currentIsAsync = false;
    let mayReturn: Ret = 'no';
    function finishCurrent() {
        codeParts.push({
            address: currentAddress,
            codeLines: current,
            isAsync: currentIsAsync,
            mayReturn,
        });
        current = [];
        currentIsAsync = false;
        mayReturn = 'no';
    }
    for (let i = 0; i < contractCode.length; i++) {
        const opcode = contractCode[i];
        const fn = ops[opcode];
        switch (fn) {
            case p.op_jumpdest:
                // found a jumpdest => end of current function, start of a new one
                finishCurrent();
                currentAddress = i;
                current = [`e.${fn.name}();`];
                break;
            case p.op_jump:
                // jump has a special implementation
                mayReturn = 'always';
                current.push(
                    '// == jump: ',
                    '{',
                    '    const to = e.popAsNum();',
                    `    e.${fn.name}();`,
                    '    return getLabel(to);',
                    '}',
                );
                break;
            case p.op_jumpi:
                // jumpi has a special implementation
                if (mayReturn !== 'always') {
                    mayReturn = 'maybe';
                }
                current.push(
                    '// == jumpi:',
                    '{',
                    '    const to = e.popAsNum();',
                    '    const condition = e.popAsBool();',
                    `    e.${fn.name}();`,
                    '    if (condition) {',
                    '         return getLabel(to);',
                    '    }',
                    '}',
                );
                break;
            case p.op_pc:
                // PC has a special implementation
                current.push(`e.op_pc(0x${i.toString(16)});`);
                break;
            case p.op_push1:
                // push1 consumes data
                i++;
                current.push(`e.${fn.name}(0x${contractCode[i].toString(16)});`);
                break;
            case p.op_return:
            case p.op_stop:
            case p.op_revert:
                mayReturn = 'always';
                current.push(`return e.${fn.name}();`);
                break;
            case p.op_invalid:
                current.push(`e.${fn.name}(); // opcode 0x${opcode.toString(16)} is not valid`);
                break;

            case p.op_push2:
            case p.op_push3:
            case p.op_push4:
            case p.op_push5:
            case p.op_push6:
            case p.op_push7:
            case p.op_push8:
            case p.op_push9:
            case p.op_push10:
            case p.op_push11:
            case p.op_push12:
            case p.op_push13:
            case p.op_push14:
            case p.op_push15:
            case p.op_push16:
            case p.op_push17:
            case p.op_push18:
            case p.op_push19:
            case p.op_push20:
            case p.op_push21:
            case p.op_push22:
            case p.op_push23:
            case p.op_push24:
            case p.op_push25:
            case p.op_push26:
            case p.op_push27:
            case p.op_push28:
            case p.op_push29:
            case p.op_push30:
            case p.op_push31:
            case p.op_push32:
                // all push operations are consuming data => special impl
                const nBytes = parseInt(/(\d+)$/.exec(fn.name)![1]);
                const toPush = contractCode.slice(i + 1, i + 1 + nBytes);
                i += nBytes;
                current.push(
                    `e.${fn.name}([${[...toPush]
                        .map(x => '0x' + x.toString(16))
                        .join(', ')}]) // PUSH${nBytes} 0x${Buffer.from(toPush).toString('hex')}`,
                );
                break;
            default:
                // all other ops, that wont consume data
                if (fn.isAsync) {
                    current.push(`await e.${fn.name}();`);
                    currentIsAsync = true;
                } else {
                    current.push(`e.${fn.name}();`);
                }
        }
    }
    finishCurrent();
    return codeParts;
}

export interface KnownSequence {
    code: Uint8Array;
    name: string;
}

interface KnownCP {
    name: string;
    code: CP;
}

function detectKnownSequences(_sequences: KnownSequence[] | undefined): {
    knownDetector: (cp: CP) => CP;
    additionalCode: () => KnownCP[];
} {
    if (!_sequences?.length) {
        return {
            knownDetector: x => x,
            additionalCode: () => [],
        };
    }
    const sequences = _sequences.map<KnownCP>(n => {
        const code = computeCodeparts(n.code);
        if (code.length !== 1) {
            throw new Error('Invalid known sequence');
        }
        return {
            code: code[0],
            name: n.name,
        };
    });

    const usedSequences = new Set<KnownCP>();

    return {
        knownDetector: cp => {
            let codeLines = cp.codeLines;
            for (const seq of sequences) {
                if (seq.code.codeLines.length >= codeLines.length) {
                    // not enough code lines in the given code to match this known sequence
                    continue;
                }
                const seqSig = seq.code.codeLines.join('|');

                // find an index at which this sequence is to be found
                while (true) {
                    let i = codeLines.findIndex(
                        (_, i) => seqSig === codeLines.slice(i, i + seq.code.codeLines.length).join('|'),
                    );
                    if (i < 0) {
                        break;
                    }
                    usedSequences.add(seq);
                    const callSeq = `${seq.code.isAsync ? 'await ' : ''}${seq.name}();`;
                    let compiled: string[];
                    switch (seq.code.mayReturn) {
                        case 'no':
                            compiled = [callSeq + `// known sequence ${seq.name}`];
                            break;
                        case 'always':
                            compiled = [`return  ${callSeq} // known sequence ${seq.name}`];
                            break;
                        case 'maybe':
                            compiled = [
                                `{ // known sequence ${seq.name}`,
                                `   const seq = ${callSeq}`,
                                '   if (seq) {',
                                `        return seq;`,
                                '   }',
                                '}',
                            ];
                            break;
                    }
                    codeLines = [
                        ...codeLines.slice(0, i),
                        ...compiled,
                        ...codeLines.slice(i + seq.code.codeLines.length),
                    ];
                }
            }
            return cp.codeLines === codeLines
                ? cp
                : {
                      ...cp,
                      codeLines,
                  };
        },
        additionalCode: () => [...usedSequences],
    };
}
