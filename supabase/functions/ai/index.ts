// The `ai` Edge Function: Clueless's Claude proxy. The logic is in ../_shared/handler.ts; this file
// connects it to Supabase (the student's token, the database) and to the function's secrets:
//   ANTHROPIC_API_KEY                           required
//   CLUELESS_TUTOR_MODEL, CLUELESS_FAST_MODEL   optional model overrides
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set by Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { handle } from '../_shared/handler.ts'
import type { UsageState } from '../_shared/policy.ts'

declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void }

const env = (name: string): string | undefined => Deno.env.get(name)

// The service role reads usage_check() and writes usage_events, which students can't.
const admin = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false }
})

Deno.serve((req) =>
  handle(req, {
    env,
    fetch,
    waitUntil: (work) => EdgeRuntime.waitUntil(work),
    log: (line) => console.log(line),

    async userFor(token) {
      // Checks the signature (and expiry) of the student's access token.
      const { data, error } = await admin.auth.getClaims(token)
      if (error || !data || data.claims.role !== 'authenticated') return null
      return typeof data.claims.sub === 'string' ? data.claims.sub : null
    },

    async usage(userId) {
      const { data, error } = await admin.rpc('usage_check', { student: userId })
      if (error) throw new Error(error.message)
      return data as UsageState | null
    },

    async secrets(userId, sessionId) {
      const { data, error } = await admin
        .from('sessions')
        .select('id, session_secrets(hidden_solution, plan)')
        .eq('id', sessionId)
        .eq('user_id', userId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return null
      const found = data.session_secrets as { hidden_solution: string; plan: unknown } | { hidden_solution: string; plan: unknown }[] | null
      const secret = Array.isArray(found) ? found[0] : found
      return { hidden_solution: secret?.hidden_solution ?? '', plan: secret?.plan ?? [] }
    },

    async record(event) {
      const { error } = await admin.from('usage_events').insert(event)
      if (error) throw new Error(error.message)
    }
  })
)
