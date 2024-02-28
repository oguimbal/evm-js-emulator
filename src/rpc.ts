import fetch from 'node-fetch';
import { HexString, IRpc } from './interfaces';
import { U256, UInt256 } from './uint256';
import { dumpU256, getNodejsLibs, parseBuffer, to32ByteBuffer, toUint } from './utils';

let id = 0;
export class RPC implements IRpc {
    private block: string | undefined;
    private cache = new Map<string, any>();
    constructor(
        private url: string | null | undefined,
        private maxCache: number = 1000 * 3600 * 24,
        block: string | number | undefined,
        private cacheDir: string | undefined,
    ) {
        if (block) {
            this.block = typeof block === 'string' ? block : '0x' + block.toString(16);
        }
    }

    private async atBlock(forceBlock?: string) {
        let atBlock = forceBlock ?? this.block;
        if (!atBlock) {
            const block = await this._fetchAny(true, `get current block`, 'eth_blockNumber', [], null);
            atBlock = this.block = '0x' + dumpU256(toUint(block));
        }
        return atBlock;
    }
    private async fetchBuffer(opName: string, method: string, params: any[], forceBlock?: string): Promise<Uint8Array> {
        const atBlock = await this.atBlock(forceBlock);
        return await this._fetchAny(true, opName, method, params, atBlock);
    }

    private async fetchJson(opName: string, method: string, params: any[], forceBlock?: string): Promise<any> {
        const atBlock = await this.atBlock(forceBlock);
        return await this._fetchAny(false, opName, method, params, atBlock);
    }

    private async _fetchAny(buffer: boolean, opName: string, method: string, params: string[], block: string | null) {
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
                    cached = buffer ? parseBuffer(cachedRaw.substring(2)) : JSON.parse(cachedRaw);
                    this.cache.set(cacheKey, cached);
                    return cached;
                }
                onCache = val => writeCache(cacheFile, buffer ? val : JSON.stringify(val));
            }
        }

        if (!this.url) {
            throw new Error('Cannot access real blockchain: You must specify a RPC URL');
        }

        let bodyParams;

        switch (method) {
            // This methods don't accept any parameters
            case 'eth_blockNumber':
            case 'eth_chainId':
            case 'eth_getBlockByNumber':
                bodyParams = params;
                break;
            default:
                bodyParams = block ? [...params, block] : params;
                break;
        }

        const body = JSON.stringify({
            jsonrpc: '2.0',
            method: method,
            params: bodyParams,
            id: ++id,
        });

        const result = await fetch(this.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        });

        const response: any = await result.json();

        if (!result.ok) {
            throw new Error(`Cannot ${opName}  (${result.statusText})`);
        }

        if (buffer) {
            if (typeof response?.result !== 'string' || !response.result.startsWith('0x')) {
                throw new Error(`Cannot ${opName}: Unknown response format: ${response.error}`);
            }
        }

        onCache?.(response.result);
        cached = buffer ? parseBuffer(response.result) : response.result;
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

    async getTimestamp(): Promise<number> {
        const block = await this.atBlock();
        const json = await this.fetchJson(`get timestamp`, 'eth_getBlockByNumber', [block, false]);
        debugger;
        return json.timestamp;
    }
}
