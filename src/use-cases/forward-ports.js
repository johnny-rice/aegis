'use strict'

function getLocallyUnhandledEvents (specs) {
  console.debug(specs)
  const cons = specs
    .filter(spec => spec.ports)
    .map(spec => Object.values(spec.ports))
    .filter(([port]) => !port.internal)
    .map(([port]) => port.consumesEvent)

  const pros = specs
    .filter(spec => spec.ports)
    .map(spec => Object.values(spec.ports))
    .filter(([port]) => !port.internal)
    .map(([port]) => port.producesEvent)

  console.debug(cons, pros)

  return {
    consumerEvents: cons.filter(c => !pros.includes(c)),
    producerEvents: pros.filter(p => !cons.includes(p))
  }
}

/**
 * Subscribe to remote consumer port events
 * and publish local producer port events,
 * provided:
 *
 * - there is no local service handling
 * the event
 *
 * - they are marked as `internal`, meaning there
 * is no custom adapter handling the port.
 *
 * Internal ports use the built-in mesh network,
 * which enables event-driven worklfow to function
 * whether participating components are local or
 * remote, i.e. it enables transparent integration.
 *
 * Note: the system will try to determine if there is
 * a local service to handle the event before subscribing
 * or forwarding.
 *
 * @param {import("../domain/observer").Observer} observer
 * @param {import("../domain/model-factory").ModelFactory} models
 * @param {function(event,data)} publish
 * @param {function(event,function())} subscribe
 */
export function handlePortEvents ({ observer, models, publish, subscribe }) {
  /**@type{import('../domain/').ModelSpecification[]} */
  const specs = models.getModelSpecs()

  const { consumerEvents, producerEvents } = getLocallyUnhandledEvents(specs)

  consumerEvents.forEach(consumerEvent =>
    subscribe(consumerEvent, eventData =>
      observer.notify(eventData.eventName, eventData)
    )
  )

  producerEvents.forEach(producerEvent =>
    observer.on(producerEvent, eventData =>
      publish(eventData.eventName, eventData)
    )
  )
}
