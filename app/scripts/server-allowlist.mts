// Writes supabase/functions/_shared/allowlist.ts: fingerprints (SHA-256) of the app's system prompts
// and reply schemas. The `ai` function accepts only requests that carry one of them, so our Claude
// key can't be used for anything but Clueless. Run it after changing a prompt or a schema:
//
//   npm run allowlist
//
// src/main/account/allowlist.test.ts fails while the file is out of date.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { allowlistSource } from '../src/main/account/allowlist'

const file = join(import.meta.dirname, '..', '..', 'supabase', 'functions', '_shared', 'allowlist.ts')
writeFileSync(file, allowlistSource())
console.log(`wrote ${file}`)
