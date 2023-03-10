import fs from 'fs';

// Javascript Solidity compiler
var solc = require('solc');

export function getCreate2ByteCode(contractName: string) {
    var create2ByteCode = ""

    var solcOpt = {
        language: 'Solidity',
        sources: {
            'compiled': {
                content: fs.readFileSync('tests/contracts/' + contractName + '.sol', { encoding: 'utf8' })
            }
        },
        settings: {
            outputSelection: {
                '*': {
                    '*': ['*']
                }
            }
        }
    };

    const creationCode = JSON.parse(solc.compile(JSON.stringify(solcOpt)))
        .contracts['compiled']['DummyConstructor'].evm.bytecode.object;

    // Store creation code in memory
    for(let i = 0; i < creationCode.length; i += 64){
        // PUSH32
        create2ByteCode += "7f"
        // 32 bytes creation code batch
        create2ByteCode += creationCode.slice(i, i+64).padEnd(64, '0')
        // PUSHn for memory offset
        const memoryOffset = (i / 2).toString(16).padStart((i / 2).toString(16).length % 2 == 0 ? (i / 2).toString(16).length : (i / 2).toString(16).length + 1, "0")
        create2ByteCode += (95 + memoryOffset.length / 2 ).toString(16)
        create2ByteCode += memoryOffset
        // MSTORE
        create2ByteCode += "52"
    }

    // Push CREATE2
    create2ByteCode += "600260fc60006000f5"

    // Store result address in memory and return it
    create2ByteCode += "60005260206000f3"

    return create2ByteCode
}