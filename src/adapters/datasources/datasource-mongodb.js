'use strict'

import { Chunk } from 'webpack'

const MongoClient = require('mongodb').MongoClient
const DataSourceMemory = require('./datasource-memory').DataSourceMemory
const { Transform, Writable, Readable } = require('stream')

const url = process.env.MONGODB_URL || 'mongodb://localhost:27017'
const configRoot = require('../../config').hostConfig
const dsOptions = configRoot.adapters.datasources.DataSourceMongoDb.options || {
  runOffline: true
}
const cacheSize = configRoot.adapters.cacheSize || 3000

/**
 * @type {Map<string,MongoClient>}
 */
const connections = new Map()

const mongoOpts = {
  //useNewUrlParserd: true,
  useUnifiedTopology: true
}

/**
 * MongoDB adapter extends in-memory datasource to support caching.
 * The cache is always updated first, which allows the system to run
 * even when the database is offline.
 */
export class DataSourceMongoDb extends DataSourceMemory {
  constructor (map, factory, name) {
    super(map, factory, name)
    this.cacheSize = cacheSize
    this.mongoOpts = mongoOpts
    // keep running even if db is down
    this.runOffline = dsOptions.runOffline
    this.url = url
    this.className = this.constructor.name
    //console.log(this)
  }

  async connection () {
    try {
      if (!connections.has(this.url)) {
        const client = new MongoClient(this.url, this.mongoOpts)
        await client.connect()
        connections.set(this.url, client)
        client.on('connectionReady', () => console.log('mongo conn ready'))
        client.on('connectionClosed', () => connections.delete(this.url))
      }
      return connections.get(this.url)
    } catch (error) {
      console.error({ fn: this.connection.name, error })
    }
  }

  async collection () {
    try {
      return (await this.connection()).db(this.name).collection(this.name)
    } catch (error) {
      console.error({ fn: this.collection.name, error })
    }
  }

  /**
   * @override
   * @param {{
   *  hydrate:function(Map<string,import("../../domain").Model>),
   *  serializer:import("../../lib/serializer").Serializer
   * }} options
   */
  load ({ hydrate, serializer }) {
    try {
      this.hydrate = hydrate
      this.serializer = serializer
      this.loadModels()
    } catch (error) {
      console.error(error)
    }
  }

  async loadModels () {
    try {
      const cursor = (await this.collection()).find().limit(this.cacheSize)
      cursor.forEach(model => super.save(model.id, model))
    } catch (error) {
      console.error({ fn: this.loadModels.name, error })
    }
  }

  async findDb (id) {
    try {
      const model = await (await this.collection()).findOne({ _id: id })
      // save it to the cache
      return super.saveSync(id, model) || model // saveSync fails on fresh start
    } catch (error) {
      console.error({ fn: this.findDb.name, error })
    }
  }

  /**
   * Check the cache first.
   * @overrid
   * @param {*} id - `Model.id`
   */
  async find (id) {
    try {
      const cached = super.findSync(id)
      if (
        cached === null ||
        cached === undefined ||
        Object.keys(cached).length == 0
      )
        // cached can be empty object
        return this.findDb(id)

      return cached
    } catch (error) {
      console.error({ fn: this.find.name, error })
    }
  }

  serialize (data) {
    if (this.serializer) {
      return JSON.stringify(data, this.serializer.serialize)
    }
    return JSON.stringify(data)
  }

  async saveDb (id, data) {
    try {
      const clone = JSON.parse(this.serialize(data))
      await (await this.collection()).replaceOne(
        { _id: id },
        { ...clone, _id: id },
        { upsert: true }
      )
      return clone
    } catch (error) {
      console.error({ fn: this.saveDb.name, error })
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
      const cache = super.saveSync(id, data)
      try {
        await this.saveDb(id, data)
      } catch (error) {
        // default is true
        if (!this.runOffline) {
          this.deleteSync(id)
          // after delete mem and db are sync'd
          console.error('db trans failed, rolled back')
          return
        }
        // run while db is down - cache will be ahead
        console.error('db trans failed, sync it later')
      }
      return cache
    } catch (e) {
      console.error(e)
    }
  }

  createWriteStream (filter, highWaterMark = 24) {
    let objects = []
    const ctx = this

    async function upsert () {
      //console.debug(objects)
      const operations = objects.map(str => {
        const obj = JSON.parse(str)
        console.debug(obj)
        return {
          replaceOne: {
            filter: { ...filter, _id: obj.id },
            replacement: obj,
            upsert: true
          }
        }
      })
      const col = await ctx.collection()
      const result = await col.bulkWrite(operations)
      console.log(result.getRawResponse())
      objects = []
    }

    return new Writable({
      objectMode: true,
      write: async (chunk, _encoding, next) => {
        objects.push(chunk)
        if (objects.length >= highWaterMark) await upsert()
        next()
      }
    })
  }

  streamList ({ filter, writable, serialize = true, transform }) {
    let first = true
    const serializer = new Transform({
      writableObjectMode: true,

      // start of array
      construct (callback) {
        this.push('[')
        callback()
      },

      // each chunk is a record
      transform (chunk, encoding, callback) {
        // comma-separate
        if (first) first = false
        else this.push(',')

        // serialize record
        this.push(JSON.stringify(chunk))
        callback()
      },

      // end of array
      flush (callback) {
        this.push(']')
        callback()
      }
    })

    return new Promise(async (resolve, reject) => {
      const readable = (await this.collection()).find(filter).stream()

      readable.on('error', reject)
      readable.on('end', resolve)

      // optionally transform db stream then pipe to output
      if (serialize && transform)
        readable
          .pipe(transform)
          .pipe(serializer)
          .pipe(writable)
      else if (serialize) readable.pipe(serializer).pipe(writable)
      else if (transform) readable.pipe(transform).pipe(writable)
      else readable.pipe(writable)
    })
  }

  /**
   * Returns the set of objects satisfying the `filter` if specified;
   * otherwise returns all objects. If `writable` is provided and cached
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
   * }} options
   *    - details
   *    - `serialize` seriailize input to writable
   *    - `cached` list cache only
   *    - `transform` transform stream before writing
   *    - `writable` writable stream for output
   */
  async list (
    filter = {},
    { writable = null, cached = false, serialize = true, transform = null } = {}
  ) {
    try {
      if (cached) return super.listSync(filter)

      if (writable)
        return this.streamList({ writable, filter, serialize, transform })

      return await (await this.collection()).find(filter).toArray()
    } catch (error) {
      console.error({ fn: this.list.name, error })
    }
  }

  /**
   * @override
   * @returns
   */
  async count () {
    return await (await this.collection()).countDocuments()
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
      super.deleteSync(id)
    } catch (error) {
      console.error(error)
    }
  }

  /**
   * Flush the cache to disk.
   * @override
   */
  flush () {
    try {
      this.dsMap.reduce((a, b) => a.then(() => this.saveDb(b.getId(), b)), {})
    } catch (error) {
      console.error(error)
    }
  }

  /**
   * Process terminating, flush cache, close connections.
   * @override
   */
  close () {
    this.flush()
  }
}
