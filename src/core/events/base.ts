export interface EventEmitter<E extends { type: string }> {
  emit<T extends E['type']>(event: Extract<E, { type: T }>): void
  on<T extends E['type']>(type: T, handler: (event: Extract<E, { type: T }>) => void): () => void
}

export function createEventEmitter<E extends { type: string }>(): EventEmitter<E> {
  const listeners = new Map<string, Set<(event: E) => void>>()

  const on = <T extends E['type']>(type: T, handler: (event: Extract<E, { type: T }>) => void): (() => void) => {
    const set = listeners.get(type) ?? new Set()
    set.add(handler as (event: E) => void)
    listeners.set(type, set)

    return () => {
      const existing = listeners.get(type)
      if (!existing) return
      existing.delete(handler as (event: E) => void)
      if (existing.size === 0) {
        listeners.delete(type)
      }
    }
  }

  const emit = <T extends E['type']>(event: Extract<E, { type: T }>): void => {
    const set = listeners.get(event.type)
    if (!set) return
    for (const handler of set) {
      handler(event as E)
    }
  }

  return { emit, on }
}
