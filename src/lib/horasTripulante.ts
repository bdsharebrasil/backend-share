import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

export function filtrosHoras(query: Record<string, string | undefined>) {
  for (const campo of ['inicio', 'fim'] as const) {
    const valor = query[campo]
    if (valor && (!/^\d{4}-\d{2}-\d{2}$/.test(valor) || !Number.isFinite(Date.parse(valor)) || new Date(valor).toISOString().slice(0, 10) !== valor)) {
      throw new Error('Informe datas válidas no formato AAAA-MM-DD.')
    }
  }
  if (query.inicio && query.fim && query.inicio > query.fim) throw new Error('A data inicial deve ser anterior ou igual à final.')
  return { inicio: query.inicio || null, fim: query.fim || null, aeronave_id: query.aeronave_id || null }
}
type Filtros = ReturnType<typeof filtrosHoras>
type Usuario = { id: string; canac?: string | null }
type Registro = { id: string; aeronave_id: string; matricula: string; data: string; numero_voo: string; origem: string; destino: string; tempo_voo: number; tempo_total: number; assinado: number }
const minutos = (v: unknown) => Math.round(Math.max(0, Number(v) || 0) * 60)
export const horasMinutos = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`

// A identidade é sempre extraída da sessão. Não há seleção de outro usuário.
// CANAC legado só é aceito se não estiver vinculado a outra conta.
const base = `FROM lancamentos_diario_bordo l LEFT JOIN aeronave a ON a.id = l.aeronave_id
    WHERE (EXISTS (SELECT 1 FROM tripulacao t WHERE
      (t.user_id = ?1 OR (t.user_id IS NULL AND NULLIF(TRIM(?2), '') IS NOT NULL AND lower(trim(t.canac)) = lower(trim(?2))
        AND NOT EXISTS (SELECT 1 FROM tripulacao outra WHERE outra.user_id IS NOT NULL AND outra.user_id <> ?1 AND lower(trim(outra.canac)) = lower(trim(?2)))))
      AND (lower(trim(l.pic_canac)) IN (lower(NULLIF(trim(t.canac), '')), lower(trim(t.id)))
        OR lower(trim(l.sic_canac)) IN (lower(NULLIF(trim(t.canac), '')), lower(trim(t.id)))))
      OR (NULLIF(TRIM(?2), '') IS NOT NULL
        AND (lower(trim(l.pic_canac)) = lower(trim(?2)) OR lower(trim(l.sic_canac)) = lower(trim(?2)))
        AND NOT EXISTS (SELECT 1 FROM tripulacao outra WHERE outra.user_id IS NOT NULL AND outra.user_id <> ?1 AND lower(trim(outra.canac)) = lower(trim(?2)))))`

export function resumoHorasPerfil(db: D1Database, usuario: Usuario, competencia: string) {
  return db.prepare(`WITH voos AS (
    SELECT substr(l.data_registro, 1, 7) AS mes,
      ROUND(MAX(COALESCE(l.tempo_voo, 0), 0) * 60) AS minutos ${base}
  ) SELECT COALESCE(SUM(minutos), 0) AS total,
      COALESCE(SUM(CASE WHEN mes = ?3 THEN minutos END), 0) AS mes,
      COALESCE(SUM(CASE WHEN substr(mes, 1, 4) = substr(?3, 1, 4) THEN minutos END), 0) AS ano
    FROM voos`).bind(usuario.id, usuario.canac || '', competencia).first<{ total: number; mes: number; ano: number }>()
}

export async function consultarHoras(db: D1Database, usuario: Usuario, filtros: Filtros) {
  const aeronaves = await db.prepare(`SELECT DISTINCT l.aeronave_id AS id, COALESCE(a.matricula_registro, 'Sem matrícula') AS matricula ${base} ORDER BY matricula`)
    .bind(usuario.id, usuario.canac || '').all<{ id: string; matricula: string }>()
  const rows = await db.prepare(`SELECT l.id, l.aeronave_id, COALESCE(a.matricula_registro, 'Sem matrícula') AS matricula,
      substr(l.data_registro, 1, 10) AS data, l.numero_voo, l.aerodromo_partida AS origem, l.aerodromo_chegada AS destino,
      COALESCE(l.tempo_voo, 0) AS tempo_voo, COALESCE(l.tempo_total, 0) AS tempo_total,
      CASE WHEN COALESCE(l.confirmado, 0) <> 0 OR NULLIF(trim(l.assinado_pic), '') IS NOT NULL THEN 1 ELSE 0 END AS assinado
      ${base} AND (?3 IS NULL OR substr(l.data_registro, 1, 10) >= ?3)
      AND (?4 IS NULL OR substr(l.data_registro, 1, 10) <= ?4) AND (?5 IS NULL OR l.aeronave_id = ?5)
      ORDER BY l.data_registro DESC, l.numero_sequencial DESC, l.id`)
    .bind(usuario.id, usuario.canac || '', filtros.inicio, filtros.fim, filtros.aeronave_id).all<Registro>()
  const registros = (rows.results || []).map(r => ({ ...r, minutos_voo: minutos(r.tempo_voo), minutos_totais: minutos(r.tempo_total) }))
  const resumo = { minutos_voo: 0, minutos_totais: 0, lancamentos: registros.length, rascunhos: 0 }
  type Grupo = { id: string; rotulo: string; minutos_voo: number; minutos_totais: number; lancamentos: number }
  const porAeronave = new Map<string, Grupo>(), porMes = new Map<string, Grupo>()
  for (const r of registros) {
    resumo.minutos_voo += r.minutos_voo; resumo.minutos_totais += r.minutos_totais; resumo.rascunhos += r.assinado ? 0 : 1
    for (const [map, id, rotulo] of [[porAeronave, r.aeronave_id, r.matricula], [porMes, r.data?.slice(0, 7) || 'Sem data', r.data?.slice(0, 7) || 'Sem data']] as const) {
      const g = map.get(id) || { id, rotulo, minutos_voo: 0, minutos_totais: 0, lancamentos: 0 }
      g.minutos_voo += r.minutos_voo; g.minutos_totais += r.minutos_totais; g.lancamentos++; map.set(id, g)
    }
  }
  return { filtros, resumo, aeronaves: aeronaves.results || [], por_aeronave: [...porAeronave.values()], por_mes: [...porMes.values()].sort((a,b) => b.id.localeCompare(a.id)), registros }
}

export async function pdfHoras(dados: Awaited<ReturnType<typeof consultarHoras>>, nome: string) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  let page = pdf.addPage([595, 842]), y = 790
  const clean = (s: string) => Array.from(s).map(c => { try { font.encodeText(c); return c } catch { return '?' } }).join('')
  const line = (value: string, destaque = false) => {
    const text = clean(value)
    const words = text.split(/\s+/); let buffer = ''
    const draw = (v: string) => {
      if (y < 55) { page = pdf.addPage([595, 842]); y = 790 }
      page.drawText(v, { x: 40, y, size: 10, font: destaque ? bold : font, color: rgb(.12,.15,.19) }); y -= 18
    }
    for (const word of words) {
      const next = buffer ? `${buffer} ${word}` : word
      if ((destaque ? bold : font).widthOfTextAtSize(next, 10) > 510 && buffer) { draw(buffer); buffer = word } else buffer = next
    }
    draw(buffer)
  }
  line('TRIP SHARE | RELATÓRIO DE HORAS', true); line(nome)
  line(`Período: ${dados.filtros.inicio || 'Início do histórico'} a ${dados.filtros.fim || 'Fim do histórico'}`)
  line(`Aeronave: ${dados.aeronaves.find(a => a.id === dados.filtros.aeronave_id)?.matricula || (dados.filtros.aeronave_id ? 'Sem lançamentos' : 'Todas')}`)
  line(`Horas de voo (DEP-POU): ${horasMinutos(dados.resumo.minutos_voo)} | Horas totais (AC-COR): ${horasMinutos(dados.resumo.minutos_totais)}`, true)
  line(`${dados.resumo.lancamentos} lançamentos | ${dados.resumo.rascunhos} rascunhos incluídos`)
  line('Valores em horas:minutos. Rascunhos sujeitos à conferência do comandante.'); y -= 12
  for (const [title, groups] of [['POR AERONAVE', dados.por_aeronave], ['POR MÊS', dados.por_mes]] as const) {
    line(title, true)
    for (const g of groups) line(`${g.rotulo} | Voo ${horasMinutos(g.minutos_voo)} | Total ${horasMinutos(g.minutos_totais)} | ${g.lancamentos} lançamentos`)
    y -= 12
  }
  line('LANÇAMENTOS', true)
  for (const r of dados.registros) {
    line(`${r.data} | ${r.numero_voo || '-'} | ${r.matricula} | ${r.origem || '-'} > ${r.destino || '-'}`)
    line(`Voo ${horasMinutos(r.minutos_voo)} | Total ${horasMinutos(r.minutos_totais)} | ${r.assinado ? 'Assinado' : 'Rascunho'}`)
  }
  if (!dados.registros.length) line('Nenhum lançamento no período selecionado.')
  for (const [i, p] of pdf.getPages().entries()) p.drawText(`${i + 1} / ${pdf.getPageCount()}`, { x: 510, y: 25, size: 9, font })
  return pdf.save()
}
