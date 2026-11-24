// Entry point on Supabase Edge Functions. The logic is in handler.ts.
// Secrets (supabase secrets set ...): ANTHROPIC_API_KEY, and optionally DEEPGRAM_API_KEY,
// ELEVENLABS_API_KEY, FREE_MONTHLY_USD, PRO_MONTHLY_USD, and for payments
// LEMONSQUEEZY_WEBHOOK_SECRET + LEMONSQUEEZY_CHECKOUT_URL (+ LEMONSQUEEZY_PORTAL_URL,
// LEMONSQUEEZY_TEST_MODE=1). SUPABASE_URL and the project's secret key are provided by Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { handle, type Deps, type Plan } from './handler.ts'

/** Supabase's runtime: keeps work (recording usage) going after the response is sent. */
declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void }

const env = (name: string): string | undefined => Deno.env.get(name)?.trim() || undefined
const usd = (name: string, fallback: number): number => Math.round(Number(env(name) ?? fallback) * 1_000_000)

/** The project's secret key: the new kind (SUPABASE_SECRET_KEYS, a JSON map) if there is one, else
 *  the legacy service-role key, which Supabase retires in 2027. */
function secretKey(): string {
  try {
    const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>
    const key = keys.default ?? Object.values(keys)[0]
    if (typeof key === 'string' && key) return key
  } catch {
    // not set, or not JSON
  }
  return env('SUPABASE_SERVICE_ROLE_KEY') ?? ''
}

const anthropicKey = env('ANTHROPIC_API_KEY')
const admin = createClient(env('SUPABASE_URL')!, secretKey(), {
  auth: { persistSession: false, autoRefreshToken: false }
})

const deps: Deps = {
  anthropicKey: anthropicKey ?? '',
  deepgramKey: env('DEEPGRAM_API_KEY'),
  elevenLabsKey: env('ELEVENLABS_API_KEY'),
  fetch,
  limits: { free: usd('FREE_MONTHLY_USD', 1), pro: usd('PRO_MONTHLY_USD', 8) },
  async verifyUser(token) {
    const { data, error } = await admin.auth.getUser(token)
    return error || !data.user ? null : { id: data.user.id, email: data.user.email }
  },
  async plan(userId) {
    const { data, error } = await admin.from('profiles').select('plan').eq('user_id', userId).maybeSingle()
    if (error) throw new Error(`profiles: ${error.message}`)
    return (data?.plan as Plan | undefined) ?? 'free'
  },
  async monthSpend(userId) {
    const { data, error } = await admin.rpc('month_spend', { uid: userId })
    if (error) throw new Error(`month_spend: ${error.message}`)
    return Number(data ?? 0)
  },
  async recordUsage(row) {
    const { error } = await admin.from('usage').insert(row)
    if (error) throw new Error(error.message)
  },
  async setSubscription(userId, sub) {
    const { error } = await admin.from('profiles').upsert({
      user_id: userId,
      plan: sub.plan,
      subscription_id: sub.id,
      subscription_status: sub.status,
      updated_at: new Date().toISOString()
    })
    if (error) throw new Error(`profiles: ${error.message}`)
  },
  // Payments are on once the webhook secret and the checkout link are set.
  payments:
    env('LEMONSQUEEZY_WEBHOOK_SECRET') && env('LEMONSQUEEZY_CHECKOUT_URL')
      ? {
          webhookSecret: env('LEMONSQUEEZY_WEBHOOK_SECRET')!,
          checkoutUrl: env('LEMONSQUEEZY_CHECKOUT_URL')!,
          portalUrl: env('LEMONSQUEEZY_PORTAL_URL') ?? 'https://app.lemonsqueezy.com/my-orders',
          testMode: env('LEMONSQUEEZY_TEST_MODE') === '1'
        }
      : undefined,
  waitUntil: (work) => EdgeRuntime.waitUntil(work),
  log: (line) => console.error(line)
}

Deno.serve((req) => handle(req, deps))
