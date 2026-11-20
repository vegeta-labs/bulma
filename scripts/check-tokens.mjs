// tokens.css is shared word for word with Goten and Trunks (tech design §2). Change the shared rule first, then every copy.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const WANT = 'fe9ab88bad1d4a6cfb33db518650f1da983e844fff267525d7f3237fe89b10a9'
const have = createHash('sha256').update(readFileSync('src/web/tokens.css')).digest('hex')
if (have !== WANT) {
  console.error(`src/web/tokens.css differs from the shared design variables\n  want ${WANT}\n  have ${have}`)
  process.exit(1)
}
console.log('tokens.css matches the shared design variables')
