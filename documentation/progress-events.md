# Progress Events

Public functions in the **filecoin-pin JavaScript library** report progress through a single `onProgress` handler that receives a discriminated union of typed events. This document describes the event shape, the naming convention, and the rules for adding new events.

## Shape

Event and handler types are defined in [`src/core/utils/types.ts`](../src/core/utils/types.ts):

- `ProgressEvent<Type, Data>` — discriminated event with a `type` string and optional `data` payload.
- `ProgressEventHandler<Events>` — handler that receives a union of events.
- `AnyProgressEvent` — base type used as the default constraint, shaped `{ type: string; data?: unknown }`.

Each public function exports a union of its events and accepts `onProgress?: ProgressEventHandler<MyEvents>`.

## Naming convention

The `type` discriminator string follows these rules:

1. **camelCase** for words. No kebab-case, PascalCase, or `snake_case`.
2. **No `on` prefix.** The handler is already named `onProgress`. Event types name the event, e.g. `stored`, `piecesAdded`.
3. **Colon (`:`) for namespaces** when an event belongs to a multi-step sub-flow, e.g. `removePiece:submitting`, `removePiece:confirmationFailed`.

### When to use a colon namespace

Use a namespace when the event union covers a multi-step operation that maps to a user-visible flow (`removePiece:`, `removeAll:`, `ipniProviderResults:`).

Skip the namespace when a single-word name already identifies the subsystem (`stored`, `piecesAdded`, `copyComplete` in `UploadProgressEvents`).

When in doubt, omit the namespace.

## Examples

The snippets below illustrate naming and namespace patterns. Canonical unions live with their feature module; see [`src/core/upload/synapse.ts`](../src/core/upload/synapse.ts) for `UploadProgressEvents` in context.

```ts
export type UploadProgressEvents =
  | ProgressEvent<'stored', { providerId: bigint; pieceCid: PieceCID }>
  | ProgressEvent<'piecesAdded', { txHash: Hash; providerId: bigint }>
  | ProgressEvent<'providerSelected', { provider: PDPProvider }>

export type UploadReadinessProgressEvents =
  | ProgressEvent<'checkingBalances'>
  | ProgressEvent<'validatingCapacity'>

export type RemovePieceProgressEvents =
  | ProgressEvent<'removePiece:submitting', { pieceCid: string; dataSetId: bigint }>
  | ProgressEvent<'removePiece:confirmationFailed', { pieceCid: string; dataSetId: bigint; txHash: Hash; message: string }>
  | ProgressEvent<'removePiece:complete', { txHash: Hash; confirmed: boolean }>
```

## Consumer pattern

```ts
onProgress: (event) => {
  switch (event.type) {
    case 'stored':
      log.info({ providerId: event.data.providerId }, 'piece stored')
      break
    case 'providerSelected':
      log.info({ provider: event.data.provider.name }, 'provider selected')
      break
    default: {
      const _exhaustive: never = event
      throw new Error(`unhandled event: ${(_exhaustive as AnyProgressEvent).type}`)
    }
  }
}
```

The `never` default is the way to get a compile-time error when a new event is added to the union but the consumer has not handled it. Without that pattern, TypeScript will not flag a non-exhaustive `switch`.

## Adding a new event

Event unions are co-located with the function that emits them (e.g. `UploadProgressEvents` lives in [`src/core/upload/synapse.ts`](../src/core/upload/synapse.ts)).

1. Add a new `ProgressEvent<'eventName', { ...data }>` member to the relevant union (omit the data type for events that carry no payload).
2. Emit it from the implementation: `onProgress?.({ type: 'eventName', data: { ... } })`, or `onProgress?.({ type: 'eventName' })` for events with no payload.
3. Update consumer `switch` statements that need to react to it.
4. If the event represents a sub-flow, decide whether to introduce or reuse a colon namespace.

## Backwards compatibility

Event `type` strings are part of the public API. Renaming or removing a type is a breaking change and requires a major version bump and CHANGELOG entry. Adding a new event type is runtime-compatible but can break consumers that use the `never` exhaustiveness pattern; this project treats it as a minor bump.
