import iconv from 'iconv-lite'

// Some trackers (mostly Russian ones) still use windows-1251, so query strings have to be
// encoded in the site's charset and responses decoded from it.

const normalize = (encoding: string | undefined) => (encoding ?? 'utf-8').toLowerCase()

const isUtf8 = (encoding: string | undefined) => ['utf-8', 'utf8'].includes(normalize(encoding))

export function encode(text: string, encoding?: string): Buffer {
  return isUtf8(encoding) ? Buffer.from(text, 'utf8') : iconv.encode(text, normalize(encoding))
}

export function decode(bytes: Uint8Array, encoding?: string): string {
  const buf = Buffer.from(bytes)
  return isUtf8(encoding) ? buf.toString('utf8') : iconv.decode(buf, normalize(encoding))
}

// Same safe set as .NET WebUtility.UrlEncode; space becomes '+'
const SAFE = /[A-Za-z0-9\-_.!*()]/

export function urlEncode(text: string | null | undefined, encoding?: string): string {
  if (!text) return ''
  let out = ''
  for (const byte of encode(text, encoding)) {
    const ch = String.fromCharCode(byte)
    if (byte < 0x80 && SAFE.test(ch)) out += ch
    else if (byte === 0x20) out += '+'
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

export function urlDecode(text: string | null | undefined, encoding?: string): string {
  if (!text) return ''
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '+') bytes.push(0x20)
    else if (c === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else bytes.push(...encode(c, encoding))
  }
  return decode(Uint8Array.from(bytes), encoding)
}

export const encodingSupported = (encoding: string) => isUtf8(encoding) || iconv.encodingExists(normalize(encoding))
