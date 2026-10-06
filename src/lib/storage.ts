type StorageContext = {
  env: {
    FILES: R2Bucket
    SHARE_FILES?: R2Bucket
  }
}

export function shareBrasilBucket(c: StorageContext): R2Bucket {
  return c.env.SHARE_FILES || c.env.FILES
}

export function shareBrasilFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180)
}

export function normalizarPastaUpload(value: unknown, fallback = 'geral'): string {
  const folder = String(value ?? fallback).trim().replace(/^\/+|\/+$/g, '')
  if (!folder || folder.length > 120 || folder.split('/').some(segment => !/^[a-zA-Z0-9_-]+$/.test(segment))) {
    throw new Error('pasta_invalida')
  }
  return folder
}

export async function salvarArquivoShareBrasil(
  c: StorageContext,
  userId: string,
  file: File,
  pasta: string,
): Promise<string> {
  if (!file.size) throw new Error('arquivo_vazio')
  if (file.size > 25 * 1024 * 1024) throw new Error('arquivo_excede_25mb')
  const pastaNormalizada = pasta.replace(/^\/+/, '').replace(/^share\/+/, '')
  const key = `share/${pastaNormalizada}/${userId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${shareBrasilFileName(file.name)}`
  await shareBrasilBucket(c).put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  })
  return key
}

export function chaveStorageDeUrl(valor: unknown): string {
  const bruto = String(valor ?? '').trim()
  if (!bruto) return ''
  try {
    const url = new URL(bruto)
    const queryKey = url.searchParams.get('key')
    if (queryKey) return queryKey
    const caminho = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const marcador = caminho.indexOf('share/')
    return marcador >= 0 ? caminho.slice(marcador) : caminho
  } catch {
    return bruto.replace(/^\/+/, '')
  }
}
