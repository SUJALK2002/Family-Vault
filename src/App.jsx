import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useLocation,
  useParams,
} from 'react-router-dom'
import {
  ArrowLeft,
  Bell,
  ChevronRight,
  CircleDashed,
  Download,
  Eye,
  FileImage,
  FileText,
  FolderKanban,
  FolderOpen,
  Globe,
  KeyRound,
  LogOut,
  Menu,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UserCog,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { seedData } from './data/seed.js'
import { isSupabaseConfigured, supabase } from './lib/supabase.js'
import { loadFamilyVault, persistVaultChanges, uploadVaultFile, validateVaultFile } from './lib/vault.js'

const STORAGE_KEY = 'family-vault-data'

function getInitialData() {
  if (typeof window === 'undefined') return seedData

  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return seedData

  try {
    return JSON.parse(raw)
  } catch {
    return seedData
  }
}

const navItems = [
  { to: '/', label: 'Dashboard', icon: FolderKanban },
  { to: '/members', label: 'Family Members', icon: Users },
  { to: '/common-documents', label: 'Common Docs', icon: FolderOpen },
  { to: '/settings', label: 'Settings', icon: UserCog },
]

function fileToDataUrl(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Failed to read file.'))
    reader.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100))
    }
    reader.readAsDataURL(file)
  })
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}

function getDetectedFileType(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf'
  if (file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|bmp|svg|heic|heif|avif|tiff?)$/i.test(file.name)) return 'image'
  return 'other'
}

function reportUploadError(error, setUploadError, prefix) {
  const message = error.message || 'Could not save this file.'
  if (error.code === 'FILE_TOO_LARGE') {
    window.alert(message)
    return
  }
  setUploadError(`${prefix}: ${message}`)
}

function FilePickerButton({ accept, disabled = false, onChange, className, children, label }) {
  const inputId = useId()

  return (
    <>
      <label
        htmlFor={inputId}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(event) => {
          if (disabled || (event.key !== 'Enter' && event.key !== ' ')) return
          event.preventDefault()
          event.currentTarget.click()
        }}
        className={`${className} ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
      >
        {children}
      </label>
      <input
        id={inputId}
        type="file"
        accept={accept}
        aria-label={label}
        disabled={disabled}
        className="sr-only"
        onChange={onChange}
      />
    </>
  )
}

function buildStoredDocument({ file, documentName, memberId, familyId, category = 'Other', notes = '', isImportant = false }) {
  const safeName = (documentName || file.name || 'New Document').trim() || 'New Document'
  const fileType = getDetectedFileType(file)

  return {
    id: crypto.randomUUID(),
    familyId,
    memberId,
    documentName: safeName,
    category,
    originalFilename: file.name,
    storagePath: '',
    fileType,
    fileSize: formatFileSize(file.size),
    notes,
    isImportant,
    isDeleted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    previewUrl: '',
  }
}

async function createDocumentUpload({ file, documentName, memberId, familyId, category, notes, isImportant, folder, onProgress }) {
  validateVaultFile(file)
  const baseDoc = buildStoredDocument({ file, documentName, memberId, familyId, category, notes, isImportant, folder })
  if (isSupabaseConfigured && supabase) {
    const upload = await uploadVaultFile(file, familyId, `documents/${memberId || 'common'}`, { onProgress })
    baseDoc.storagePath = upload.path
    baseDoc.previewUrl = upload.url
    baseDoc.downloadUrl = upload.downloadUrl
  } else {
    baseDoc.previewUrl = await fileToDataUrl(file, onProgress)
  }

  return baseDoc
}

function App() {
  const [vaultData, setVaultData] = useState(() => getInitialData())
  const vaultRef = useRef(vaultData)
  const syncedVaultRef = useRef(null)
  const databaseReadyRef = useRef(false)
  const pendingWritesRef = useRef(Promise.resolve())
  const [databaseStatus, setDatabaseStatus] = useState(isSupabaseConfigured ? 'loading' : 'offline')
  const [databaseError, setDatabaseError] = useState('')
  const [databaseReady, setDatabaseReadyState] = useState(false)

  useEffect(() => {
    if (!isSupabaseConfigured) localStorage.setItem(STORAGE_KEY, JSON.stringify(vaultData))
  }, [vaultData])

  const replaceVaultData = useCallback((nextData) => {
    vaultRef.current = nextData
    syncedVaultRef.current = nextData
    setVaultData(nextData)
  }, [])

  const commitVaultData = useCallback((update) => {
    const previous = vaultRef.current
    const next = typeof update === 'function' ? update(previous) : update
    if (!next || next === previous) return Promise.resolve(true)
    vaultRef.current = next
    setVaultData(next)

    if (!isSupabaseConfigured) return Promise.resolve(true)
    if (!databaseReadyRef.current) return Promise.resolve(false)
    setDatabaseStatus('saving')
    setDatabaseError('')
    const savePromise = pendingWritesRef.current
      .then(async () => {
        const synced = syncedVaultRef.current || { family: next.family, members: [], documents: [], passports: [] }
        await persistVaultChanges(synced, next)
        syncedVaultRef.current = next
        if (vaultRef.current === next) {
          setDatabaseError('')
          setDatabaseStatus('saved')
        }
        return true
      })
      .catch((error) => {
        console.error('Failed to save vault data to Supabase:', error)
        setDatabaseStatus('error')
        setDatabaseError(error.message || 'Could not save your changes to Supabase.')
        return false
      })
    pendingWritesRef.current = savePromise
    return savePromise
  }, [])

  const setDatabaseReady = useCallback((ready) => {
    databaseReadyRef.current = ready
    setDatabaseReadyState(ready)
  }, [])

  const waitForPendingWrites = useCallback(() => pendingWritesRef.current, [])

  const retrySave = useCallback(async () => {
    if (!databaseReadyRef.current) return
    setDatabaseStatus('saving')
    setDatabaseError('')
    try {
      await pendingWritesRef.current
      const synced = syncedVaultRef.current || { family: vaultRef.current.family, members: [], documents: [], passports: [] }
      await persistVaultChanges(synced, vaultRef.current)
      syncedVaultRef.current = vaultRef.current
      setDatabaseStatus('saved')
    } catch (error) {
      console.error('Failed to retry saving vault data:', error)
      setDatabaseStatus('error')
      setDatabaseError(error.message || 'Could not save your changes to Supabase.')
    }
  }, [])

  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route
            path="/login"
            element={<LoginPage />} 
          />
          <Route
            element={
              <ProtectedRoute>
                <AppLayout
                  vaultData={vaultData}
                  setVaultData={replaceVaultData}
                  databaseStatus={databaseStatus}
                  databaseError={databaseError}
                  setDatabaseError={setDatabaseError}
                  databaseReady={databaseReady}
                  setDatabaseStatus={setDatabaseStatus}
                  setDatabaseReady={setDatabaseReady}
                  waitForPendingWrites={waitForPendingWrites}
                  retrySave={retrySave}
                />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<DashboardPage data={vaultData} />} />
            <Route path="/members" element={<FamilyMembersPage data={vaultData} setData={commitVaultData} />} />
            <Route path="/members/:memberId" element={<MemberDetailsPage data={vaultData} setData={commitVaultData} />} />
            <Route path="/common-documents" element={<CommonDocumentsPage data={vaultData} setData={commitVaultData} />} />
            <Route path="/settings" element={<SettingsPage data={vaultData} />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}

function ProtectedRoute({ children }) {
  const { user } = useAuth()
  const location = useLocation()
  return user ? children : <Navigate to="/login" replace state={{ from: location }} />
}

function LoginPage() {
  const { user, login, resetPassword } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const redirectPath = location.state?.from?.pathname?.startsWith('/')
    ? location.state.from.pathname
    : '/'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    if (user) {
      navigate(redirectPath, { replace: true })
    }
  }, [user, navigate, redirectPath])

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')

    if (!email.trim() || !password.trim()) {
      setError('Enter your family login ID and password to continue.')
      return
    }

    setLoading(true)

    try {
      await login({ email: email.trim(), password: password.trim(), rememberMe })
      navigate(redirectPath, { replace: true })
    } catch (submitError) {
      setError(submitError?.message || 'Unable to sign in with the provided family credentials.')
    } finally {
      setLoading(false)
    }
  }

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setError('Enter your family email before requesting a reset.')
      return
    }

    setLoading(true)

    try {
      await resetPassword(email.trim())
      setSuccess('Password reset instructions were sent to your family email.')
      setError('')
    } catch (resetError) {
      setError(resetError?.message || 'Password reset could not be sent right now.')
      setSuccess('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-hero-gradient px-3 py-5 text-white sm:px-6 sm:py-10">
      <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] max-w-6xl items-center justify-center sm:min-h-[calc(100vh-5rem)]">
        <div className="grid w-full overflow-hidden rounded-[26px] border border-white/10 bg-charcoal/70 shadow-glass backdrop-blur-xl sm:rounded-[32px] lg:grid-cols-[1.15fr_0.85fr]">
          <div className="relative hidden overflow-hidden bg-gradient-to-br from-white/10 via-charcoal to-red/20 p-10 lg:flex lg:flex-col justify-between xl:p-14">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(227,38,54,0.25),transparent_30%)]" />
            <div className="relative z-10 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-action-gradient shadow-lg shadow-red-500/20">
                <ShieldCheck className="h-6 w-6 text-white" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-slate-300">Private vault</p>
                <h1 className="text-2xl font-semibold">Family Document Vault</h1>
              </div>
            </div>

            <div className="relative z-10 max-w-md space-y-6">
              <div className="inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200">One family account</div>
              <h2 className="text-4xl font-semibold leading-tight">Your family&apos;s important documents. One secure place.</h2>
              <p className="text-slate-300">Store every passport, insurance record, certificate, and shared family paper in one protected vault built for modern households.</p>
              <div className="grid gap-4 text-sm text-slate-200 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <Users className="mb-3 h-5 w-5 text-red-400" />
                  Multiple member profiles
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <Wallet className="mb-3 h-5 w-5 text-red-400" />
                  Shared family storage
                </div>
              </div>
            </div>

            <div className="relative z-10 flex items-center gap-3 text-sm text-slate-300">
              <Globe className="h-4 w-4 text-red-400" />
              {isSupabaseConfigured ? 'Secure Supabase-ready environment' : 'Demo vault mode ready'}
            </div>
          </div>

          <div className="p-5 sm:p-10 lg:p-12">
            <div className="mb-8 flex items-center justify-between lg:hidden">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-action-gradient shadow-lg shadow-red-500/20">
                  <ShieldCheck className="h-5 w-5 text-white" />
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.25em] text-slate-400">Vault</p>
                  <h1 className="text-lg font-semibold">Family Document Vault</h1>
                </div>
              </div>
            </div>

            <div className="mx-auto max-w-md">
              <div className="mb-6">
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-red-400 sm:text-sm sm:tracking-[0.35em]">Secure access</p>
                <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:mt-3 sm:text-4xl">Welcome back</h2>
                <p className="mt-2 text-sm leading-6 text-slate-400 sm:text-base">Sign in to access your family profiles and document vault.</p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5">
                <div>
                  <label className="mb-2 block text-sm text-slate-300" htmlFor="family-email">Family Login ID / Email</label>
                  <input
                    id="family-email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="min-h-12 w-full rounded-2xl border border-white/10 bg-slate-900/70 px-4 py-3 text-base text-white outline-none ring-0 transition placeholder:text-slate-500 focus:border-red-500 focus:ring-2 focus:ring-red-500/20"
                    placeholder="you@example.com"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm text-slate-300" htmlFor="family-password">Password</label>
                  <div className="relative">
                    <input
                      id="family-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      className="min-h-12 w-full rounded-2xl border border-white/10 bg-slate-900/70 px-4 py-3 pr-14 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-red-500 focus:ring-2 focus:ring-red-500/20"
                      placeholder="Enter your shared family password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((value) => !value)}
                      className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-200"
                      aria-label="Toggle password visibility"
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 text-sm text-slate-300">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(event) => setRememberMe(event.target.checked)}
                      className="h-4 w-4 rounded border-white/10 bg-slate-900 text-red-500"
                    />
                    Remember me
                  </label>
                  <button type="button" onClick={handleForgotPassword} className="font-medium text-red-400 hover:text-red-300">
                    Forgot Password?
                  </button>
                </div>

                {error ? <p className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</p> : null}
                {success ? <p className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{success}</p> : null}

                <button
                  type="submit"
                  disabled={loading}
                  className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-action-gradient px-5 py-3 text-base font-semibold text-white shadow-lg shadow-red-600/20 transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {loading ? <CircleDashed className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  {loading ? 'Signing in...' : 'Login'}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function AppLayout({
  vaultData,
  setVaultData,
  databaseStatus,
  databaseError,
  setDatabaseError,
  databaseReady,
  setDatabaseStatus,
  setDatabaseReady,
  waitForPendingWrites,
  retrySave,
}) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [mobileOpen, setMobileOpen] = useState(false)
  const realtimeChannelRef = useRef(null)
  const lifecycleRef = useRef(0)
  const refreshTimerRef = useRef(null)

  const handleLogout = async () => {
    try {
      await logout()
      navigate('/login', { replace: true })
    } catch (error) {
      console.error('Failed to sign out:', error)
      window.alert(`Could not log out: ${error.message || 'Please try again.'}`)
    }
  }

  useEffect(() => {
    if (!isSupabaseConfigured) {
      return
    }

    if (!user) {
      return
    }

    const lifecycleId = ++lifecycleRef.current
    const isCurrentEffect = () => lifecycleRef.current === lifecycleId

    async function refreshFromSupabase() {
      try {
        await waitForPendingWrites()
        const nextData = await loadFamilyVault(user)
        if (!isCurrentEffect()) return
        setVaultData(nextData)
        setDatabaseReady(true)
        setDatabaseError('')
        setDatabaseStatus('saved')
      } catch (error) {
        if (!isCurrentEffect()) return
        console.error('Failed to load the family vault from Supabase:', error)
        setDatabaseReady(false)
        setDatabaseError(error.message || 'Could not load your family vault from Supabase.')
        setDatabaseStatus('error')
      }
    }

    async function initialize() {
      setDatabaseStatus('loading')
      try {
        const nextData = await loadFamilyVault(user)
        if (!isCurrentEffect()) return
        setVaultData(nextData)
        setDatabaseReady(true)
        setDatabaseError('')
        setDatabaseStatus('saved')

        const refresh = () => {
          window.clearTimeout(refreshTimerRef.current)
          refreshTimerRef.current = window.setTimeout(refreshFromSupabase, 250)
        }
        realtimeChannelRef.current = supabase
          .channel(`family-vault-${nextData.family.id}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'family_members' }, refresh)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'documents' }, refresh)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'passports' }, refresh)
          .subscribe((status) => {
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              console.error(`Supabase Realtime subscription failed: ${status}`)
            }
          })
      } catch (error) {
        if (!isCurrentEffect()) return
        console.error('Failed to initialize the family vault from Supabase:', error)
        setDatabaseReady(false)
        setDatabaseError(error.message || 'Could not load your family vault from Supabase.')
        setDatabaseStatus('error')
      }
    }

    initialize()

    return () => {
      lifecycleRef.current += 1
      window.clearTimeout(refreshTimerRef.current)
      setDatabaseReady(false)
      if (realtimeChannelRef.current) {
        supabase.removeChannel(realtimeChannelRef.current)
        realtimeChannelRef.current = null
      }
    }
  }, [setVaultData, setDatabaseReady, setDatabaseError, setDatabaseStatus, user, waitForPendingWrites])

  const statusLabel = {
    loading: 'Connecting',
    saving: 'Saving',
    saved: 'Synced',
    error: 'Sync issue',
    offline: 'Local demo',
  }[databaseStatus]

  return (
    <div className="min-h-screen bg-hero-gradient text-white">
      <div className="mx-auto flex min-h-screen max-w-[1600px]">
        <aside className="hidden w-72 border-r border-white/10 bg-[#171a1f]/90 px-5 py-6 lg:flex lg:flex-col">
          <div className="mb-8 flex items-center gap-3 px-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-action-gradient">
              <ShieldCheck className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.28em] text-slate-400">Family vault</p>
              <h1 className="text-lg font-semibold">Family Document Vault</h1>
            </div>
          </div>

          <nav className="space-y-2">
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-medium transition ${
                    isActive
                      ? 'border-red-500/50 bg-red-500/10 text-red-200 shadow-lg shadow-red-500/10'
                      : 'border-transparent text-slate-300 hover:border-white/10 hover:bg-white/5'
                  }`
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="mt-auto rounded-3xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Cloud status</span>
              <span className={`rounded-full px-2 py-1 text-[10px] ${databaseStatus === 'error' ? 'bg-red-500/20 text-red-300' : 'bg-emerald-500/20 text-emerald-300'}`}>{statusLabel}</span>
            </div>
            <p className="mt-3 text-lg font-semibold">{vaultData.documents.length} stored docs</p>
            <p className="text-sm text-slate-300">{isSupabaseConfigured ? 'Private Supabase storage' : 'Stored on this device'}</p>
          </div>
        </aside>

        <div className="flex-1">
          <header className="border-b border-white/10 bg-[#171a1f]/80 px-4 py-4 backdrop-blur-sm sm:px-6 lg:px-8">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setMobileOpen((value) => !value)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 lg:hidden"
                  aria-label="Toggle navigation"
                >
                  <Menu className="h-5 w-5" />
                </button>
                <div>
                  <p className="text-xs uppercase tracking-[0.28em] text-slate-400">Good {getGreeting()}</p>
                  <h2 className="text-xl font-semibold text-white">Family vault</h2>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <span className={`hidden rounded-full px-3 py-1 text-xs sm:inline-flex ${databaseStatus === 'error' ? 'bg-red-500/20 text-red-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
                  {statusLabel}
                </span>
                <button type="button" className="relative inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10" aria-label="Notifications">
                  <Bell className="h-4 w-4" />
                  <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-[#171a1f]" />
                </button>
                <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-action-gradient text-sm font-semibold text-white">F</div>
                  <div className="hidden text-left sm:block">
                    <p className="text-sm font-semibold">Family Owner</p>
                    <p className="max-w-40 truncate text-[11px] text-slate-400">{user?.email || 'Shared family account'}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 text-sm font-medium text-slate-200 transition hover:border-red-400/30 hover:bg-red-500/10 hover:text-red-200 sm:px-4"
                  aria-label="Log out"
                  title="Log out"
                >
                  <LogOut className="h-4 w-4" />
                  <span className="hidden sm:inline">Log out</span>
                </button>
              </div>
            </div>
          </header>

          {mobileOpen ? (
            <div className="border-b border-white/10 bg-[#171a1f]/95 p-4 lg:hidden">
              <nav className="grid gap-2">
                {navItems.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    onClick={() => setMobileOpen(false)}
                    className={({ isActive }) => `flex items-center gap-3 rounded-2xl px-4 py-3 ${isActive ? 'bg-red-500/10 text-red-200' : 'text-slate-300'}`}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </NavLink>
                ))}
              </nav>
            </div>
          ) : null}

          <main className="p-4 sm:p-6 lg:p-8">
            {isSupabaseConfigured && databaseStatus === 'loading' ? (
              <div className="rounded-3xl border border-white/10 bg-white/5 p-8 text-slate-200">
                Connecting to your family vault…
              </div>
            ) : null}
            {databaseStatus === 'error' ? (
              <div className="mb-5 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
                <p>{databaseError || 'Supabase could not load your vault. Check the database schema, storage bucket, and policies, then reload.'}</p>
                <div className="mt-3 flex gap-3">
                  {databaseReady ? (
                    <button type="button" onClick={retrySave} className="rounded-xl border border-red-300/30 px-3 py-2 font-medium">Retry save</button>
                  ) : null}
                  <button type="button" onClick={() => window.location.reload()} className="rounded-xl border border-red-300/30 px-3 py-2 font-medium">Reload</button>
                </div>
              </div>
            ) : null}
            {(!isSupabaseConfigured || (databaseStatus !== 'loading' && databaseStatus !== 'error')) ? <Outlet /> : null}
          </main>
        </div>
      </div>
    </div>
  )
}

function DashboardPage({ data }) {
  const members = data.members.filter((member) => !member.isDeleted)
  const documents = data.documents.filter((document) => !document.isDeleted)
  const commonDocuments = documents.filter((document) => !document.memberId)

  return (
    <div className="space-y-8 pb-6 sm:space-y-10">
      <section className="rounded-[26px] border border-white/10 bg-white/[0.045] p-4 shadow-glass sm:rounded-[30px] sm:p-7">
        <div className="mb-5 flex items-end justify-between gap-3 sm:mb-7">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400 sm:text-xs sm:tracking-[0.25em]">Your family</p>
            <h2 className="mt-1.5 text-2xl font-semibold tracking-tight text-white sm:mt-2 sm:text-3xl">Profiles</h2>
          </div>
          <Link to="/members" className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-medium text-white transition hover:bg-white/10 sm:gap-2 sm:rounded-2xl sm:px-4 sm:text-sm">
            <Plus className="h-4 w-4" /> <span>Add<span className="hidden sm:inline"> member</span></span>
          </Link>
        </div>

        {members.length ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3 2xl:grid-cols-4">
            {members.map((member) => {
              const memberDocs = documents.filter((doc) => doc.memberId === member.id)
              return (
                <Link
                  key={member.id}
                  to={`/members/${member.id}`}
                  className="group flex min-h-[250px] flex-col items-center rounded-[22px] border border-white/10 bg-gradient-to-b from-white/[0.07] to-white/[0.025] p-4 text-center shadow-lg shadow-black/20 transition duration-300 hover:-translate-y-1 hover:border-white/20 hover:shadow-xl sm:min-h-[290px] sm:rounded-[26px] sm:p-5"
                >
                  <MemberPortrait member={member} className="w-28 shadow-lg shadow-black/30 sm:w-32" />
                  <div className="mt-4 flex w-full flex-1 flex-col items-center sm:mt-5">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400 sm:text-xs">{member.relationship || 'Family member'}</p>
                    <h3 className="mt-1 line-clamp-2 text-lg font-semibold leading-tight tracking-tight text-white sm:text-xl">{member.name}</h3>
                    <span className="mt-auto inline-flex items-center gap-1.5 pt-3 text-xs font-medium text-slate-400 sm:text-sm">
                      {memberDocs.length} {memberDocs.length === 1 ? 'document' : 'documents'}
                      <ChevronRight className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </Link>
              )
            })}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-white/15 bg-slate-900/30 px-4 py-10 text-center sm:rounded-3xl sm:py-14">
            <Users className="mx-auto h-8 w-8 text-slate-500" />
            <p className="mt-3 text-base font-medium text-white sm:text-lg">No family profiles yet</p>
            <p className="mt-1 text-sm text-slate-400">Add a profile to get started with your family vault.</p>
          </div>
        )}
      </section>

      <section className="rounded-[26px] border border-white/10 bg-white/[0.045] p-4 shadow-glass sm:rounded-[30px] sm:p-7">
        <div className="mb-5 flex items-end justify-between gap-3 sm:mb-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400 sm:text-xs sm:tracking-[0.25em]">Shared family vault</p>
            <h2 className="mt-1.5 text-2xl font-semibold tracking-tight text-white sm:mt-2 sm:text-3xl">Common documents</h2>
          </div>
          <Link to="/common-documents" className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl bg-action-gradient px-3 text-xs font-semibold text-white shadow-lg shadow-red-950/20 transition hover:opacity-90 sm:gap-2 sm:rounded-2xl sm:px-4 sm:text-sm">
            Open vault <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
        {commonDocuments.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {commonDocuments.slice(0, 6).map((doc) => (
              <Link key={doc.id} to="/common-documents" className="flex min-w-0 items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/35 p-3 transition hover:border-white/20 hover:bg-white/[0.06] sm:p-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/10 text-red-200 sm:h-12 sm:w-12 sm:rounded-2xl">
                  {doc.fileType === 'pdf' ? <FileText className="h-5 w-5" /> : <FileImage className="h-5 w-5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-white sm:text-base">{doc.documentName}</span>
                  <span className="mt-0.5 block truncate text-xs text-slate-400 sm:text-sm">{doc.category || 'Shared document'} · {doc.fileType.toUpperCase()}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />
              </Link>
            ))}
          </div>
        ) : (
          <Link to="/common-documents" className="flex min-h-24 items-center justify-center rounded-2xl border border-dashed border-white/15 bg-slate-900/30 px-4 text-center text-sm text-slate-400 transition hover:border-white/25 hover:text-white sm:min-h-28 sm:rounded-3xl">
            No shared documents yet. Open the common vault to upload PDFs or images.
          </Link>
        )}
      </section>
    </div>
  )
}

function MemberPortrait({ member, className = '' }) {
  return (
    <div className={`relative mx-auto flex aspect-[7/9] items-center justify-center overflow-hidden rounded-[18px] border border-white/15 bg-gradient-to-br from-slate-500 to-slate-800 ${className}`}>
      {member.profilePhoto ? (
        <img src={member.profilePhoto} alt={`${member.name} profile`} className="absolute inset-0 h-full w-full object-cover object-[center_30%]" />
      ) : (
        <span className="text-5xl font-semibold text-white/85 sm:text-6xl">{member.name.charAt(0).toUpperCase()}</span>
      )}
    </div>
  )
}

function FamilyMembersPage({ data, setData }) {
  const [showForm, setShowForm] = useState(false)
  const [editingMemberId, setEditingMemberId] = useState('')
  const [editingMemberName, setEditingMemberName] = useState('')
  const [form, setForm] = useState({
    name: '',
    relationship: '',
    dateOfBirth: '',
    phone: '',
    email: '',
    address: '',
    notes: '',
  })
  const [search, setSearch] = useState('')

  const filteredMembers = data.members.filter((member) =>
    member.name.toLowerCase().includes(search.toLowerCase()) || member.relationship.toLowerCase().includes(search.toLowerCase()),
  )

  const handleAddMember = (event) => {
    event.preventDefault()
    if (!form.name.trim()) return

    const newMember = {
      id: crypto.randomUUID(),
      familyId: data.family.id,
      name: form.name.trim(),
      relationship: form.relationship || 'Other',
      dateOfBirth: form.dateOfBirth,
      phone: form.phone,
      email: form.email,
      address: form.address,
      notes: form.notes,
      profilePhoto: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    setData((current) => ({
      ...current,
      members: [...current.members, newMember],
    }))
    setForm({ name: '', relationship: '', dateOfBirth: '', phone: '', email: '', address: '', notes: '' })
    setShowForm(false)
  }

  const handleDeleteMember = (memberId) => {
    if (!window.confirm('Deleting this member may also remove their associated document records. Continue?')) return

    setData((current) => ({
      ...current,
      members: current.members.filter((member) => member.id !== memberId),
      documents: current.documents.filter((document) => document.memberId !== memberId),
      passports: current.passports.filter((passport) => passport.memberId !== memberId),
    }))
  }

  const saveMemberName = (event, memberId) => {
    event.preventDefault()
    const name = editingMemberName.trim()
    if (!name) return
    setData((current) => ({
      ...current,
      members: current.members.map((entry) => (entry.id === memberId ? { ...entry, name, updatedAt: new Date().toISOString() } : entry)),
    }))
    setEditingMemberId('')
    setEditingMemberName('')
  }

  return (
    <div className="space-y-6">
      <div className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-glass">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Members</p>
            <h2 className="mt-2 text-3xl font-semibold text-white">Family profiles</h2>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search members"
                className="rounded-2xl border border-white/10 bg-slate-900/70 py-2.5 pl-10 pr-4 text-sm text-white outline-none focus:border-red-500"
              />
            </div>
            <button type="button" onClick={() => setShowForm(true)} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-action-gradient px-4 py-2.5 text-sm font-semibold text-white">
              <Plus className="h-4 w-4" /> Add member
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 sm:gap-5">
        {filteredMembers.map((member) => {
          const memberDocs = data.documents.filter((document) => document.memberId === member.id && !document.isDeleted)
          return (
            <div key={member.id} className="flex flex-col items-center overflow-hidden rounded-[24px] border border-white/10 bg-white/[0.045] p-4 text-center shadow-glass sm:rounded-[28px] sm:p-5">
              <Link to={`/members/${member.id}`} className="group block rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red-400">
                <MemberPortrait member={member} className="w-32 shadow-lg shadow-black/30 sm:w-36" />
              </Link>
              <div className="mt-4 w-full sm:mt-5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400 sm:text-xs">{member.relationship || 'Family member'}</p>
                {editingMemberId === member.id ? (
                  <form onSubmit={(event) => saveMemberName(event, member.id)} className="mt-2 flex gap-2">
                    <input autoFocus aria-label="Member name" value={editingMemberName} onChange={(event) => setEditingMemberName(event.target.value)} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-red-400" />
                    <button type="submit" className="rounded-xl bg-action-gradient px-3 py-2 text-sm font-semibold text-white">Save</button>
                    <button type="button" onClick={() => setEditingMemberId('')} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-slate-300">Cancel</button>
                  </form>
                ) : (
                  <Link to={`/members/${member.id}`} className="mt-1 block line-clamp-2 text-lg font-semibold leading-tight text-white hover:text-red-200 sm:text-xl">{member.name}</Link>
                )}
                <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 sm:text-sm">
                  <span>{memberDocs.length} {memberDocs.length === 1 ? 'document' : 'documents'}</span>
                  <span className="max-w-full truncate">{member.email || member.phone || 'No contact details'}</span>
                </div>
                <div className="flex gap-2">
                  <Link to={`/members/${member.id}`} className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/10 bg-white/5 px-3 text-sm font-semibold text-white transition hover:bg-white/10 sm:rounded-2xl">Open profile</Link>
                  <button type="button" onClick={() => handleDeleteMember(member.id)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 text-slate-300 transition hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-200 sm:rounded-2xl" aria-label={`Delete ${member.name}`}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => {
                    setEditingMemberId(member.id)
                    setEditingMemberName(member.name)
                  }} className="min-h-11 rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-slate-200 transition hover:bg-white/10 sm:rounded-2xl">
                    Edit name
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {showForm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl rounded-[30px] border border-white/10 bg-[#1a1d25] p-5 shadow-glass">
            <div className="mb-5 flex items-center justify-between">
              <h3 className="text-2xl font-semibold text-white">Add family member</h3>
              <button type="button" onClick={() => setShowForm(false)} className="rounded-xl border border-white/10 p-2 text-slate-300"><X className="h-4 w-4" /></button>
            </div>
            <form onSubmit={handleAddMember} className="grid gap-4 md:grid-cols-2">
              <div className="md:col-span-1">
                <label className="mb-2 block text-sm text-slate-300">Full Name</label>
                <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" required />
              </div>
              <div className="md:col-span-1">
                <label className="mb-2 block text-sm text-slate-300">Relationship</label>
                <input value={form.relationship} onChange={(event) => setForm({ ...form, relationship: event.target.value })} className="w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" placeholder="Father, Mother, Son..." />
              </div>
              <div className="md:col-span-1">
                <label className="mb-2 block text-sm text-slate-300">Date of Birth</label>
                <input type="date" value={form.dateOfBirth} onChange={(event) => setForm({ ...form, dateOfBirth: event.target.value })} className="w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" />
              </div>
              <div className="md:col-span-1">
                <label className="mb-2 block text-sm text-slate-300">Phone Number</label>
                <input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} className="w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" />
              </div>
              <div className="md:col-span-1">
                <label className="mb-2 block text-sm text-slate-300">Email</label>
                <input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} className="w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" />
              </div>
              <div className="md:col-span-1">
                <label className="mb-2 block text-sm text-slate-300">Address</label>
                <input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} className="w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" />
              </div>
              <div className="md:col-span-2">
                <label className="mb-2 block text-sm text-slate-300">Notes</label>
                <textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} className="min-h-[110px] w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" />
              </div>
              <div className="md:col-span-2 flex justify-end gap-3">
                <button type="button" onClick={() => setShowForm(false)} className="rounded-2xl border border-white/10 px-4 py-2.5 text-slate-200">Cancel</button>
                <button type="submit" className="rounded-2xl bg-action-gradient px-4 py-2.5 font-semibold text-white">Save member</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function MemberDetailsPage({ data, setData }) {
  const { memberId } = useParams()
  const navigate = useNavigate()
  const member = data.members.find((entry) => entry.id === memberId)
  const memberDocs = data.documents.filter((document) => document.memberId === memberId && !document.isDeleted)
  const [selectedDoc, setSelectedDoc] = useState(null)
  const [showEditor, setShowEditor] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploadMessage, setUploadMessage] = useState('')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [editingDocumentId, setEditingDocumentId] = useState('')
  const [editingDocumentName, setEditingDocumentName] = useState('')
  const [profilePhoto, setProfilePhoto] = useState(member?.profilePhoto || '')
  const [form, setForm] = useState({
    name: member?.name || '',
    relationship: member?.relationship || '',
    dateOfBirth: member?.dateOfBirth || '',
    phone: member?.phone || '',
    email: member?.email || '',
    address: member?.address || '',
    notes: member?.notes || '',
  })

  if (!member) {
    return <Navigate to="/members" replace />
  }

  const updateMember = (event) => {
    event.preventDefault()
    setData((current) => ({
      ...current,
      members: current.members.map((entry) =>
        entry.id === memberId
          ? {
              ...entry,
              ...form,
              name: form.name,
              profilePhoto,
              updatedAt: new Date().toISOString(),
            }
          : entry,
      ),
    }))
    setShowEditor(false)
  }

  const uploadDocument = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    setUploadError('')
    setUploadMessage('')
    setUploadProgress(0)
    setUploading(true)
    try {
      const doc = await createDocumentUpload({
        file,
        documentName: file.name.replace(/\.[^.]+$/, '') || file.name,
        memberId,
        familyId: data.family.id,
        category: 'Other',
        notes: '',
        isImportant: false,
        folder: 'member',
        onProgress: setUploadProgress,
      })
      const saved = await setData((current) => ({ ...current, documents: [doc, ...current.documents] }))
      if (saved === false) {
        throw new Error('The file uploaded to Storage, but its document record could not be saved to the database. Check the sync error and retry saving.')
      }
      setUploadProgress(100)
      setUploadMessage(`${file.name} uploaded successfully.`)
    } catch (error) {
      reportUploadError(error, setUploadError, 'Upload failed')
    } finally {
      setUploading(false)
      event.target.value = ''
    }
  }

  const uploadProfilePhoto = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    setUploadError('')
    setUploadMessage('')
    setUploadProgress(0)
    setUploading(true)
    try {
      validateVaultFile(file, { imagesOnly: true })
      const photo = isSupabaseConfigured
        ? await uploadVaultFile(file, data.family.id, `profiles/${memberId}`, { onProgress: setUploadProgress })
        : { path: '', url: await fileToDataUrl(file, setUploadProgress) }
      setProfilePhoto(photo.url)
      const saved = await setData((current) => ({
        ...current,
        members: current.members.map((entry) => (entry.id === memberId
          ? { ...entry, profilePhoto: photo.url, profilePhotoPath: photo.path, updatedAt: new Date().toISOString() }
          : entry)),
      }))
      if (saved === false) {
        throw new Error('The photo uploaded to Storage, but its profile record could not be saved to the database. Check the sync error and retry saving.')
      }
      setUploadProgress(100)
      setUploadMessage(`${file.name} uploaded successfully.`)
    } catch (error) {
      reportUploadError(error, setUploadError, 'Photo upload failed')
    } finally {
      setUploading(false)
      event.target.value = ''
    }
  }

  const saveDocumentName = (event, documentId) => {
    event.preventDefault()
    const documentName = editingDocumentName.trim()
    if (!documentName) return
    setData((current) => ({
      ...current,
      documents: current.documents.map((entry) => (entry.id === documentId
        ? { ...entry, documentName, updatedAt: new Date().toISOString() }
        : entry)),
    }))
    setEditingDocumentId('')
    setEditingDocumentName('')
  }

  return (
    <div className="space-y-6">
      <div className="rounded-[30px] border border-white/10 bg-white/5 p-5 shadow-glass">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => navigate('/members')} className="rounded-xl border border-white/10 bg-white/5 p-2.5 text-slate-200"><ArrowLeft className="h-4 w-4" /></button>
          <MemberPortrait member={{ ...member, profilePhoto }} className="w-12 shrink-0 rounded-xl sm:w-14" />
            <div>
              <h2 className="text-3xl font-semibold text-white">{member.name}</h2>
              <p className="text-sm text-slate-400">{member.relationship} • {memberDocs.length} documents</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setShowEditor((value) => !value)} className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white"><Pencil className="h-4 w-4" /> {showEditor ? 'Close Editor' : 'Edit Profile'}</button>
            <FilePickerButton
              accept="application/pdf,image/*,.pdf,.heic,.heif,.avif,.tif,.tiff"
              disabled={uploading}
              onChange={uploadDocument}
              label="Upload a PDF or image document"
              className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-red-400"
            >
              <Upload className="h-4 w-4" /> {uploading ? `Uploading ${uploadProgress}%` : 'Upload Document'}
            </FilePickerButton>
            <FilePickerButton
              accept="image/*,.heic,.heif,.avif,.tif,.tiff"
              disabled={uploading}
              onChange={uploadProfilePhoto}
              label="Upload profile photo"
              className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-red-400"
            >
              <Upload className="h-4 w-4" /> Profile Photo
            </FilePickerButton>
          </div>
        </div>
        {uploadError ? <p role="alert" className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">{uploadError}</p> : null}
        {uploadMessage ? <p role="status" className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{uploadMessage}</p> : null}
        {uploading ? (
          <div className="space-y-1" role="status" aria-live="polite">
            <p className="text-sm text-slate-300">Uploading… {uploadProgress}%</p>
            <progress value={uploadProgress || undefined} max="100" aria-label="Upload progress" className="h-2 w-full accent-red-500" />
          </div>
        ) : null}
      </div>

      {showEditor ? (
        <div className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-glass">
          <form onSubmit={updateMember} className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2 flex items-center justify-between">
              <h3 className="text-xl font-semibold text-white">Basic profile</h3>
              <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-emerald-300">Protected</span>
            </div>
            <div>
              <label className="mb-2 block text-sm text-slate-300">Full name</label>
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" />
            </div>
            <div>
              <label className="mb-2 block text-sm text-slate-300">Relationship</label>
              <input value={form.relationship} onChange={(event) => setForm({ ...form, relationship: event.target.value })} className="w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" />
            </div>
            <div>
              <label className="mb-2 block text-sm text-slate-300">Date of Birth</label>
              <input type="date" value={form.dateOfBirth} onChange={(event) => setForm({ ...form, dateOfBirth: event.target.value })} className="w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" />
            </div>
            <div>
              <label className="mb-2 block text-sm text-slate-300">Phone</label>
              <input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} className="w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" />
            </div>
            <div>
              <label className="mb-2 block text-sm text-slate-300">Email</label>
              <input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} className="w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" />
            </div>
            <div>
              <label className="mb-2 block text-sm text-slate-300">Address</label>
              <input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} className="w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" />
            </div>
            <div className="md:col-span-2">
              <label className="mb-2 block text-sm text-slate-300">Notes</label>
              <textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} className="min-h-[120px] w-full rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" />
            </div>
            <div className="md:col-span-2 flex justify-end gap-3">
              <button type="button" onClick={() => setShowEditor(false)} className="rounded-2xl border border-white/10 px-4 py-2.5 text-slate-200">Cancel</button>
              <button type="submit" className="rounded-2xl bg-action-gradient px-4 py-2.5 font-semibold text-white">Save changes</button>
            </div>
          </form>
        </div>
      ) : null}

      <div className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-glass">
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-xl font-semibold text-white">Member documents</h3>
          <FilePickerButton
            accept="application/pdf,image/*,.pdf,.heic,.heif,.avif,.tif,.tiff"
            disabled={uploading}
            onChange={uploadDocument}
            label="Upload a PDF or image document"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl bg-action-gradient px-3 py-2 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            <Upload className="h-4 w-4" /> {uploading ? `Uploading ${uploadProgress}%` : 'Upload'}
          </FilePickerButton>
        </div>
        <div className="grid gap-3">
          {memberDocs.length ? memberDocs.map((doc) => (
            <div key={doc.id} className="min-h-28 rounded-2xl border border-white/10 bg-slate-900/60 p-4 sm:p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div>
                    {editingDocumentId === doc.id ? (
                      <form onSubmit={(event) => saveDocumentName(event, doc.id)} className="flex flex-wrap gap-2">
                        <input autoFocus aria-label="Document name" value={editingDocumentName} onChange={(event) => setEditingDocumentName(event.target.value)} className="min-h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-red-400" />
                        <button type="submit" className="min-h-11 rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white">Save</button>
                        <button type="button" onClick={() => setEditingDocumentId('')} className="min-h-11 rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300">Cancel</button>
                      </form>
                    ) : <p className="break-all text-base font-semibold text-white sm:text-lg">{doc.documentName}</p>}
                    <p className="mt-1 text-sm text-slate-400">{doc.fileSize}</p>
                    {doc.fileUnavailable ? <p className="text-xs text-amber-300">File not found in storage — upload it again.</p> : null}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
                  <button type="button" onClick={() => setSelectedDoc(doc)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-sm text-slate-200 hover:bg-white/5"><Eye className="h-4 w-4" /> View</button>
                  <button type="button" onClick={() => {
                    setEditingDocumentId(doc.id)
                    setEditingDocumentName(doc.documentName)
                  }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-sm text-slate-200 hover:bg-white/5"><Pencil className="h-4 w-4" /> Edit</button>
                  <button type="button" onClick={() => {
                    if (!window.confirm('Permanently delete this document and its stored file?')) return
                    setData((current) => ({
                      ...current,
                      documents: current.documents.filter((entry) => entry.id !== doc.id),
                    }))
                  }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-sm text-red-200 hover:bg-red-500/10"><Trash2 className="h-4 w-4" /> Delete</button>
                  <a href={doc.downloadUrl || doc.previewUrl || undefined} download={doc.originalFilename || doc.documentName} aria-disabled={!doc.previewUrl} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-sm ${doc.previewUrl ? 'text-slate-200 hover:bg-white/5' : 'pointer-events-none text-slate-500'}`}><Download className="h-4 w-4" /> Download</a>
                </div>
              </div>
            </div>
          )) : <div className="rounded-2xl border border-dashed border-white/15 bg-slate-900/40 p-6 text-sm text-slate-400">No documents uploaded for this member yet.</div>}
        </div>
      </div>

      {selectedDoc ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4">
          <div className="w-full max-w-4xl rounded-[30px] border border-white/10 bg-[#171a1f] p-4 shadow-glass">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Document preview</p>
                <h3 className="mt-2 text-xl font-semibold text-white">{selectedDoc.documentName}</h3>
              </div>
              <button type="button" onClick={() => setSelectedDoc(null)} className="rounded-xl border border-white/10 p-2 text-slate-300"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex min-h-[320px] items-center justify-center overflow-hidden rounded-[24px] border border-dashed border-white/10 bg-slate-950/50 p-6 text-center text-slate-300">
              {selectedDoc.fileType === 'pdf' && selectedDoc.previewUrl
                ? <iframe src={selectedDoc.previewUrl} title={selectedDoc.documentName} className="h-[60vh] w-full rounded-2xl bg-white" />
                : selectedDoc.previewUrl
                  ? <img src={selectedDoc.previewUrl} alt={selectedDoc.documentName} className="max-h-[60vh] w-full rounded-2xl object-contain" />
                  : selectedDoc.fileType === 'pdf'
                    ? <FileText className="h-16 w-16 text-red-400" />
                    : <FileImage className="h-16 w-16 text-red-400" />}
            </div>
            <div className="mt-4 flex justify-end gap-3">
              <button type="button" onClick={() => setSelectedDoc(null)} className="rounded-2xl border border-white/10 px-4 py-2 text-slate-200">Close</button>
              <button type="button" onClick={() => selectedDoc.previewUrl && window.open(selectedDoc.previewUrl, '_blank', 'noopener,noreferrer')} className="rounded-2xl bg-action-gradient px-4 py-2 font-semibold text-white">Download</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function CommonDocumentsPage({ data, setData }) {
  const [search, setSearch] = useState('')
  const [uploadError, setUploadError] = useState('')
  const [uploadMessage, setUploadMessage] = useState('')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [editingDocumentId, setEditingDocumentId] = useState('')
  const [editingDocumentName, setEditingDocumentName] = useState('')
  const commonDocuments = data.documents.filter((document) => !document.memberId && !document.isDeleted)
  const filtered = commonDocuments.filter((doc) => doc.documentName.toLowerCase().includes(search.toLowerCase()))

  const uploadDocument = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    setUploadError('')
    setUploadMessage('')
    setUploadProgress(0)
    setUploading(true)
    try {
      const doc = await createDocumentUpload({
        file,
        documentName: file.name.replace(/\.[^.]+$/, '') || file.name,
        memberId: null,
        familyId: data.family.id,
        category: 'Other',
        notes: 'Family shared document',
        isImportant: false,
        folder: 'common',
        onProgress: setUploadProgress,
      })
      const saved = await setData((current) => ({ ...current, documents: [doc, ...current.documents] }))
      if (saved === false) {
        throw new Error('The file uploaded to Storage, but its document record could not be saved to the database. Check the sync error and retry saving.')
      }
      setUploadProgress(100)
      setUploadMessage(`${file.name} uploaded successfully.`)
    } catch (error) {
      reportUploadError(error, setUploadError, 'Upload failed')
    } finally {
      setUploading(false)
      event.target.value = ''
    }
  }

  const saveDocumentName = (event, documentId) => {
    event.preventDefault()
    const documentName = editingDocumentName.trim()
    if (!documentName) return
    setData((current) => ({
      ...current,
      documents: current.documents.map((entry) => (entry.id === documentId
        ? { ...entry, documentName, updatedAt: new Date().toISOString() }
        : entry)),
    }))
    setEditingDocumentId('')
    setEditingDocumentName('')
  }

  return (
    <div className="space-y-6">
      <div className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-glass">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Family shared vault</p>
            <h2 className="mt-2 text-3xl font-semibold text-white">Common documents</h2>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input value={search} onChange={(event) => setSearch(event.target.value)} className="rounded-2xl border border-white/10 bg-slate-900/70 px-3 py-2.5 text-white" placeholder="Search common docs" />
            <FilePickerButton
              accept="application/pdf,image/*,.pdf,.heic,.heif,.avif,.tif,.tiff"
              disabled={uploading}
              onChange={uploadDocument}
              label="Upload a PDF or image document"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl bg-action-gradient px-4 py-2.5 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-red-400"
            >
              <Upload className="h-4 w-4" /> {uploading ? `Uploading ${uploadProgress}%` : 'Upload'}
            </FilePickerButton>
          </div>
        </div>
        {uploadError ? <p role="alert" className="mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">{uploadError}</p> : null}
        {uploadMessage ? <p role="status" className="mt-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{uploadMessage}</p> : null}
        {uploading ? (
          <div className="mt-4 space-y-1" role="status" aria-live="polite">
            <p className="text-sm text-slate-300">Uploading… {uploadProgress}%</p>
            <progress value={uploadProgress || undefined} max="100" aria-label="Upload progress" className="h-2 w-full accent-red-500" />
          </div>
        ) : null}
      </div>

      <div className="mx-auto grid w-full max-w-5xl gap-3 sm:gap-4">
        {filtered.map((doc) => (
          <div key={doc.id} className="min-h-28 rounded-2xl border border-white/10 bg-white/[0.045] p-4 shadow-glass sm:p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
              {editingDocumentId === doc.id ? (
                <form onSubmit={(event) => saveDocumentName(event, doc.id)} className="flex flex-wrap gap-2">
                  <input autoFocus aria-label="Document name" value={editingDocumentName} onChange={(event) => setEditingDocumentName(event.target.value)} className="min-h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-red-400" />
                  <button type="submit" className="min-h-11 rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white">Save</button>
                  <button type="button" onClick={() => setEditingDocumentId('')} className="min-h-11 rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300">Cancel</button>
                </form>
              ) : <h3 className="break-all text-base font-semibold text-white sm:text-lg">{doc.documentName}</h3>}
                <p className="mt-1 text-sm text-slate-400">{doc.fileSize}</p>
                {doc.fileUnavailable ? <p className="mt-1 text-xs text-amber-300">File not found in storage — upload it again.</p> : null}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
              <button type="button" onClick={() => doc.previewUrl && window.open(doc.previewUrl, '_blank', 'noopener,noreferrer')} disabled={!doc.previewUrl} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-sm text-slate-200 enabled:hover:bg-white/5 disabled:text-slate-500"><Eye className="h-4 w-4" /> View</button>
              <button type="button" onClick={() => {
                setEditingDocumentId(doc.id)
                setEditingDocumentName(doc.documentName)
              }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-sm text-slate-200 hover:bg-white/5"><Pencil className="h-4 w-4" /> Edit</button>
              <button type="button" onClick={() => {
                if (!window.confirm('Permanently delete this document and its stored file?')) return
                setData((current) => ({
                  ...current,
                  documents: current.documents.filter((entry) => entry.id !== doc.id),
                }))
              }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-sm text-red-200 hover:bg-red-500/10"><Trash2 className="h-4 w-4" /> Delete</button>
              <a href={doc.downloadUrl || doc.previewUrl || undefined} download={doc.originalFilename || doc.documentName} aria-disabled={!doc.previewUrl} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-sm ${doc.previewUrl ? 'text-slate-200 hover:bg-white/5' : 'pointer-events-none text-slate-500'}`}><Download className="h-4 w-4" /> Download</a>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SettingsPage({ data }) {
  const { logout } = useAuth()
  const [theme, setTheme] = useState('dark')
  const navigate = useNavigate()

  const handleLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="space-y-6">
      <div className="rounded-[30px] border border-white/10 bg-white/5 p-5 shadow-glass">
        <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Preferences</p>
        <h2 className="mt-2 text-3xl font-semibold text-white">Settings</h2>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-glass">
          <h3 className="text-xl font-semibold text-white">Account settings</h3>
          <div className="mt-5 space-y-4 text-sm text-slate-300">
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3">Family login email: {data.family.ownerEmail}</div>
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3">Change password: managed through Supabase Auth or secure reset flow.</div>
            <button type="button" onClick={() => alert('Password reset email sent to family owner.')} className="w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-left text-white">Reset password</button>
            <button type="button" onClick={handleLogout} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-action-gradient px-3 py-3 font-semibold text-white"><LogOut className="h-4 w-4" /> Logout</button>
          </div>
        </section>

        <section className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-glass">
          <h3 className="text-xl font-semibold text-white">Storage & appearance</h3>
          <div className="mt-5 space-y-4 text-sm text-slate-300">
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3"><span className="text-slate-400">Total documents:</span> {data.documents.filter((document) => !document.isDeleted).length}</div>
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3"><span className="text-slate-400">Total storage used:</span> {data.documents.filter((document) => !document.isDeleted).reduce((total, doc) => total + parseFloat(doc.fileSize) || 0, 0).toFixed(1)} MB</div>
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3"><span className="text-slate-400">Supported file types:</span> PDF, JPG, JPEG, PNG, WEBP</div>
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3 flex items-center justify-between">
              <span>Theme</span>
              <select value={theme} onChange={(event) => setTheme(event.target.value)} className="rounded-xl border border-white/10 bg-slate-800 px-3 py-2 text-white">
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function getGreeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Morning'
  if (hour < 18) return 'Afternoon'
  return 'Evening'
}

export default App
