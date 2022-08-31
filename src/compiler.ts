import keccak256 from 'keccak256';
import { Executor, ops } from './executor';
import { CompiledCode, HexString } from './interfaces';
import { MemReader } from './mem-reader';
import { generateAddress, getNodejsLibs, to0xAddress } from './utils';

const p = Executor.prototype;

export function compileCode(contractCode: Uint8Array, _contractName: string | null | undefined | ((address: HexString) => string | null | undefined)): CompiledCode {
    type CP = { address: number; isAsync: boolean; codeLines: string[]; };
    const codeParts: CP[] = [];
    function finishCurrent() {
        codeParts.push({
            address: currentAddress,
            codeLines: current,
            isAsync: currentIsAsync,
        });
        current = [];
        currentIsAsync = false;
    }
    let currentAddress = 0;
    let current: string[] = [];
    let currentIsAsync = false;
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
                current.push(
                    '// == jump: ',
                    '{',
                    '    const to = e.popAsNum();',
                    `    e.${fn.name}();`,
                    '    return getLabel(to);',
                    '}');
                break;
            case p.op_jumpi:
                // jumpi has a special implementation
                current.push(
                    '// == jumpi:',
                    '{',
                    '    const to = e.popAsNum();',
                    '    const condition = e.popAsBool();',
                    `    e.${fn.name}();`,
                    '    if (condition) {',
                    '         return getLabel(to);',
                    '    }',
                    '}');
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
                current.push(`e.${fn.name}([${[...toPush].map(x => '0x' + x.toString(16)).join(', ')}]) // PUSH${nBytes} 0x${Buffer.from(toPush).toString('hex')}`);
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

    const address = generateAddress(contractCode);
    const contractName = typeof _contractName === 'string'
        ? _contractName
        : _contractName?.(to0xAddress(address));
    const hasAsync = codeParts.some(c => c.isAsync);
    const label = contractName ? `${contractName}_label_` : 'label_';
    const code = `
// step into this to debug the contract
// while puting watches: e.dumpStack(), e.dumpMemory(), e.dumpCalldata()

function ${contractName ?? 'entry'}(e) {
let mem, stack;

${codeParts.map((c, i) => `const ${label}${c.address.toString(16)} = ${c.isAsync ? 'async' : ''} () =>  {
${c.codeLines.join('\n    ')}
${i !== codeParts.length - 1 ? `return ${label}${codeParts[i + 1].address.toString(16)};` : ''}
}`).join('\n\n')}

const labels = new Map([${codeParts.map(c => `[0x${c.address.toString(16)}, ${label}${c.address.toString(16)}]`).join(',')}])
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

    const { require, fs, path, process } = getNodejsLibs();
    let bind: any;
    if (fs) {
        // when running NodeJS, lets write this in a file, in order to run it

        const targetDir = path.resolve(process.cwd(), '.contract-cache');

        // create an unique file name based on its hash, or starting by "µ" (so unnamed contracts appear last in alphabetical order)
        const hash = (contractName ?? 'µ') + '_' + keccak256(Buffer.from(contractCode)).toString('hex');
        const target = path.resolve(targetDir, `${hash}.js`);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir);
        }

        // write code
        fs.writeFileSync(target, `${code}
module.exports = ${contractName ?? 'entry'}`);

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
    return bind;
}
