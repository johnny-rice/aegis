'use strict'

import CircuitBreaker from '../../domain/circuit-breaker'
import DataSource from '../../domain/datasource'

const HIGHWATERMARK = 50

const mongodb = require('mongodb')
const { MongoClient } = mongodb
const { Transform, Writable } = require('stream')
const qpm = require('query-params-mongo')
const processQuery = qpm()

const url = process.env.MONGODB_URL || 'mongodb://localhost:27017'
const configRoot = require('../../config').hostConfig
const dsOptions = configRoot.adapters.datasources.DataSourceMongoDb.options || {
  runOffline: true,
  numConns: 2
}
const cacheSize = configRoot.adapters.cacheSize || 3000

/**
 * @type {Map<string,MongoClient>}
 */
const connections = []

const mongoOpts = {
  //useNewUrlParser: true,
  //useUnifiedTopology: true
}

/**
 * MongoDB adapter extends in-memory
 * The cache is always updated first, which allows the system to run
 * even when the database is offline.
 */
export class DataSourceMongoDb extends DataSource {
  constructor (map, name, namespace, options = {}) {
    super(map, name, namespace, options)
    this.cacheSize = cacheSize
    this.mongoOpts = mongoOpts
    this.runOffline = dsOptions.runOffline
    this.url = url
  }

  connect (client) {
    return async function () {
      let timeout = false
      const timerId = setTimeout(() => {
        timeout = true
      }, 500)
      await client.connect()
      clearTimeout(timerId)
      if (timeout) throw new Error('mongo conn timeout')
    }
  }

  async connection () {
    try {
      while (connections.length < (dsOptions.numConns || 1)) {
        const client = new MongoClient(this.url, this.mongoOpts)
        const thresholds = {
          default: {
            errorRate: 1,
            callVolume: 1,
            intervalMs: 10000,
            testDelay: 300000
            //fallbackFn: () => client.emit('connectionClosed')
          }
        }
        const breaker = CircuitBreaker(
          'mongodb.connect',
          this.connect(client),
          thresholds
        )
        await breaker.invoke()
        connections.push(client)
        client.on('connectionClosed', () =>
          connections.splice(connections.indexOf(client), 1)
        )
      }
      const client = connections.shift()
      connections.push(client)
      return client
    } catch (error) {
      console.error({ fn: this.connection.name, error })
    }
  }

  async collection () {
    try {
      return (await this.connection()).db(this.namespace).collection(this.name)
    } catch {}
  }

  async find (id) {
    try {
      return (await this.collection()).findOne({ _id: id })
    } catch (error) {
      console.error({ fn: this.findDb.name, error })
    }
  }

  /**
   * Save to the cache first, then the db.
   * Wait for both functions to complete.
   * Optionally keep running even if the
   * db is offline.
   *
   * @override
   * @param {*} id
   * @param {*} data
   */
  async save (id, data) {
    try {
      const col = await this.collection()
      col.replaceOne({ _id: id }, { ...data, _id: id }, { upsert: true })
    } catch (error) {
      // default is
      if (!this.runOffline) {
        throw new Error('db trans failed,', error)
      }
      // run while db is down - cache will be ahead
      console.error('db trans failed, sync it later', error)
    }
  }

  /**
   * Provides streaming upsert to db. Buffers and writes `highWaterMark`
   * number of records to db each time.
   *
   * @param {*} filter
   * @param {number} highWaterMark num of docs per batch write
   * @returns
   */
  createWriteStream (filter = {}, highWaterMark = HIGHWATERMARK) {
    try {
      let objects = []
      const ctx = this

      async function upsert () {
        const operations = objects.map(obj => {
          return {
            replaceOne: {
              filter: { ...filter, _id: obj.id },
              replacement: { ...obj, _id: obj.id },
              upsert: true
            }
          }
        })

        if (operations.length > 0) {
          try {
            const col = await ctx.collection()
            const result = await col.bulkWrite(operations)
            console.log(result.getRawResponse())
            objects = []
          } catch (error) {
            console.error({ fn: upsert.name, error })
          }
        }
      }

      const writable = new Writable({
        objectMode: true,

        async write (chunk, _encoding, next) {
          objects.push(chunk)
          // if true time to flush buffer and write to db
          if (objects.length >= highWaterMark) await upsert()
          next()
        },

        end (chunk, _, done) {
          objects.push(chunk)
          done()
        }
      })

      writable.on('finish', async () => await upsert())

      return writable
    } catch (error) {}
  }

  /**
   *
   * @param {Object} filter Supposed to be a valid Mongo Filter
   * @param {Object} options Options to sort limit aggregate etc...
   * @param {Object} options.sort a valid Mongo sort object
   * @param {Number} options.limit a valid Mongo limit
   * @param {Object} options.aggregate a valid Mongo aggregate object
   *
   * @returns
   */

  async mongoFind ({ filter, sort, limit, aggregate, skip } = {}) {
    console.log({ fn: this.mongoFind.name, filter })
    let cursor = (await this.collection()).find(filter)
    if (sort) cursor = cursor.sort(sort)
    if (aggregate) cursor = cursor.aggregate(aggregate)
    if (skip) cursor = cursor.skip(skip)
    if (limit) cursor = cursor.limit(limit)
    return cursor
  }

  /**
   * Pipes to writable and streams list. List can be filtered. Stream
   * is serialized by default. Stream can be modified by transform.
   *
   * @param  {{
   *  filter:*
   *  transform:Transform
   *  serialize:boolean
   * }} param0
   * @returns
   */

  processOptions (param) {
    const { options = {}, query = {} } = param
    return { ...options, ...processQuery(query) }
  }

  /**
   * Returns the set of objects satisfying the `filter` if specified;
   * otherwise returns all objects. If a `writable`stream is provided and `cached`
   * is false, the list is streamed. Otherwise the list is returned in
   * an array. A custom transform can be specified to modify the streamed
   * results. Using {@link createWriteStream} updates can be streamed back
   * to the db. With streams, we can support queries of very large tables,
   * with minimal memory overhead on the node server.
   *
   * @override
   * @param {{key1:string, keyN:string}} filter - e.g. http query
   * @param {{
   *  writable: WritableStream,
   *  cached: boolean,
   *  serialize: boolean,
   *  transform: Transform
   * }} params
   *    - details
   *    - `serialize` seriailize input to writable
   *    - `cached` list cache only
   *    - `transform` transform stream before writing
   *    - `writable` writable stream for output
   */
  async list (param = {}) {
    const { writable = null, transform = null, serialize = false } = param

    try {
      const options = this.processOptions(param)
      console.log({ options })

      if (writable) {
        return (await this.mongoFind(options)).stream()
      }

      return (await this.mongoFind(options)).toArray()
    } catch (error) {
      console.error({ fn: this.list.name, error })
    }
  }

  async count () {
    return {
      total: await this.countDb(),
      cached: this.getCacheSize(),
      bytes: this.getCacheSizeBytes()
    }
  }

  /**
   * @override
   * @returns
   */
  async countDb () {
    return (await this.collection()).countDocuments()
  }

  /**
   * Delete from db, then cache.
   * If db fails, keep it cached.
   *
   * @override
   * @param {*} id
   */
  async delete (id) {
    try {
      await (await this.collection()).deleteOne({ _id: id })
    } catch (error) {
      console.error(error)
    }
  }
}
