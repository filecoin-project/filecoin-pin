import type { Chain } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub the OWS native binding + adapter so this suite runs on every CI platform
// (the native core has no Windows/musl prebuilt). We assert the serialization
// our getOwsAccount override performs, not the Rust signer itself.
const { owsToViemAccount, coreSignTypedData, adapterSignMessage } = vi.hoisted(() => ({
  owsToViemAccount: vi.fn(),
  coreSignTypedData: vi.fn(
    (
      _wallet: string,
      _chain: string,
      _typedDataJson: string,
      _passphrase?: string,
      _index?: number,
      _vault?: string
    ) => ({
      signature: 'abcd',
    })
  ),
  adapterSignMessage: vi.fn(),
}))

vi.mock('@open-wallet-standard/adapters/viem', () => ({ owsToViemAccount }))
vi.mock('@open-wallet-standard/core', () => ({ signTypedData: coreSignTypedData }))

import { getOwsAccount } from '../../core/ows/index.js'

const calibration = { id: 314159, name: 'Filecoin Calibration' } as unknown as Chain

const domain = {
  name: 'FilecoinWarmStorageService',
  version: '1',
  chainId: 314159,
  verifyingContract: '0x1111111111111111111111111111111111111111',
} as const

beforeEach(() => {
  owsToViemAccount.mockReset()
  coreSignTypedData.mockReset()
  coreSignTypedData.mockReturnValue({ signature: 'abcd' })
  owsToViemAccount.mockReturnValue({
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    signMessage: adapterSignMessage,
    signTransaction: vi.fn(),
    signTypedData: vi.fn(),
  })
})

async function signWith(message: Record<string, unknown>, types: Record<string, unknown>, primaryType: string) {
  const account = await getOwsAccount({ walletId: 'fil-test', chain: calibration })
  const signature = await account.signTypedData?.({ domain, types, primaryType, message } as never)
  const call = coreSignTypedData.mock.calls[0]
  if (call == null) throw new Error('core.signTypedData was not called')
  return { signature, serialized: JSON.parse(call[2]), call }
}

describe('getOwsAccount - signTypedData bigint serialization', () => {
  it('injects EIP712Domain and passes eip155 chain + walletId to the core', async () => {
    const { call, serialized } = await signWith(
      { clientDataSetId: 42n },
      { CreateDataSet: [{ name: 'clientDataSetId', type: 'uint256' }] },
      'CreateDataSet'
    )
    expect(call[0]).toBe('fil-test')
    expect(call[1]).toBe('eip155:314159')
    expect(serialized.types.EIP712Domain).toBeDefined()
  })

  it('encodes bigints as even-length hex so values above 2^128 are accepted', async () => {
    const big = 2n ** 128n // one over the OWS decimal-uint limit
    const { serialized } = await signWith(
      { clientDataSetId: big, nonce: 0n, small: 42n },
      {
        Msg: [
          { name: 'clientDataSetId', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'small', type: 'uint256' },
        ],
      },
      'Msg'
    )
    // Even-length hex, round-trips to the original bigint.
    expect(serialized.message.clientDataSetId).toMatch(/^0x([0-9a-f]{2})+$/)
    expect(BigInt(serialized.message.clientDataSetId)).toBe(big)
    // Zero and small values are also even-padded.
    expect(serialized.message.nonce).toBe('0x00')
    expect(serialized.message.small).toBe('0x2a')
  })

  it('hex-encodes bigints inside a uint256[] (SchedulePieceRemovals.pieceIds)', async () => {
    const { serialized } = await signWith(
      { clientDataSetId: 9n, pieceIds: [1n, 2n, 2n ** 200n] },
      {
        SchedulePieceRemovals: [
          { name: 'clientDataSetId', type: 'uint256' },
          { name: 'pieceIds', type: 'uint256[]' },
        ],
      },
      'SchedulePieceRemovals'
    )
    const ids = serialized.message.pieceIds as string[]
    // Each element is even-length hex and round-trips to its original bigint.
    expect(ids.every((h) => /^0x([0-9a-f]{2})+$/.test(h))).toBe(true)
    expect(ids.map((h) => BigInt(h))).toEqual([1n, 2n, 2n ** 200n])
  })

  it('handles a max uint256 without throwing', async () => {
    const max = 2n ** 256n - 1n
    const { serialized } = await signWith(
      { clientDataSetId: max },
      { Msg: [{ name: 'clientDataSetId', type: 'uint256' }] },
      'Msg'
    )
    expect(BigInt(serialized.message.clientDataSetId)).toBe(max)
  })

  it('normalizes the returned signature with a 0x prefix', async () => {
    coreSignTypedData.mockReturnValue({ signature: 'deadbeef' })
    const { signature } = await signWith(
      { clientDataSetId: 1n },
      { Msg: [{ name: 'clientDataSetId', type: 'uint256' }] },
      'Msg'
    )
    expect(signature).toBe('0xdeadbeef')
  })

  it('leaves the adapter signMessage in place (only signTypedData is overridden)', async () => {
    const account = await getOwsAccount({ walletId: 'fil-test', chain: calibration })
    expect(account.signMessage).toBe(adapterSignMessage)
  })
})

describe('getOwsAccount - address validation', () => {
  it('rejects a non-EVM address', async () => {
    owsToViemAccount.mockReturnValue({ address: 'f1abc', signMessage: vi.fn() })
    await expect(getOwsAccount({ walletId: 'fil-test', chain: calibration })).rejects.toThrow(/non-EVM address/)
  })
})
