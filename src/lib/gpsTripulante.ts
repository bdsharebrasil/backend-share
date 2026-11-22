export type PontoGps = { id: string; lat: number; lon: number; registrado_em: string; precisao_m: number; alt_ft: number | null; gs_kt: number | null; rumo_graus: number | null }
export function validarPontosGps(value: unknown, agora = Date.now()): PontoGps[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new Error('Envie entre 1 e 100 posições.')
  const n = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
  return value.map(p => {
    const ts = typeof p?.registrado_em === 'string' ? Date.parse(p.registrado_em) : NaN
    if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id)
      || !n(p.lat, -90, 90) || !n(p.lon, -180, 180) || !n(p.precisao_m, 0, 200)
      || !Number.isFinite(ts) || ts > agora + 60_000 || ts < agora - 7 * 86400_000
      || (p.alt_ft != null && !n(p.alt_ft, -1500, 65000))
      || (p.gs_kt != null && !n(p.gs_kt, 0, 1200)) || (p.rumo_graus != null && !n(p.rumo_graus, 0, 360))) throw new Error('Posição GPS inválida, antiga ou sem precisão suficiente.')
    return { id: p.id, lat: p.lat, lon: p.lon, registrado_em: new Date(ts).toISOString(), precisao_m: p.precisao_m, alt_ft: p.alt_ft ?? null, gs_kt: p.gs_kt ?? null, rumo_graus: p.rumo_graus ?? null }
  })
}
