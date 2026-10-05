import logoShareBytes from '../assets/share-signature-logo.png'
import signatureBytes from '../assets/assinatura-para-recibo.png'

export const SIGNATURE_LOGO_CID = 'share-brasil-signature-logo'

export function arrayBufferBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)))
  }
  return btoa(binary)
}

export const SIGNATURE_LOGO_BASE64 = arrayBufferBase64(logoShareBytes)
export const SIGNATURE_BASE64 = arrayBufferBase64(signatureBytes)
