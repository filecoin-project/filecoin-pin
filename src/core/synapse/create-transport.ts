/**
 * Build a viem transport from an RPC URL.
 *
 * URLs starting with `ws://` or `wss://` use {@link webSocket}; everything else
 * uses {@link http}. Shared by Synapse initialization and the session CLI so
 * both build transports identically.
 */

import { type HttpTransport, http, type WebSocketTransport, webSocket } from 'viem'

const WEBSOCKET_REGEX = /^ws(s)?:\/\//i

export function createTransport(rpcUrl: string): HttpTransport | WebSocketTransport {
  if (WEBSOCKET_REGEX.test(rpcUrl)) {
    return webSocket(rpcUrl)
  }
  return http(rpcUrl)
}
