type AnyProgressEvent = { type: string; data?: unknown }

export type ProgressEvent<T extends string = string, D = undefined> = D extends undefined
  ? { type: T }
  : { type: T; data: D }

export type ProgressEventHandler<E extends AnyProgressEvent = AnyProgressEvent> = (event: E) => void
