// The `voice` Edge Function: Deepgram tokens for talking to Clueless, and (when switched on)
// ElevenLabs reading replies aloud. The logic is in ../_shared/voice.ts. Secrets:
//   DEEPGRAM_API_KEY                                               talking to Clueless
//   CLUELESS_ELEVENLABS=on, ELEVENLABS_API_KEY, CLUELESS_ELEVENLABS_VOICE (a voice ID)   reading aloud
import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import type { UsageState } from '../_shared/policy.ts'
import { handleVoice } from '../_shared/voice.ts'

const env = (name: string): string | undefined => Deno.env.get(name)

const admin = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false }
})

Deno.serve((req) =>
  handleVoice(req, {
    env,
    fetch,
    log: (line) => console.log(line),

    async userFor(token) {
      const { data, error } = await admin.auth.getClaims(token)
      if (error || !data || data.claims.role !== 'authenticated') return null
      return typeof data.claims.sub === 'string' ? data.claims.sub : null
    },

    async usage(userId) {
      const { data, error } = await admin.rpc('usage_check', { student: userId })
      if (error) throw new Error(error.message)
      return data as UsageState | null
    },

    async record(event) {
      const { error } = await admin.from('usage_events').insert(event)
      if (error) throw new Error(error.message)
    }
  })
)
