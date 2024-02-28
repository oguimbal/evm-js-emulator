import { getRandomBytesSync } from 'ethereum-cryptography/random';
import { bytesToHex as _bytesToUnprefixedHex, utf8ToBytes } from 'ethereum-cryptography/utils';
import { HexString } from './interfaces';

const BIGINT_0 = BigInt(0);

// hexToBytes cache
const hexToBytesMapFirstKey: { [key: string]: number } = {};
const hexToBytesMapSecondKey: { [key: string]: number } = {};

for (let i = 0; i < 16; i++) {
    const vSecondKey = i;
    const vFirstKey = i * 16;
    const key = i.toString(16).toLowerCase();
    hexToBytesMapSecondKey[key] = vSecondKey;
    hexToBytesMapSecondKey[key.toUpperCase()] = vSecondKey;
    hexToBytesMapFirstKey[key] = vFirstKey;
    hexToBytesMapFirstKey[key.toUpperCase()] = vFirstKey;
}

/**
 * NOTE: only use this function if the string is even, and only consists of hex characters
 * If this is not the case, this function could return weird results
 * @deprecated
 */
function _unprefixedHexToBytes(hex: string): Uint8Array {
    const byteLen = hex.length;
    const bytes = new Uint8Array(byteLen / 2);
    for (let i = 0; i < byteLen; i += 2) {
        bytes[i / 2] = hexToBytesMapFirstKey[hex[i]] + hexToBytesMapSecondKey[hex[i + 1]];
    }
    return bytes;
}

/**
 * @deprecated
 */
export const unprefixedHexToBytes = (inp: string) => {
    if (inp.slice(0, 2) === '0x') {
        throw new Error('hex string is prefixed with 0x, should be unprefixed');
    } else {
        return _unprefixedHexToBytes(padToEven(inp));
    }
};

/****************  Borrowed from @chainsafe/ssz */
// Caching this info costs about ~1000 bytes and speeds up toHexString() by x6
const hexByByte = Array.from({ length: 256 }, (v, i) => i.toString(16).padStart(2, '0'));

export const bytesToHex = (bytes: Uint8Array): string => {
    let hex = '0x';
    if (bytes === undefined || bytes.length === 0) return hex;
    for (const byte of bytes) {
        hex += hexByByte[byte];
    }
    return hex;
};

// BigInt cache for the numbers 0 - 256*256-1 (two-byte bytes)
const BIGINT_CACHE: bigint[] = [];
for (let i = 0; i <= 256 * 256 - 1; i++) {
    BIGINT_CACHE[i] = BigInt(i);
}

/**
 * Converts a {@link Uint8Array} to a {@link bigint}
 * @param {Uint8Array} bytes the bytes to convert
 * @returns {bigint}
 */
export const bytesToBigInt = (bytes: Uint8Array, littleEndian = false): bigint => {
    if (littleEndian) {
        bytes.reverse();
    }
    const hex = bytesToHex(bytes);
    if (hex === '0x') {
        return BIGINT_0;
    }
    if (hex.length === 4) {
        // If the byte length is 1 (this is faster than checking `bytes.length === 1`)
        return BIGINT_CACHE[bytes[0]];
    }
    if (hex.length === 6) {
        return BIGINT_CACHE[bytes[0] * 256 + bytes[1]];
    }
    return BigInt(hex);
};

/**
 * Converts a {@link Uint8Array} to a {@link number}.
 * @param {Uint8Array} bytes the bytes to convert
 * @return  {number}
 * @throws If the input number exceeds 53 bits.
 */
export const bytesToInt = (bytes: Uint8Array): number => {
    const res = Number(bytesToBigInt(bytes));
    if (!Number.isSafeInteger(res)) throw new Error('Number exceeds 53 bits');
    return res;
};

export const hexToBytes = (hex: string): Uint8Array => {
    if (typeof hex !== 'string') {
        throw new Error(`hex argument type ${typeof hex} must be of type string`);
    }

    if (!/^0x[0-9a-fA-F]*$/.test(hex)) {
        throw new Error(`Input must be a 0x-prefixed hexadecimal string, got ${hex}`);
    }

    hex = hex.slice(2);

    if (hex.length % 2 !== 0) {
        hex = padToEven(hex);
    }
    return _unprefixedHexToBytes(hex);
};

/******************************************/

/**
 * Converts a {@link number} into a {@link HexString}
 * @param {number} i
 * @return {HexString}
 */
export const intToHex = (i: number): HexString => {
    if (!Number.isSafeInteger(i) || i < 0) {
        throw new Error(`Received an invalid integer type: ${i}`);
    }
    return `0x${i.toString(16)}`;
};

/**
 * Converts an {@link number} to a {@link Uint8Array}
 * @param {Number} i
 * @return {Uint8Array}
 */
export const intToBytes = (i: number): Uint8Array => {
    const hex = intToHex(i);
    return hexToBytes(hex);
};

/**
 * Converts a {@link bigint} to a {@link Uint8Array}
 *  * @param {bigint} num the bigint to convert
 * @returns {Uint8Array}
 */
export const bigIntToBytes = (num: bigint, littleEndian = false): Uint8Array => {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const bytes = toBytes(`0x${padToEven(num.toString(16))}`);

    return littleEndian ? bytes.reverse() : bytes;
};

/**
 * Returns a Uint8Array filled with 0s.
 * @param {number} bytes the number of bytes of the Uint8Array
 * @return {Uint8Array}
 */
export const zeros = (bytes: number): Uint8Array => {
    return new Uint8Array(bytes);
};

/**
 * Pads a `Uint8Array` with zeros till it has `length` bytes.
 * Truncates the beginning or end of input if its length exceeds `length`.
 * @param {Uint8Array} msg the value to pad
 * @param {number} length the number of bytes the output should be
 * @param {boolean} right whether to start padding form the left or right
 * @return {Uint8Array}
 */
const setLength = (msg: Uint8Array, length: number, right: boolean): Uint8Array => {
    if (right) {
        if (msg.length < length) {
            return new Uint8Array([...msg, ...zeros(length - msg.length)]);
        }
        return msg.subarray(0, length);
    } else {
        if (msg.length < length) {
            return new Uint8Array([...zeros(length - msg.length), ...msg]);
        }
        return msg.subarray(-length);
    }
};

/**
 * Left Pads a `Uint8Array` with leading zeros till it has `length` bytes.
 * Or it truncates the beginning if it exceeds.
 * @param {Uint8Array} msg the value to pad
 * @param {number} length the number of bytes the output should be
 * @return {Uint8Array}
 */
export const setLengthLeft = (msg: Uint8Array, length: number): Uint8Array => {
    assertIsBytes(msg);
    return setLength(msg, length, false);
};

/**
 * Right Pads a `Uint8Array` with trailing zeros till it has `length` bytes.
 * it truncates the end if it exceeds.
 * @param {Uint8Array} msg the value to pad
 * @param {number} length the number of bytes the output should be
 * @return {Uint8Array}
 */
export const setLengthRight = (msg: Uint8Array, length: number): Uint8Array => {
    assertIsBytes(msg);
    return setLength(msg, length, true);
};

/**
 * Trims leading zeros from a `Uint8Array`, `number[]` or HexString`.
 * @param {Uint8Array|number[]|HexString} a
 * @return {Uint8Array|number[]|HexString}
 */
const stripZeros = <T extends Uint8Array | number[] | HexString = Uint8Array | number[] | HexString>(a: T): T => {
    let first = a[0];
    while (a.length > 0 && first.toString() === '0') {
        a = a.slice(1) as T;
        first = a[0];
    }
    return a;
};

/**
 * Trims leading zeros from a `Uint8Array`.
 * @param {Uint8Array} a
 * @return {Uint8Array}
 */
export const unpadBytes = (a: Uint8Array): Uint8Array => {
    assertIsBytes(a);
    return stripZeros(a);
};

/**
 * Trims leading zeros from an `Array` (of numbers).
 * @param  {number[]} a
 * @return {number[]}
 */
export const unpadArray = (a: number[]): number[] => {
    assertIsArray(a);
    return stripZeros(a);
};

export type ToBytesInputTypes =
    | HexString
    | number
    | bigint
    | Uint8Array
    | number[]
    | TransformabletoBytes
    | null
    | undefined;

export interface TransformabletoBytes {
    toBytes?(): Uint8Array;
}
/**
 * Attempts to turn a value into a `Uint8Array`.
 * Inputs supported: `Buffer`, `Uint8Array`, `String` (hex-prefixed), `Number`, null/undefined, `BigInt` and other objects
 * with a `toArray()` or `toBytes()` method.
 * @param {ToBytesInputTypes} v the value
 * @return {Uint8Array}
 */

export const toBytes = (v: ToBytesInputTypes): Uint8Array => {
    if (v === null || v === undefined) {
        return new Uint8Array();
    }

    if (Array.isArray(v) || v instanceof Uint8Array) {
        return Uint8Array.from(v);
    }

    if (typeof v === 'string') {
        if (!isHexString(v)) {
            throw new Error(
                `Cannot convert string to Uint8Array. toBytes only supports 0x-prefixed hex strings and this string was given: ${v}`,
            );
        }
        return hexToBytes(v);
    }

    if (typeof v === 'number') {
        return intToBytes(v);
    }

    if (typeof v === 'bigint') {
        if (v < BIGINT_0) {
            throw new Error(`Cannot convert negative bigint to Uint8Array. Given: ${v}`);
        }
        let n = v.toString(16);
        if (n.length % 2) n = '0' + n;
        return unprefixedHexToBytes(n);
    }

    if (v.toBytes !== undefined) {
        // converts a `TransformableToBytes` object to a Uint8Array
        return v.toBytes();
    }

    throw new Error('invalid type');
};

export function toBytes32(v: ToBytesInputTypes): Uint8Array {
    return setLengthLeft(toBytes(v), 32);
}

/**
 * Interprets a `Uint8Array` as a signed integer and returns a `BigInt`. Assumes 256-bit numbers.
 * @param {Uint8Array} num Signed integer value
 * @returns {bigint}
 */
export const fromSigned = (num: Uint8Array): bigint => {
    return BigInt.asIntN(256, bytesToBigInt(num));
};

/**
 * Converts a `BigInt` to an unsigned integer and returns it as a `Uint8Array`. Assumes 256-bit numbers.
 * @param {bigint} num
 * @returns {Uint8Array}
 */
export const toUnsigned = (num: bigint): Uint8Array => {
    return bigIntToBytes(BigInt.asUintN(256, num));
};

/**
 * Adds "0x" to a given `string` if it does not already start with "0x".
 * @param {string} str
 * @return {HexString}
 */
export const addHexPrefix = (str: string): HexString => {
    if (typeof str !== 'string') {
        return str;
    }

    return isHexPrefixed(str) ? str : `0x${str}`;
};

/**
 * Shortens a string  or Uint8Array's hex string representation to maxLength (default 50).
 *
 * Examples:
 *
 * Input:  '657468657265756d000000000000000000000000000000000000000000000000'
 * Output: '657468657265756d0000000000000000000000000000000000…'
 * @param {Uint8Array | string} bytes
 * @param {number} maxLength
 * @return {string}
 */
export const short = (bytes: Uint8Array | string, maxLength: number = 50): string => {
    const byteStr = bytes instanceof Uint8Array ? bytesToHex(bytes) : bytes;
    const len = byteStr.slice(0, 2) === '0x' ? maxLength + 2 : maxLength;
    if (byteStr.length <= len) {
        return byteStr;
    }
    return byteStr.slice(0, len) + '…';
};

/**
 * Checks provided Uint8Array for leading zeroes and throws if found.
 *
 * Examples:
 *
 * Valid values: 0x1, 0x, 0x01, 0x1234
 * Invalid values: 0x0, 0x00, 0x001, 0x0001
 *
 * Note: This method is useful for validating that RLP encoded integers comply with the rule that all
 * integer values encoded to RLP must be in the most compact form and contain no leading zero bytes
 * @param values An object containing string keys and Uint8Array values
 * @throws if any provided value is found to have leading zero bytes
 */
export const validateNoLeadingZeroes = (values: { [key: string]: Uint8Array | undefined }) => {
    for (const [k, v] of Object.entries(values)) {
        if (v !== undefined && v.length > 0 && v[0] === 0) {
            throw new Error(`${k} cannot have leading zeroes, received: ${bytesToHex(v)}`);
        }
    }
};

/**
 * Converts a {@link bigint} to a `0x` prefixed hex string
 * @param {bigint} num the bigint to convert
 * @returns {HexString}
 */
export const bigIntToHex = (num: bigint): HexString => {
    return `0x${num.toString(16)}`;
};

/**
 * Convert value from bigint to an unpadded Uint8Array
 * (useful for RLP transport)
 * @param {bigint} value the bigint to convert
 * @returns {Uint8Array}
 */
export const bigIntToUnpaddedBytes = (value: bigint): Uint8Array => {
    return unpadBytes(bigIntToBytes(value));
};

/**
 * Convert value from number to an unpadded Uint8Array
 * (useful for RLP transport)
 * @param {number} value the bigint to convert
 * @returns {Uint8Array}
 */
export const intToUnpaddedBytes = (value: number): Uint8Array => {
    return unpadBytes(intToBytes(value));
};

/**
 * Compares two Uint8Arrays and returns a number indicating their order in a sorted array.
 *
 * @param {Uint8Array} value1 - The first Uint8Array to compare.
 * @param {Uint8Array} value2 - The second Uint8Array to compare.
 * @returns {number} A positive number if value1 is larger than value2,
 *                   A negative number if value1 is smaller than value2,
 *                   or 0 if value1 and value2 are equal.
 */
export const compareBytes = (value1: Uint8Array, value2: Uint8Array): number => {
    const bigIntValue1 = bytesToBigInt(value1);
    const bigIntValue2 = bytesToBigInt(value2);
    return bigIntValue1 > bigIntValue2 ? 1 : bigIntValue1 < bigIntValue2 ? -1 : 0;
};

/**
 * Generates a Uint8Array of random bytes of specified length.
 *
 * @param {number} length - The length of the Uint8Array.
 * @returns {Uint8Array} A Uint8Array of random bytes of specified length.
 */
export const randomBytes = (length: number): Uint8Array => {
    return getRandomBytesSync(length);
};

/**
 * This mirrors the functionality of the `ethereum-cryptography` export except
 * it skips the check to validate that every element of `arrays` is indead a `uint8Array`
 * Can give small performance gains on large arrays
 * @param {Uint8Array[]} arrays an array of Uint8Arrays
 * @returns {Uint8Array} one Uint8Array with all the elements of the original set
 * works like `Buffer.concat`
 */
export const concatBytes = (...arrays: Uint8Array[]): Uint8Array => {
    if (arrays.length === 1) return arrays[0];
    const length = arrays.reduce((a, arr) => a + arr.length, 0);
    const result = new Uint8Array(length);
    for (let i = 0, pad = 0; i < arrays.length; i++) {
        const arr = arrays[i];
        result.set(arr, pad);
        pad += arr.length;
    }
    return result;
};

/**
 * @notice Convert a Uint8Array to a 32-bit integer
 * @param {Uint8Array} bytes The input Uint8Array from which to read the 32-bit integer.
 * @param {boolean} littleEndian True for little-endian, undefined or false for big-endian.
 * @return {number} The 32-bit integer read from the input Uint8Array.
 */
export function bytesToInt32(bytes: Uint8Array, littleEndian: boolean = false): number {
    if (bytes.length < 4) {
        bytes = setLength(bytes, 4, littleEndian);
    }
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return dataView.getUint32(0, littleEndian);
}

/**
 * @notice Convert a Uint8Array to a 64-bit bigint
 * @param {Uint8Array} bytes The input Uint8Array from which to read the 64-bit bigint.
 * @param {boolean} littleEndian True for little-endian, undefined or false for big-endian.
 * @return {bigint} The 64-bit bigint read from the input Uint8Array.
 */
export function bytesToBigInt64(bytes: Uint8Array, littleEndian: boolean = false): bigint {
    if (bytes.length < 8) {
        bytes = setLength(bytes, 8, littleEndian);
    }
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return dataView.getBigUint64(0, littleEndian);
}

/**
 * @notice Convert a 32-bit integer to a Uint8Array.
 * @param {number} value The 32-bit integer to convert.
 * @param {boolean} littleEndian True for little-endian, undefined or false for big-endian.
 * @return {Uint8Array} A Uint8Array of length 4 containing the integer.
 */
export function int32ToBytes(value: number, littleEndian: boolean = false): Uint8Array {
    const buffer = new ArrayBuffer(4);
    const dataView = new DataView(buffer);
    dataView.setUint32(0, value, littleEndian);
    return new Uint8Array(buffer);
}

/**
 * @notice Convert a 64-bit bigint to a Uint8Array.
 * @param {bigint} value The 64-bit bigint to convert.
 * @param {boolean} littleEndian True for little-endian, undefined or false for big-endian.
 * @return {Uint8Array} A Uint8Array of length 8 containing the bigint.
 */
export function bigInt64ToBytes(value: bigint, littleEndian: boolean = false): Uint8Array {
    const buffer = new ArrayBuffer(8);
    const dataView = new DataView(buffer);
    dataView.setBigUint64(0, value, littleEndian);
    return new Uint8Array(buffer);
}

/**
 * Throws if a string is not hex prefixed
 * @param {string} input string to check hex prefix of
 */
export const assertIsHexString = function (input: string) {
    if (!isHexString(input)) {
        const msg = `This method only supports 0x-prefixed hex strings but input was: ${input}`;
        throw new Error(msg);
    }
};

/**
 * Throws if input is not a buffer
 * @param {Buffer} input value to check
 */
export const assertIsBytes = function (input: Uint8Array): void {
    if (!(input instanceof Uint8Array)) {
        const msg = `This method only supports Uint8Array but input was: ${input}`;
        throw new Error(msg);
    }
};

/**
 * Throws if input is not an array
 * @param {number[]} input value to check
 */
export const assertIsArray = function (input: number[]): void {
    if (!Array.isArray(input)) {
        const msg = `This method only supports number arrays but input was: ${input}`;
        throw new Error(msg);
    }
};

/**
 * Throws if input is not a string
 * @param {string} input value to check
 */
export const assertIsString = function (input: string): void {
    if (typeof input !== 'string') {
        const msg = `This method only supports strings but input was: ${input}`;
        throw new Error(msg);
    }
};

/**
 * Returns a `Boolean` on whether or not the a `String` starts with '0x'
 * @param str the string input value
 * @return a boolean if it is or is not hex prefixed
 * @throws if the str input is not a string
 */
export function isHexPrefixed(str: string): str is HexString {
    if (typeof str !== 'string') {
        throw new Error(`[isHexPrefixed] input must be type 'string', received type ${typeof str}`);
    }

    return str[0] === '0' && str[1] === 'x';
}

/**
 * Removes '0x' from a given `String` if present
 * @param str the string value
 * @returns the string without 0x prefix
 */
export const stripHexPrefix = (str: string): string => {
    if (typeof str !== 'string')
        throw new Error(`[stripHexPrefix] input must be type 'string', received ${typeof str}`);

    return isHexPrefixed(str) ? str.slice(2) : str;
};

/**
 * Pads a `String` to have an even length
 * @param value
 * @return output
 */
export function padToEven(value: string): string {
    let a = value;

    if (typeof a !== 'string') {
        throw new Error(`[padToEven] value must be type 'string', received ${typeof a}`);
    }

    if (a.length % 2) a = `0${a}`;

    return a;
}

/**
 * Get the binary size of a string
 * @param str
 * @returns the number of bytes contained within the string
 */
export function getBinarySize(str: string) {
    if (typeof str !== 'string') {
        throw new Error(`[getBinarySize] method requires input type 'string', received ${typeof str}`);
    }

    return utf8ToBytes(str).byteLength;
}

/**
 * Returns TRUE if the first specified array contains all elements
 * from the second one. FALSE otherwise.
 *
 * @param superset
 * @param subset
 *
 */
export function arrayContainsArray(superset: unknown[], subset: unknown[], some?: boolean): boolean {
    if (Array.isArray(superset) !== true) {
        throw new Error(
            `[arrayContainsArray] method requires input 'superset' to be an array, got type '${typeof superset}'`,
        );
    }
    if (Array.isArray(subset) !== true) {
        throw new Error(
            `[arrayContainsArray] method requires input 'subset' to be an array, got type '${typeof subset}'`,
        );
    }

    return subset[some === true ? 'some' : 'every'](value => superset.indexOf(value) >= 0);
}

/**
 * Should be called to get ascii from its hex representation
 *
 * @param string in hex
 * @returns ascii string representation of hex value
 */
export function toAscii(hex: string): string {
    let str = '';
    let i = 0;
    const l = hex.length;

    if (hex.substring(0, 2) === '0x') i = 2;

    for (; i < l; i += 2) {
        const code = parseInt(hex.substr(i, 2), 16);
        str += String.fromCharCode(code);
    }

    return str;
}

/**
 * Should be called to get hex representation (prefixed by 0x) of utf8 string.
 * Strips leading and trailing 0's.
 *
 * @param string
 * @param optional padding
 * @returns hex representation of input string
 */
export function fromUtf8(stringValue: string) {
    const str = utf8ToBytes(stringValue);

    return `0x${padToEven(_bytesToUnprefixedHex(str)).replace(/^0+|0+$/g, '')}`;
}

/**
 * Should be called to get hex representation (prefixed by 0x) of ascii string
 *
 * @param  string
 * @param  optional padding
 * @returns  hex representation of input string
 */
export function fromAscii(stringValue: string) {
    let hex = '';
    for (let i = 0; i < stringValue.length; i++) {
        const code = stringValue.charCodeAt(i);
        const n = code.toString(16);
        hex += n.length < 2 ? `0${n}` : n;
    }

    return `0x${hex}`;
}

/**
 * Returns the keys from an array of objects.
 * @example
 * ```js
 * getKeys([{a: '1', b: '2'}, {a: '3', b: '4'}], 'a') => ['1', '3']
 *````
 * @param  params
 * @param  key
 * @param  allowEmpty
 * @returns output just a simple array of output keys
 */
export function getKeys(params: Record<string, string>[], key: string, allowEmpty?: boolean) {
    if (!Array.isArray(params)) {
        throw new Error(`[getKeys] method expects input 'params' to be an array, got ${typeof params}`);
    }
    if (typeof key !== 'string') {
        throw new Error(`[getKeys] method expects input 'key' to be type 'string', got ${typeof params}`);
    }

    const result = [];

    for (let i = 0; i < params.length; i++) {
        let value = params[i][key];
        if (allowEmpty === true && !value) {
            value = '';
        } else if (typeof value !== 'string') {
            throw new Error(`invalid abi - expected type 'string', received ${typeof value}`);
        }
        result.push(value);
    }

    return result;
}

/**
 * Is the string a hex string.
 *
 * @param  value
 * @param  length
 * @returns  output the string is a hex string
 */
export function isHexString(value: string, length?: number): boolean {
    if (typeof value !== 'string' || !value.match(/^0x[0-9A-Fa-f]*$/)) return false;

    if (typeof length !== 'undefined' && length > 0 && value.length !== 2 + 2 * length) return false;

    return true;
}
