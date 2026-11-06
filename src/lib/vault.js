import { supabase, supabaseUrl } from './supabase.js'

const STORAGE_BUCKET = 'family-documents'
const MAX_DOCUMENT_SIZE = 100 * 1024 * 1024
const MAX_IMAGE_SIZE = 25 * 1024 * 1024
const RESUMABLE_UPLOAD_THRESHOLD = 6 * 1024 * 1024
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|bmp|svg|heic|heif|avif|tiff?)$/i

function getContentType(file) {
  if (file.type) return file.type
  if (/\.pdf$/i.test(file.name)) return 'application/pdf'
  if (/\.heic$/i.test(file.name)) return 'image/heic'
  if (/\.heif$/i.test(file.name)) return 'image/heif'
  if (/\.avif$/i.test(file.name)) return 'image/avif'
  if (/\.jpe?g$/i.test(file.name)) return 'image/jpeg'
  if (/\.png$/i.test(file.name)) return 'image/png'
  if (/\.webp$/i.test(file.name)) return 'image/webp'
  if (/\.gif$/i.test(file.name)) return 'image/gif'
  if (/\.bmp$/i.test(file.name)) return 'image/bmp'
  if (/\.tiff?$/i.test(file.name)) return 'image/tiff'
  if (/\.svg$/i.test(file.name)) return 'image/svg+xml'
  return 'application/octet-stream'
}

function throwOnError(result) {
  if (result.error) throw result.error
  return result.data
}

async function signedUrl(path, userId, options = {}) {
  if (!path) return ''

  const candidates = [path]
  const bucketPrefix = `${STORAGE_BUCKET}/`
  if (path.startsWith(bucketPrefix)) candidates.push(path.slice(bucketPrefix.length))
  if (userId) {
    for (const candidate of [...candidates]) {
      if (!candidate.startsWith(`${userId}/`)) candidates.push(`${userId}/${candidate}`)
      else candidates.push(candidate.slice(userId.length + 1))
    }
  }

  let notFoundError
  for (const candidate of [...new Set(candidates)]) {
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(candidate, 60 * 60, options)
    if (!error) return data.signedUrl
    if (error.statusCode === 404 || error.statusCode === '404' || /object not found/i.test(error.message || '')) {
      notFoundError = error
      continue
    }
    throw error
  }

  if (notFoundError) {
    console.warn(`No Storage object found for saved path "${path}". The vault data loaded, but this file preview is unavailable.`)
  }
  return ''
}

export function validateVaultFile(file, { imagesOnly = false } = {}) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
  const isImage = file.type.startsWith('image/') || IMAGE_EXTENSIONS.test(file.name)

  if (imagesOnly && !isImage) {
    throw new Error('Choose an image file.')
  }
  if (!isPdf && !isImage) {
    throw new Error('Choose a PDF or image file.')
  }
  const maxSize = isImage ? MAX_IMAGE_SIZE : MAX_DOCUMENT_SIZE
  if (file.size > maxSize) {
    const maxSizeLabel = isImage ? '25 MB' : '100 MB'
    const error = new Error(`${isImage ? 'Images' : 'Documents'} must be ${maxSizeLabel} or smaller.`)
    error.code = 'FILE_TOO_LARGE'
    throw error
  }
}

async function resumableUpload(path, file, accessToken) {
  const { Upload } = await import('tus-js-client')
  const url = new URL(supabaseUrl)
  const hostname = url.hostname.endsWith('.supabase.co')
    ? url.hostname.replace(/\.supabase\.co$/, '.storage.supabase.co')
    : url.host
  const endpoint = `${url.protocol}//${hostname}/storage/v1/upload/resumable`

  return new Promise((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-upsert': 'false',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      storeFingerprintForResuming: false,
      metadata: {
        bucketName: STORAGE_BUCKET,
        objectName: path,
        contentType: getContentType(file),
        cacheControl: '3600',
      },
      chunkSize: RESUMABLE_UPLOAD_THRESHOLD,
      onError: (error) => {
        if (error.originalResponse?.getStatus() === 413) {
          reject(new Error('Supabase rejected this file size. Increase the project-wide Storage upload limit to at least 100 MB and try again.'))
          return
        }
        reject(error)
      },
      onSuccess: resolve,
    })
    upload.start()
  })
}

export async function uploadVaultFile(file, familyId, folder) {
  validateVaultFile(file, { imagesOnly: folder.startsWith('profiles/') || folder.startsWith('passports/') })

  const { data: { session }, error: authError } = await supabase.auth.getSession()
  if (authError) throw authError
  if (!session) throw new Error('Sign in before uploading files.')

  const fileName = file.name.replace(/[^\w.-]/g, '_') || 'upload'
  const path = `${session.user.id}/${familyId}/${folder}/${crypto.randomUUID()}-${fileName}`
  if (file.size > RESUMABLE_UPLOAD_THRESHOLD) {
    await resumableUpload(path, file, session.access_token)
  } else {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, {
      contentType: getContentType(file),
      upsert: false,
    })
    if (error) {
      if (error.code === '42501' || /row-level security/i.test(error.message || '')) {
        throw new Error('Supabase Storage blocked this upload. Run the latest supabase/schema.sql in the Supabase SQL Editor, then try again.')
      }
      if (error.statusCode === '413' || /payload too large/i.test(error.message || '')) {
        throw new Error('Supabase rejected this file size. Check your project-wide Storage upload limit; it must allow files up to 100 MB.')
      }
      throw error
    }
  }
  const [url, downloadUrl] = await Promise.all([
    signedUrl(path),
    signedUrl(path, undefined, { download: file.name }),
  ])
  return { path, url, downloadUrl }
}

export async function loadFamilyVault(user) {
  const familyResult = await supabase
    .from('families')
    .select('id, name, owner_user_id')
    .eq('owner_user_id', user.id)
    .maybeSingle()
  let family = throwOnError(familyResult)

  if (!family) {
    family = throwOnError(await supabase
      .from('families')
      .insert({ name: 'My Family', owner_user_id: user.id })
      .select('id, name, owner_user_id')
      .single())
  }

  const [membersResult, documentsResult, passportsResult] = await Promise.all([
    supabase.from('family_members').select('*').eq('family_id', family.id).order('created_at', { ascending: false }),
    supabase.from('documents').select('*').eq('family_id', family.id).order('created_at', { ascending: false }),
    supabase.from('passports').select('*').eq('family_id', family.id).order('created_at', { ascending: false }),
  ])
  const members = throwOnError(membersResult) || []
  const documents = throwOnError(documentsResult) || []
  const passports = throwOnError(passportsResult) || []

  return {
    family: { id: family.id, name: family.name, ownerEmail: user.email || '' },
    members: await Promise.all(members.map(async (row) => ({
      id: row.id,
      familyId: row.family_id,
      name: row.name,
      relationship: row.relationship || '',
      dateOfBirth: row.date_of_birth || '',
      phone: row.phone || '',
      email: row.email || '',
      address: row.address || '',
      profilePhotoPath: row.profile_photo_path || '',
      profilePhoto: await signedUrl(row.profile_photo_path, user.id),
      notes: row.notes || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))),
    documents: await Promise.all(documents.map(async (row) => {
      const previewUrl = row.is_deleted ? '' : await signedUrl(row.storage_path, user.id)
      const downloadUrl = row.is_deleted
        ? ''
        : await signedUrl(row.storage_path, user.id, { download: row.original_filename || row.document_name })
      return {
        id: row.id,
        familyId: row.family_id,
        memberId: row.member_id,
        documentName: row.document_name,
        category: row.category || 'Other',
        originalFilename: row.original_filename || '',
        storagePath: row.storage_path,
        fileType: row.file_type || 'other',
        fileSize: row.file_size || '',
        notes: row.notes || '',
        isImportant: row.is_important,
        isDeleted: row.is_deleted,
        fileUnavailable: !row.is_deleted && !previewUrl,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        previewUrl,
        downloadUrl,
      }
    })),
    passports: await Promise.all(passports.map(async (row) => ({
      id: row.id,
      familyId: row.family_id,
      memberId: row.member_id,
      passportNumber: row.passport_number,
      fullName: row.full_name,
      dateOfBirth: row.date_of_birth || '',
      nationality: row.nationality || '',
      gender: row.gender || '',
      placeOfBirth: row.place_of_birth || '',
      placeOfIssue: row.place_of_issue || '',
      issueDate: row.issue_date || '',
      expiryDate: row.expiry_date || '',
      passportType: row.passport_type || '',
      documentId: row.document_id,
      passportImagePath: row.passport_image_path || '',
      passportImage: await signedUrl(row.passport_image_path, user.id),
      notes: row.notes || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))),
  }
}

function memberRow(member, familyId) {
  return {
    id: member.id,
    family_id: familyId,
    name: member.name,
    relationship: member.relationship || null,
    date_of_birth: member.dateOfBirth || null,
    phone: member.phone || null,
    email: member.email || null,
    address: member.address || null,
    profile_photo_path: member.profilePhotoPath || null,
    notes: member.notes || null,
    updated_at: member.updatedAt || new Date().toISOString(),
  }
}

function documentRow(document, familyId) {
  return {
    id: document.id,
    family_id: familyId,
    member_id: document.memberId || null,
    document_name: document.documentName,
    category: document.category || null,
    original_filename: document.originalFilename || null,
    storage_path: document.storagePath,
    file_type: document.fileType || null,
    file_size: document.fileSize || null,
    notes: document.notes || null,
    is_important: Boolean(document.isImportant),
    is_deleted: Boolean(document.isDeleted),
    updated_at: document.updatedAt || new Date().toISOString(),
  }
}

function passportRow(passport, familyId) {
  return {
    id: passport.id,
    family_id: familyId,
    member_id: passport.memberId,
    passport_number: passport.passportNumber,
    full_name: passport.fullName,
    date_of_birth: passport.dateOfBirth || null,
    nationality: passport.nationality || null,
    gender: passport.gender || null,
    place_of_birth: passport.placeOfBirth || null,
    place_of_issue: passport.placeOfIssue || null,
    issue_date: passport.issueDate || null,
    expiry_date: passport.expiryDate || null,
    passport_type: passport.passportType || null,
    document_id: passport.documentId || null,
    passport_image_path: passport.passportImagePath || null,
    notes: passport.notes || null,
    updated_at: passport.updatedAt || new Date().toISOString(),
  }
}

async function removeRows(table, rows, familyId) {
  if (!rows.length) return
  const { error } = await supabase.from(table).delete().eq('family_id', familyId).in('id', rows.map((row) => row.id))
  if (error) throw error
}

async function upsertRows(table, rows) {
  if (!rows.length) return
  const { error } = await supabase.from(table).upsert(rows)
  if (error) throw error
}

function changedRows(before, after, serialize) {
  const previous = new Map(before.map((row) => [row.id, JSON.stringify(serialize(row))]))
  return after.filter((row) => previous.get(row.id) !== JSON.stringify(serialize(row)))
}

export async function persistVaultChanges(previous, next) {
  const familyId = next.family?.id
  if (!familyId) throw new Error('The family vault has not finished loading.')

  const removedDocuments = previous.documents.filter((row) => !next.documents.some((item) => item.id === row.id))
  const removedPassports = previous.passports.filter((row) => !next.passports.some((item) => item.id === row.id))
  const removedMembers = previous.members.filter((row) => !next.members.some((item) => item.id === row.id))

  await removeRows('documents', removedDocuments, familyId)
  await removeRows('passports', removedPassports, familyId)
  await removeRows('family_members', removedMembers, familyId)

  const removedPaths = [
    ...removedDocuments.map((row) => row.storagePath),
    ...removedMembers.map((row) => row.profilePhotoPath),
    ...removedPassports.map((row) => row.passportImagePath),
  ].filter(Boolean)
  if (removedPaths.length) {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(removedPaths)
    if (error) throw error
  }

  await upsertRows('family_members', changedRows(previous.members, next.members, (row) => memberRow(row, familyId)).map((row) => memberRow(row, familyId)))
  await upsertRows('documents', changedRows(previous.documents, next.documents, (row) => documentRow(row, familyId)).map((row) => documentRow(row, familyId)))
  await upsertRows('passports', changedRows(previous.passports, next.passports, (row) => passportRow(row, familyId)).map((row) => passportRow(row, familyId)))

  const replacedPaths = [
    ...previous.members.flatMap((row) => {
      const current = next.members.find((item) => item.id === row.id)
      return row.profilePhotoPath && current && row.profilePhotoPath !== current.profilePhotoPath ? [row.profilePhotoPath] : []
    }),
    ...previous.passports.flatMap((row) => {
      const current = next.passports.find((item) => item.id === row.id)
      return row.passportImagePath && current && row.passportImagePath !== current.passportImagePath ? [row.passportImagePath] : []
    }),
  ]
  if (replacedPaths.length) {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(replacedPaths)
    if (error) throw error
  }
}
