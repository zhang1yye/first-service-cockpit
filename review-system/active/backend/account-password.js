import crypto from 'node:crypto'

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const DIGITS = '23456789'
const SAFE = `${UPPER}${LOWER}${DIGITS}`

function pick(alphabet) {
  return alphabet[crypto.randomInt(0, alphabet.length)]
}

export function generateTemporaryPassword(length = 18) {
  const safeLength = Math.max(16, Math.min(64, Number(length) || 18))
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS)]
  while (chars.length < safeLength) chars.push(pick(SAFE))
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}
