import fetch from 'node-fetch';
import { HexString, IRpc, OnRpcFetch } from './interfaces';
import { dumpU256, getNodejsLibs, parallel, parseBuffer, to0xAddress, toUint } from './utils';

let id = 0;
export class RPC implements IRpc {
    private block: string | undefined;
    private cache = new Map<string, any>();
    private storageGets = new Map<HexString, StorageToSeal>();
    private handlers: OnRpcFetch[] = [];
    constructor(
        private url: string | null | undefined,
        block: string | number | undefined,
        private cacheDir: string | undefined,
    ) {
        if (block) {
            this.block = typeof block === 'string' ? block : '0x' + block.toString(16);
        }
        // this.onFetch((op, method, params) => {
        //     console.log('RPC ' + op);
        // });
    }

    onFetch(h: OnRpcFetch): void {
        this.handlers.push(h);
    }

    private async atBlock(forceBlock?: string) {
        let atBlock = forceBlock ?? this.block;
        if (!atBlock) {
            const block = await this._fetchCached(true, `get current block`, 'eth_blockNumber', [], null);
            atBlock = this.block = '0x' + dumpU256(toUint(block));
        }
        return atBlock;
    }
    private async fetchBuffer(opName: string, method: string, params: any[], forceBlock?: string): Promise<Uint8Array> {
        const atBlock = await this.atBlock(forceBlock);
        return await this._fetchCached(true, opName, method, params, atBlock);
    }

    private async fetchJson(opName: string, method: string, params: any[], forceBlock?: string): Promise<any> {
        const atBlock = await this.atBlock(forceBlock);
        return await this._fetchCached(false, opName, method, params, atBlock);
    }

    // generic caching logic
    private async _fetchCached(
        buffer: boolean,
        opName: string,
        method: string,
        params: string[],
        block: string | null,
    ) {
        const cacheKey = `${method}-${params.join(',')}`;
        let cached = this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        let onCache: ((str: any) => Promise<any>) | null = null;
        const { readCache, writeCache } = getNodejsLibs(this.cacheDir);
        if (readCache) {
            const cacheFile = `rpc/${cacheKey}`;
            const cachedRaw = await readCache(cacheFile);
            if (cachedRaw) {
                cached = buffer ? parseBuffer(cachedRaw.substring(2)) : JSON.parse(cachedRaw);
                this.cache.set(cacheKey, cached);
                return cached;
            }
            onCache = val => writeCache(cacheFile, buffer ? val : JSON.stringify(val));
        }

        const { value, response } = await this._fetchNonCached(buffer, opName, method, params, block);

        await onCache?.(response.result);
        this.cache.set(cacheKey, value);
        return value;
    }

    private async _fetchNonCached(
        buffer: boolean,
        opName: string,
        method: string,
        params: string[],
        block: string | null,
        callHandlers = true,
    ) {
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

        if (callHandlers) {
            for (const h of this.handlers) {
                h(opName, method, params);
            }
        }

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
        const value = buffer ? parseBuffer(response.result) : response.result;
        return { value, response };
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

    async getBalance(key: HexString): Promise<bigint> {
        const buffer = await this.fetchBuffer(`get balance of ${key}`, 'eth_getBalance', [key]);
        return toUint(buffer);
    }

    async getTimestamp(): Promise<number> {
        const block = await this.atBlock();
        const json = await this.fetchJson(`get timestamp`, 'eth_getBlockByNumber', [block, false]);
        if (typeof json?.timestamp !== 'string' || !json.timestamp.startsWith('0x')) {
            throw new Error(`Cannot get timestamp: Unknown response format: ${JSON.stringify(json)}`);
        }
        return parseInt(json.timestamp, 16);
    }

    // ------------------------------------------------------------------------------------------
    // ------------------ specific caching logic for storage slots, given that it is called a lot
    // ------------------------------------------------------------------------------------------
    async getStorageAt(address: HexString, key: bigint): Promise<bigint> {
        // try hit memory cache
        let gets = this.storageGets.get(address);

        if (!gets) {
            // download all past gets if needed
            // use case: when clearing the "rpc-slots" dir, but not the "rpc-slots-stats" dir,
            //  we will download all slots that were used last time (with a newer version)
            //   in parallel => that might avoid a lot of download time
            gets = await this.initializeFromLastExecution(address, key);
            this.storageGets.set(address, gets);
        }

        if (gets.stats) {
            gets.stats[key.toString()] = Date.now();
        }

        return await this._getStorageAt(address, key, null);
    }

    private async initializeFromLastExecution(address: HexString, ensureHaskey: bigint): Promise<StorageToSeal> {
        const { readCache } = getNodejsLibs(this.cacheDir);
        if (!readCache) {
            return {
                stats: null,
                file: null,
            };
        }

        const file = `rpc-slots-stats/${address}.json`;
        const statsRaw = await readCache(file);
        if (!statsRaw) {
            // new contract !
            return {
                stats: {},
                file,
            };
        }

        // get last slots that were requested
        const stats = JSON.parse(statsRaw) as StorageStats;
        const keys = new Set(Object.keys(stats).map(k => BigInt(k)));
        keys.add(ensureHaskey);

        // call handlers
        let notified = false;
        const handleNonCached = () => {
            if (notified) {
                return;
            }
            notified = true;
            for (const h of this.handlers) {
                h(`prefetch storages of ${address} (${keys.size} keys)`, 'eth_getStorageAt', []);
            }
        };

        // 20 parallel fetches
        await parallel(20, keys, async key => {
            await this._getStorageAt(address, key, handleNonCached);
        });

        return {
            stats,
            file,
        };
    }

    async sealExecution() {
        const { writeCache } = getNodejsLibs(this.cacheDir);
        if (!writeCache) {
            return;
        }
        const now = Date.now();
        for (const { stats, file } of this.storageGets.values()) {
            if (!stats) {
                continue;
            }
            const toWrite = Object.fromEntries(
                Object.entries(stats)
                    // filter old slots (not fetched in the last day)
                    .filter(([, last]) => now - last < 24 * 3600 * 1000),
            );
            await writeCache(file, JSON.stringify(toWrite));
        }
    }

    private storageCacheKey(address: HexString, key: bigint): string {
        return `rpc-slots/${address}/${key}`;
    }

    async _getStorageAt(address: HexString, key: bigint, handleNonCached: (() => void) | null): Promise<bigint> {
        let onCache: ((str: any) => Promise<any>) | null = null;
        const { readCache, writeCache } = getNodejsLibs(this.cacheDir);
        if (readCache) {
            const cacheFile = this.storageCacheKey(address, key);
            const cachedRaw = await readCache(cacheFile);
            if (cachedRaw) {
                return toUint(cachedRaw);
            }
            onCache = val => writeCache(cacheFile, val);
        }

        handleNonCached?.();

        const atBlock = await this.atBlock();
        const { value, response } = await this._fetchNonCached(
            true,
            `get storage of ${address} at ${key}`,
            'eth_getStorageAt',
            [address, '0x' + dumpU256(key)],
            atBlock,
            !handleNonCached,
        );

        await onCache?.(response.result);
        return toUint(value);
    }
}

type StorageToSeal =
    | {
          stats: null;
          file: null;
      }
    | {
          stats: StorageStats;
          file: string;
      };
interface StorageStats {
    // key: slot
    // number: last get
    [key: string]: number;
}
