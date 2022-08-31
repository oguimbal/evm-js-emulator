import fetch from 'node-fetch';
import { HexString, IRpc } from './interfaces';
import { UInt256 } from './uint256';
import { dumpU256, parseBuffer, toUint } from './utils';

export class RPC implements IRpc {

    private block: string | undefined;
    private cache = new Map<string, Uint8Array>();
    constructor(private url: string | null | undefined) {
    }

    private async fetchBuffer(opName: string, method: string, ...params: any[]) {
        if (!this.block) {
            const block = await this._fetchBuffer(`get current block`, 'eth_blockNumber', [], 'latest');
            this.block = '0x' + dumpU256(toUint(block));
        }
        return await this._fetchBuffer(opName, method, params, this.block);
    }
    private async _fetchBuffer(opName: string, method: string, params: string[], block: string) {
        const cacheKey = `${method}-${params.join(',')}`;
        let cached = this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }
        if (!this.url) {
            throw new Error('Cannot access real blockchain: You must specify a RPC URL');
        }
        const result = await fetch(this.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                "jsonrpc": "2.0",
                "method": method,
                "params": [...params, block],
                "id": 1,
            })
        });

        const response: any = await result.json();

        if (!result.ok) {
            throw new Error(`Cannot ${opName}  (${result.statusText})`);
        }

        if (typeof response?.result !== 'string' || !response.result.startsWith('0x')) {
            throw new Error(`Cannot ${opName}: Unknown response format`);
        }

        cached = parseBuffer(response.result.substring(2));
        this.cache.set(cacheKey, cached);
        return cached;
    }

    async getBlock(): Promise<Uint8Array> {
        return await this.fetchBuffer(`get current block`, 'eth_blockNumber');
    }

    async getCode(contract: HexString): Promise<Uint8Array> {
        return await this.fetchBuffer(`get contract ${contract}`, 'eth_getCode', contract);
    }

    async getStorageAt(address: HexString, key: HexString): Promise<UInt256> {
        const buffer = await this.fetchBuffer(`get storage at ${key}`, 'eth_getStorageAt', address, key);
        return toUint(buffer);
    }

    async getBalance(key: HexString): Promise<UInt256> {
        const buffer = await this.fetchBuffer(`get balance of ${key}`, 'eth_getBalance', key);
        return toUint(buffer);
    }
}
