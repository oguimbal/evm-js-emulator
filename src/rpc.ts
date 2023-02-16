import fetch from 'node-fetch';
import { HexString, IRpc } from './interfaces';
import { UInt256 } from './uint256';
import { dumpU256, getNodejsLibs, parseBuffer, toUint } from './utils';

let id = 0;
export class RPC implements IRpc {

    private block: string | undefined;
    private cache = new Map<string, Uint8Array>();
    constructor(private url: string | null | undefined, private maxCache: number = 1000 * 3600 * 24, private cacheDir?: string) {
    }

    private async fetchBuffer(opName: string, method: string, params: string[], forceBlock?: string) {
        let atBlock = forceBlock ?? this.block;
        if (!atBlock) {
            const block = await this._fetchBuffer(`get current block`, 'eth_blockNumber', [], null);
            atBlock = this.block = '0x' + dumpU256(toUint(block));
        }
        return await this._fetchBuffer(opName, method, params, atBlock);
    }
    private async _fetchBuffer(opName: string, method: string, params: string[], block: string | null) {

        const cacheKey = `${method}-${params.join(',')}`;
        let cached = this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        let onCache: ((str: any) => void) | null = null;
        if (this.maxCache) {
            const { readCache, writeCache, expireDir } = getNodejsLibs(this.cacheDir);
            if (readCache) {
                const cacheFile = `rpc/${cacheKey}`;
                expireDir('rpc', this.maxCache);
                const cachedRaw = readCache(cacheFile);
                if (cachedRaw) {
                    this.cache.set(cacheKey, cached = parseBuffer(cachedRaw.substring(2)));
                    return cached;
                }
                onCache = str => writeCache(cacheFile, str);
            }
        }

        if (!this.url) {
            throw new Error('Cannot access real blockchain: You must specify a RPC URL');
        }
        const body =JSON.stringify({
            "jsonrpc": "2.0",
            "method": method,
            "params": block ? [...params, block] : params,
            "id": ++id,
        });
        const result = await fetch(this.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
        });

        const response: any = await result.json();

        if (!result.ok) {
            throw new Error(`Cannot ${opName}  (${result.statusText})`);
        }

        if (typeof response?.result !== 'string' || !response.result.startsWith('0x')) {
            throw new Error(`Cannot ${opName}: Unknown response format`);
        }

        onCache?.(response.result);
        cached = parseBuffer(response.result);
        this.cache.set(cacheKey, cached);
        return cached;
    }
    
    async getChainId(): Promise<Uint8Array> {
        return await this.fetchBuffer(`get the chain ID`, 'eth_chainId', []);
    }

    async getBlock(): Promise<Uint8Array> {
        return await this.fetchBuffer(`get current block`, 'eth_blockNumber', []);
    }

    async getCode(contract: HexString): Promise<Uint8Array> {
        return await this.fetchBuffer(`get contract ${contract}`, 'eth_getCode', [contract]);
    }

    async getStorageAt(address: HexString, key: HexString): Promise<UInt256> {
        const buffer = await this.fetchBuffer(`get storage at ${key}`, 'eth_getStorageAt', [address, key]);
        return toUint(buffer);
    }

    async getBalance(key: HexString): Promise<UInt256> {
        const buffer = await this.fetchBuffer(`get balance of ${key}`, 'eth_getBalance', [key]);
        return toUint(buffer);
    }
}
