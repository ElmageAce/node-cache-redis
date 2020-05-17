const debug = require('debug')('nodeRedisConnectionPool');
const util = require('util');
const genericPool = require('generic-pool');
const retry = require('retry-as-promised');
const redis = require('redis');

const createLogger = require('./createLogger')

const create = function (redisOptions) {
  return new Promise((resolve, reject) => {
    debug('Start redis createClient', redisOptions);
    const client = redis.createClient(redisOptions);

    client.on('error', (err) => {
      debug('Failed redis createClient', err);
      reject(err);
    });
    client.on('connect', () => {
      debug('Succeeded redis createClient', redisOptions);
      resolve(client);
    });
  });
};

const selectDB = function (client, db) {
  return new Promise((resolve, reject) => {
    client.select(db, (err) => {
      if (err) reject(err);
      debug('DB selected: ', db);
      resolve(client);
    });
  });
};

/**
 * @constructor
 * @param    {object}   options
 * @param    {string}   options.name         - Name your pool
 * @param    {object}   options.redisOptions - opts from [node_redis#options-object-properties]{@link https://github.com/NodeRedis/node_redis#options-object-properties}
 * @param    {object}   options.poolOptions  - opts from [node-pool#createpool]{@link https://github.com/coopernurse/node-pool#createpool}
 * @param    {object}   options.logger       - Inject your custom logger
 */
const RedisPool = module.exports = function ({
  name,
  redisOptions,
  poolOptions,
  logger,
} = {}) {
  this.name = name || `redisPool-${Math.random().toString(36).substr(2, 10)}`;
  this.redisOptions = redisOptions;
  this.poolOptions = poolOptions || {};
  this.logger = createLogger(logger);

  const factory = {
    create: () => {
      // for retry
      let createAttempts = 0;

      // this is due to the limitation of node-pool ATM
      // https://github.com/coopernurse/node-pool/issues/161#issuecomment-261109882
      return retry(() => {
        createAttempts += 1;
        if (createAttempts > 3) {
          const err = new Error(`Failed redis createClient, ${JSON.stringify(redisOptions || {})}`);
          err.name = 'CONN_FAILED';
          debug('Max conn createAttempts reached: %s, resolving to error:', createAttempts, err);

          // reset for next try
          createAttempts = 0;
          return Promise.resolve(err);
        }

        return create(redisOptions);
      }, {
        max: 10,
        name: 'factory.create',
        report: debug,
      });
    },
    destroy: (client) => new Promise((resolve) => {
      try {
        // Flush when closing.
        client.end(true, () => resolve());
        debug('Client conn closed. Available count : %s. Pool size: %s', this.availableCount(), this.getPoolSize());
        this.logger.log('Client conn closed. Available count : %s. Pool size: %s', this.availableCount(), this.getPoolSize());
      } catch (err) {
        debug('Failed to destroy connection', err);
        this.logger.error('Failed to destroy connection', err);

        // throw error cause infinite event loop; limitation of node-pool
        // throw err;
      }
    }),
  };

  // Now that the pool settings are ready create a pool instance.
  debug('Creating pool', this.poolOptions);
  this.pool = genericPool.createPool(factory, this.poolOptions);

  this.pool.on('factoryCreateError', (e) => {
    debug('Errored while connecting Redis', e);
    this.logger.error('Errored while connecting Redis', e);
  });
  this.pool.on('factoryDestroyError', (e) => {
    debug('Errored while destroying Redis conn', e);
    this.logger.error('Errored while destroying Redis conn', e);
  });
};

/**
 * Send redis instructions
 *
 * @param {string} commandName - Name of the command
 * @param {array}  commandArgs - Args sent to the command
 * @returns {promise} Promise resolve with the result or Error
 */
RedisPool.prototype.sendCommand = async function (commandName, commandArgs = []) {
  const args = [].concat(commandArgs);
  debug('Executing send_command', commandName, args);

  const conn = await this.pool.acquire(this.poolOptions.priorityRange || 1, this.redisOptions.db)

  const sendCommand = util.promisify(conn.send_command).bind(conn);
  let result
  try {
    result = await sendCommand(commandName, args.length > 0 ? args : null)
    this.pool.release(conn);
  } catch (error) {
    this.pool.release(conn);
    this.logger.error('Errored send_command', error);
    debug('Errored send_command', error);
    throw error;
  }

  return result;
};

/**
 * Acquire a Redis connection and use an optional priority.
 *
 * @param {number} priority - priority list number
 * @param {number} db - Use the db with range {0-16}
 * @returns {promise} Promise resolve with the connection or Error
 */
RedisPool.prototype.acquire = async function (priority, db) {
  const client = await this.pool.acquire(priority)
  if (client instanceof Error) {
    debug("Couldn't acquire connection to %j", this.redisOptions);
    this.logger.error("Couldn't acquire connection to %j", this.redisOptions);
    throw client;
  }

  if (db) {
    this.logger.info('select DB:', db);
    return selectDB(client, db);
  }
  return client;

};

/**
 * Release a Redis connection to the pool.
 *
 * @param {object} client - Redis connection
 * @returns {promise} Promise
 */
RedisPool.prototype.release = function (client) {
  return this.pool.release(client);
};

/**
 * Destroy a Redis connection.
 *
 * @param {object} client - Redis connection
 * @returns {promise} Promise
 */
RedisPool.prototype.destroy = function (client) {
  return this.pool.destroy(client);
};

/**
 * Drains the connection pool and call the callback id provided.
 *
 * @returns {promise} Promise
 */
RedisPool.prototype.drain = async function () {
  await this.pool.drain()
  this.pool.clear()
};

/**
 * Returns factory.name for this pool
 *
 * @returns {string} Name of the pool
 */
RedisPool.prototype.getName = function () {
  return this.name;
};

/**
 * Returns this.redisOptions for this pool
 *
 * @returns {object} redis options given
 */
RedisPool.prototype.getRedisOptions = function () {
  return this.redisOptions;
};

/**
 * Returns this.poolOptions for this pool
 *
 * @returns {object} pool options given
 */
RedisPool.prototype.getPoolOptions = function () {
  return this.poolOptions;
};

/**
 * Returns size of the pool
 *
 * @returns {number} size of the pool
 */
RedisPool.prototype.getPoolSize = function () {
  return this.pool.size;
};

/**
 * Returns available connections count of the pool
 *
 * @returns {number} available connections count of the pool
 */
RedisPool.prototype.availableCount = function () {
  return this.pool.available;
};

/**
 * Returns pending connections count of the pool
 *
 * @returns {number} pending connections count of the pool
 */
RedisPool.prototype.pendingCount = function () {
  return this.pool.pending;
};

/**
 * Returns pool status and stats
 *
 * @returns {object} pool status and stats
 */
RedisPool.prototype.status = function () {
  return {
    name: this.name,
    size: this.pool.size,
    available: this.pool.available,
    pending: this.pool.pending,
  };
};
