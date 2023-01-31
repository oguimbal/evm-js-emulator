A simple in-memory EVM JS emulator.


# Install


```
npm i evm-js-emulator
```


# Usage


```typescript
import { newSession, parseBuffer, toUint, MAX_UINT, isSuccess } from 'evm-js-emulator';


// create a blockchain fork
const session = newSession({
    // let's fork Polygon
    rpcUrl: 'https://polygon-rpc.com',
    // when you're running node, cache RPC results in order to avoid reboot
    cacheDir: '.evm-cache',
});


// prepare an execution
const executor = await session.prepareCall({
    contract: toUint('0x ... write contract address here ...'),
    origin: toUint('0x ... write sender address here ...'),
    // a buffer which represents calldata
    calldata: parseBuffer('0x ... write calldata here ...'),
    // tx value
    callvalue: U256(0),
    // this is not a static call (allow mutations)
    static: false,
    // force timestamp to a given value (optional)
    timestamp: Date.now() / 1000,
    // other paramters
    gasLimit: MAX_UINT,
    gasPrice: U256(0xffff),
    retdatasize: 0,
});

// execute !
const result = await executor.execute();

if (isSuccess(result)) {
    // do something ...
}

// etc... you can chain multiple executions

```


# Debugging

- Once you get an executor, before calling `.execute()`, you can log every EVM execution instruction using the helper:

```typescript
import { watchInstructions } from 'evm-js-emulator/tests/test-utils';

// this will log all instructions down to a depth of 3 subcalls
watchInstructions(executor, 3);
```
- You can name contracts or add ABIs to have nicer logs using the `contractsNames` properties of `newSession({ contractsNames: ...})` (see types).

- Add breakpoints in codegen js files that you will find in you cache directory (subdirectory "contracts")... those are the contracts you are running, compiled to JS.

# Disclaimer

This is a best-effort reproduction of the EVM.

It has been tested on many contracts, but:

- Gas is almost not implemented (contributions welcome)
- Some opcodes might not be implemented  (contributions welcome)
- Behaviours might differ


# Debugging a run

You'll notice that every contract
