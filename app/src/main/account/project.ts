// Which Clueless account server (Supabase project) the app signs in to. No Electron imports, so the
// tutor's provider code and scripts can read it too.
//
// The publishable key is meant to ship inside the app: it only names the project, and row-level
// security decides what a signed-in student may read. Fill both in once the project exists.
// CLUELESS_SUPABASE_URL and CLUELESS_SUPABASE_KEY in .env override them (a local or staging server).
export const PROJECT = { url: '', publishableKey: '' }

export interface AccountServer {
  url: string
  publishableKey: string
}

export function accountServer(env: Record<string, string | undefined> = process.env): AccountServer | null {
  const url = (env.CLUELESS_SUPABASE_URL?.trim() || PROJECT.url).replace(/\/+$/, '')
  const publishableKey = env.CLUELESS_SUPABASE_KEY?.trim() || PROJECT.publishableKey
  return url && publishableKey ? { url, publishableKey } : null
}
