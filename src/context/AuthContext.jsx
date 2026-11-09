import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { isSupabaseConfigured, supabase, supabaseAuthStorageKey } from '../lib/supabase.js'

const AuthContext = createContext(null)
const LEGACY_STORAGE_KEY = 'family-vault-auth'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [isLoading, setIsLoading] = useState(isSupabaseConfigured)

  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY)
      localStorage.removeItem(supabaseAuthStorageKey)
    } catch (error) {
      console.error('Failed to clear previously saved authentication data:', error)
    }
  }, [])

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setIsLoading(false)
      return
    }

    let active = true

    async function syncSession() {
      try {
        const { data: { session }, error } = await supabase.auth.getSession()
        if (error) {
          console.error('Failed to check the in-memory authentication session:', error)
          if (active) setUser(null)
        } else if (active) {
          setUser(session?.user ?? null)
        }
      } catch (error) {
        console.error('Failed to check the in-memory authentication session:', error)
        if (active) setUser(null)
      } finally {
        if (active) setIsLoading(false)
      }
    }

    syncSession()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) {
        setUser(session?.user ?? null)
        setIsLoading(false)
      }
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  const login = async ({ email, password }) => {
    if (isSupabaseConfigured) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
      return data.user
    }

    const normalized = {
      id: 'family-owner',
      email,
      name: 'Family Owner',
      isAuthenticated: true,
      loggedInAt: new Date().toISOString(),
    }

    setUser(normalized)
    return normalized
  }

  const logout = async () => {
    if (isSupabaseConfigured) {
      await supabase.auth.signOut()
    }
    setUser(null)
  }

  const resetPassword = async (email) => {
    if (isSupabaseConfigured) {
      const { error } = await supabase.auth.resetPasswordForEmail(email)
      if (error) throw error
      return { email, sent: true }
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
    return { email, sent: true }
  }

  const value = useMemo(
    () => ({ user, isLoading, login, logout, resetPassword }),
    [user, isLoading],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
