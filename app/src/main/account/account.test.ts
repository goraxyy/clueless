import { describe, expect, it } from 'vitest'
import { serverConfig } from './account'

describe('serverConfig', () => {
  it('reads the env first, then what was baked into the build', () => {
    expect(serverConfig({}, {})).toBeNull()
    expect(serverConfig({}, { url: 'https://a.supabase.co/', key: 'pk' })).toEqual({ url: 'https://a.supabase.co', key: 'pk' })
    expect(serverConfig({ CLUELESS_SUPABASE_URL: 'http://127.0.0.1:54321', CLUELESS_SUPABASE_KEY: 'local' }, { url: 'https://a.supabase.co', key: 'pk' })).toEqual({
      url: 'http://127.0.0.1:54321',
      key: 'local'
    })
    expect(serverConfig({ CLUELESS_SUPABASE_URL: 'https://a.supabase.co' }, {})).toBeNull()
  })
})
