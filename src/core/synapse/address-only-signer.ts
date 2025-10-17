/**
 * Address-only signer for session key authentication
 *
 * This signer provides an address but throws on any signing operations.
 * Used as the "owner" signer when authenticating with session keys,
 * where the actual signing is done by the session key wallet.
 */

import { AbstractSigner, type Provider, type TransactionRequest } from 'ethers'

const cannotSign = (thing: string) =>
  `Cannot sign ${thing} - this is an address-only signer for session key authentication. Signing operations should be performed by the session key.`

/**
 * Symbol used to identify AddressOnlySigner instances
 * This is more reliable than instanceof checks across module boundaries
 */
export const ADDRESS_ONLY_SIGNER_SYMBOL = Symbol.for('filecoin-pin.AddressOnlySigner')

export class AddressOnlySigner extends AbstractSigner {
  readonly address: string
  readonly [ADDRESS_ONLY_SIGNER_SYMBOL] = true

  constructor(address: string, provider?: Provider) {
    super(provider)
    this.address = address
  }

  async getAddress(): Promise<string> {
    return this.address
  }

  connect(provider: Provider): AddressOnlySigner {
    return new AddressOnlySigner(this.address, provider)
  }

  async signTransaction(_tx: TransactionRequest): Promise<string> {
    throw new Error(cannotSign('transaction'))
  }

  async signMessage(_message: string | Uint8Array): Promise<string> {
    throw new Error(cannotSign('message'))
  }

  async signTypedData(_domain: any, _types: Record<string, any[]>, _value: Record<string, any>): Promise<string> {
    throw new Error(cannotSign('typed data'))
  }
}
