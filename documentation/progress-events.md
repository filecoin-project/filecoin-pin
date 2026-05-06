# Progress Events

filecoin-pin exposes progress through a single `onProgress` handler per public function rather than a bag of granular `onX` callbacks. This document describes the convention, the rationale, and the rules for naming new event types.

## Why one `onProgress` instead of many callbacks

The synapse-sdk uses an object-of-callbacks shape (`{ callbacks: { onProviderSelected, onDataSetResolved, ... } }`). filecoin-pin wraps that into a single typed-event-union handler.

Reasons:
- One subscription point per call. Callers do not have to remember to wire a new callback every time we add an event.
- Discriminated unions force exhaustive handling at the type level. New events show up as compile errors in `switch` statements without a `default`.
- Stable surface area as the SDK evolves. We can map new SDK callbacks into existing event types or add new ones without changing the public function signature.
- Easy fan-out and logging. Consumers can log every event with one line: `onProgress: (e) => log.info(e)`.

## Shape

Defined in `src/core/utils/types.ts`:

```ts
export type ProgressEvent<T extends string = string, D = undefined> = D extends undefined
  ? { type: T }
  : { type: T; data: D }

export type ProgressEventHandler<E extends AnyProgressEvent = AnyProgressEvent> = (event: E) => void
```

Each function exports a discriminated union of its events and accepts `onProgress?: ProgressEventHandler<MyEvents>`.

## Naming convention

The `type` discriminator string follows these rules:

1. **camelCase** for words. No kebab-case, no PascalCase, no `snake_case`.
2. **No `on` prefix** on the type string. The handler is already called `onProgress`; the prefix is redundant. Use `stored`, not `onStored`.
3. **Colon (`:`) namespace separator** when an event belongs to a logical sub-flow whose events would otherwise collide with other unions or be ambiguous in logs. Use `removePiece:submitting`, not `removePieceSubmitting`.
4. **No dot (`.`) separator.** Dots imply a property path; we use them only inside `data`, never in `type`.
5. **Both sides of the colon are camelCase.** `removePiece:confirmationFailed`, not `removePiece:confirmation-failed`.

### When to use a colon namespace

Use a namespace when:
- The event union covers a multi-step operation that maps to a user-visible flow (`removePiece:`, `removeAll:`, `ipniProviderResults:`).
- Multiple unions might be merged in a single log stream and you want to grep by subsystem.

Skip the namespace when:
- The events already make the subsystem obvious from a single-word name (`stored`, `piecesAdded`, `copyComplete` from `UploadProgressEvents`).
- The function is a single concept and the union has few entries (`checkingBalances`, `validatingCapacity` from `UploadReadinessProgressEvents`).

If in doubt, prefer no namespace. Add one later when collision or ambiguity shows up.

## Examples

```ts
// No namespace, drop `on` prefix
export type UploadProgressEvents =
  | ProgressEvent<'stored', { providerId: bigint; pieceCid: PieceCID }>
  | ProgressEvent<'piecesAdded', { txHash: Hash; providerId: bigint }>
  | ProgressEvent<'providerSelected', { provider: PDPProvider }>

// No namespace, multi-word camelCase
export type UploadReadinessProgressEvents =
  | ProgressEvent<'checkingBalances'>
  | ProgressEvent<'validatingCapacity'>

// Colon namespace for multi-step flow
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
    // exhaustive: no default needed if the union is closed
  }
}
```

Omit `default` to get a compile-time error when the union grows. If you need a default, do an exhaustiveness check:

```ts
default: {
  const _exhaustive: never = event
  throw new Error(`unhandled event: ${(_exhaustive as AnyProgressEvent).type}`)
}
```

## Adding a new event

1. Add a new `ProgressEvent<'eventName', { ...data }>` member to the relevant union.
2. Emit it from the implementation.
3. Update consumer `switch` statements that need to react to it. The compiler points out any missing cases when there is no `default`.
4. If the event represents a sub-flow, decide whether to introduce or reuse a colon namespace.

## Backwards compatibility

Event `type` strings are part of the public API. Renaming or removing a type is a breaking change and requires a major version bump and CHANGELOG entry. Adding a new event type is non-breaking.
