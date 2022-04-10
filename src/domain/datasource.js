'use strict'

function roughSizeOfObject (...objects) {
  let bytes = 0

  objects.forEach(object => {
    const objectList = []
    const stack = [object]
    while (stack.length) {
      var value = stack.pop()

      if (typeof value === 'boolean') {
        bytes += 4
      } else if (typeof value === 'string') {
        bytes += value.length * 2
      } else if (typeof value === 'number') {
        bytes += 8
      } else if (
        typeof value === 'object' &&
        objectList.indexOf(value) === -1
      ) {
        objectList.push(value)

        for (var i in value) {
          stack.push(value[i])
        }
      }
    }
  })

  return bytes
}

/**
 * Abstract datasource class
 */
export default class DataSource {
  constructor (map, factory, name) {
    this.dsMap = map
    this.factory = factory
    this.name = name
    console.debug({ fn: DataSource.name, dsMap: this.dsMap })
  }
  /**
   * Upsert model instance
   * @param {*} id
   * @param {*} data
   * @param {boolean} sync - sync cluster nodes, defaults to true
   * @returns {Promise<object>}
   */
  async save (id, data, sync = true) {
    throw new Error('abstract method not implemented')
  }

  /**
   * Find model instance by ID
   * @param {*} id record id
   * @returns {Promise<any>} record
   */
  async find (id) {
    throw new Error('abstract method not implemented')
  }

  /**
   * list model instances
   * @param {boolean} [cached] - list cached items, default is true
   * @returns {Promise<any[]>}
   */
  async list (query = null, cached = true) {
    throw new Error('abstract method not implemented')
  }

  listSync (query) {}

  /**
   *
   * @param {*} id
   * @param {boolean} sync sync cluster nodes, true by default
   */
  async delete (id, sync = true) {
    throw new Error('abstract method not implemented')
  }

  /**
   *
   * @param {*} options
   */
  async load (options) {}

  /**
   *
   * @returns {import("./datasource-factory").DataSourceFactory}
   */
  getFactory () {
    return this.factory
  }

  /**
   *
   */
  totalRecords () {
    return this.dsMap.length
  }

  getCacheSize () {
    return this.totalRecords()
  }

  getCacheSizeBytes () {
    return this.totalRecords() * roughSizeOfObject(this.dsMap.reduce(a => a))
  }

  /**
   *
   */
  close () {}
}
