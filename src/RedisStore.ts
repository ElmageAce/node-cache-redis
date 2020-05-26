import Debug from 'debug'
// @ts-ignore
import isJSON from 'is-json'
import { Options as PoolOptions } from 'generic-pool'
import { ClientOpts as RedisOptions } from 'redis'
import RedisPool from './RedisConnectionPool'

import { createLogger, genRandomStr, validatedTtl, Logger } from './helpers'

const debug = Debug('nodeRedisStore')

/**
 * RedisStore
 */
class RedisStore extends RedisPool {
  defaulTtlInS: number | undefined
  deleteScriptPromise: Promise<any> | null = null

  /**
   * @constructor
   * @param {object}   options
   * @param {string}   options.name         - Name your store
   * @param {object}   options.redisOptions - opts from [node_redis#options-object-properties]{@link https://github.com/NodeRedis/node_redis#options-object-properties}
   * @param {object}   options.poolOptions  - opts from [node-pool#createpool]{@link https://github.com/coopernurse/node-pool#createpool}
   * @param {object}   options.logger       - Inject your custom logger
   * @param {integer}  options.defaulTtlInS - Number of seconds to store by default
   */
  constructor({
    name,
    redisOptions,
    poolOptions,
    logger,
    defaulTtlInS
  }: {
    name?: string
    redisOptions: RedisOptions
    poolOptions?: PoolOptions
    logger?: Logger
    defaulTtlInS?: number
  }) {
    super({
      name: name || `redisStore-${genRandomStr()}`,
      redisOptions,
      poolOptions,
      logger: createLogger(logger)
    })
    this.defaulTtlInS = validatedTtl(defaulTtlInS)
  }

  /**
   * Return the defaulTtlInS
   * @returns {number?} defaulTtlInS
   */
  getDefaultTtlInS(): number | undefined {
    return this.defaulTtlInS
  }

  /**
   * Sets the defaulTtlInS
   * @param {number} ttl
   * @returns {number} ttl
   */
  setDefaultTtlInS(ttl: number): number | undefined {
    this.defaulTtlInS = validatedTtl(ttl)
    return this.defaulTtlInS
  }

  /**
   * Unsets the defaulTtlInS
   * @param {number} ttl
   * @returns {number} ttl
   */
  unsetDefaultTtlInS(): boolean {
    this.defaulTtlInS = undefined
    return true
  }

  /**
   * Returns 'PONG'
   *
   * @param {string} str - string passed
   * @returns {string} 'PONG'/string passed
   */
  ping(str?: string): Promise<string> {
    return super.sendCommand('ping', str ? [str] : [])
  }

  /**
   * Returns value or null when the key is missing - See [redis get]{@link https://redis.io/commands/get}
   * @async
   * @param {string} key - key for the value stored
   * @returns {Promise<any>} value or null when the key is missing
   */
  async get(key: string): Promise<any> {
    let result = await super.sendCommand('get', [key])

    try {
      result = JSON.parse(result)
    } catch (e) {
      // do nothing
    }
    return result
  }

  /**
   * Returns 'OK' if successful
   *
   * @param {string} key - key for the value stored
   * @param {any}  value - value to stored
   * @param {number} ttlInSeconds - time to live in seconds
   * @returns {Promise<string>} 'OK' if successful
   */
  set(key: string, value: any, ttlInSeconds?: number): Promise<any> {
    const str =
      Array.isArray(value) || isJSON(value, true)
        ? JSON.stringify(value)
        : value

    const ttl = validatedTtl(ttlInSeconds, this.defaulTtlInS)
    if (ttl) {
      return super.sendCommand('setex', [key, ttl, str])
    }
    return super.sendCommand('set', [key, str])
  }

  /**
   * Returns 'OK' if successful
   * @async
   * @param {string} key          - key for the value stored
   * @param {any}    value        - value to stored
   * @param {number} ttlInSeconds - time to live in seconds
   * @returns {Promise<any>}
   */
  async getset(
    key: string,
    value: any,
    ttlInSeconds: number | undefined
  ): Promise<any> {
    const str =
      Array.isArray(value) || isJSON(value, true)
        ? JSON.stringify(value)
        : value
    const ttl = validatedTtl(ttlInSeconds, this.defaulTtlInS)

    let result = await super.sendCommand('getset', [key, str])
    try {
      result = JSON.parse(result)
    } catch (e) {
      // do nothing
    }

    if (ttl) {
      await super.sendCommand('expire', [key, ttl])
    }
    return result
  }

  /**
   * Returns the number of keys that were removed - See [redis del]{@link https://redis.io/commands/del}
   *
   * @param {string[]} keys - list of keys to delete
   * @returns {Promise<number>} The number of keys that were removed.
   */
  del(keys: string[] = []): Promise<number> {
    return super.sendCommand('del', keys)
  }

  /**
   * Returns 1 if the timeout was set/ 0 if key does not exist or the timeout could not be set - See [redis expire]{@link https://redis.io/commands/expire}
   *
   * @param   {string}  key          - key to set expire
   * @param   {number}  ttlInSeconds - time to live in seconds
   * @returns {Promise<number>} 1 if the timeout was set successfully; if not 0
   */
  expire(key: string, ttlInSeconds: number): Promise<number> {
    const ttl = validatedTtl(ttlInSeconds)
    return super.sendCommand('expire', [key, ttl])
  }

  /**
   * Returns TTL in seconds, or a negative value in order to signal an error - See [redis ttl]{@link https://redis.io/commands/ttl}
   *
   * @param {string} key - list of keys to delete
   * @returns {Promise<number>} TTL in seconds, or a negative value in order to signal an error
   */
  getTtl(key: string): Promise<number> {
    return super.sendCommand('ttl', [key])
  }

  /**
   * Returns all keys matching pattern - See [redis keys]{@link https://redis.io/commands/keys}
   *
   * @param {string} pattern - glob-style patterns/default '*'
   * @returns {Promise<string[]>} all keys matching pattern
   */
  keys(pattern: string = '*'): Promise<string[]> {
    return super.sendCommand('keys', [pattern])
  }

  /**
   * Deletes all keys matching pattern
   *
   * @param {string} pattern - glob-style patterns/default '*'
   * @returns {Promise<number>} The number of keys that were removed.
   */
  deleteAll(pattern: string = '*'): Promise<number> {
    debug('clearing redis keys: ', pattern)
    return this._executeDeleteAll(pattern)
  }

  /**
   * Preloads delete all scripts into redis script cache (this script requires redis >=  4.0.0)
   * @returns {Promise<string>} sha1 hash of preloaded function
   * @private
   */
  _loadDeleteAllScript(): Promise<any> | null {
    if (!this.deleteScriptPromise) {
      const deleteKeysScript = `
    local keys = {};
    local done = false;
    local cursor = "0";
    local deleted = 0;
    redis.replicate_commands();
    repeat
        local result = redis.call("SCAN", cursor, "match", ARGV[1], "count", ARGV[2])
        cursor = result[1];
        keys = result[2];
        for i, key in ipairs(keys) do
            deleted = deleted + redis.call("UNLINK", key);
        end
        if cursor == "0" then
            done = true;
        end
    until done
    return deleted;`
      this.deleteScriptPromise = super.sendCommand('SCRIPT', [
        'LOAD',
        deleteKeysScript
      ])
    }
    return this.deleteScriptPromise
  }

  /**
   * Preloads and execute delete all script
   * @async
   * @param {string} pattern - glob-style patterns/default '*'
   * @returns {Promise<number>} The number of keys that were removed.
   * @private
   */
  async _executeDeleteAll(pattern: string): Promise<number> {
    let sha1
    try {
      sha1 = await this._loadDeleteAllScript()
    } catch (error) {
      if (error.code === 'NOSCRIPT') {
        // We can get here only if server is restarted somehow and cache is deleted
        this.deleteScriptPromise = null
        return this._executeDeleteAll(pattern)
      }
      throw error
    }
    return super.sendCommand('EVALSHA', [sha1, 0, pattern, 1000])
  }
}

export default RedisStore