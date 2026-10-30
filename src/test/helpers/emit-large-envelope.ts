import { emit } from '../../common/command-envelope.js'

const blob = 'x'.repeat(256 * 1024)
await emit({
  schemaVersion: 1,
  code: 'OK',
  data: { blob },
  error: null,
  actions: [],
})
