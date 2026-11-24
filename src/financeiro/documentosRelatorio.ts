type Row = Record<string, unknown>

/** Converte chaves R2 antigas em rotas autenticadas, sem alterar os dados salvos. */
export async function documentosRelatorio(db: D1Database, rows: Row[]): Promise<Row[]> {
  const chaves = [...new Set(rows.flatMap(row => [...[row.url_doc, row.documentoUrl].filter(v => typeof v === 'string' && !/^(https?:\/\/|\/api\/)/i.test(v)),
    row.origem_tipo === 'RELATORIO_DESPESA_VIAGEM' ? row.origem_id : null,
    row.lancamento_origem_tipo === 'RELATORIO_DESPESA_VIAGEM' ? row.lancamento_origem_id : null,
  ]).filter((v): v is string => typeof v === 'string' && !!v.trim()))]
  const porId = new Map<string, string>()
  const porCaminho = new Map<string, string>()
  // D1 aceita até 100 parâmetros por consulta.
  for (let i = 0; i < chaves.length; i += 40) {
    const parte = chaves.slice(i, i + 40)
    const marcadores = parte.map(() => '?').join(',')
    const result = await db.prepare(`SELECT id, pdf_path FROM relatorio_despesa_viagem
      WHERE (id IN (${marcadores}) OR pdf_path IN (${marcadores})) AND NULLIF(TRIM(pdf_path), '') IS NOT NULL`)
      .bind(...parte, ...parte).all<{ id: string; pdf_path: string }>()
    for (const relatorio of result.results ?? []) {
      const url = `/api/financeiro/relatorios-despesa-viagem/${encodeURIComponent(relatorio.id)}/pdf`
      porId.set(relatorio.id, url)
      porCaminho.set(relatorio.pdf_path, url)
    }
  }
  return rows.map(row => {
    const porOrigem = row.origem_tipo === 'RELATORIO_DESPESA_VIAGEM' ? porId.get(String(row.origem_id)) : undefined
    const porLancamento = row.lancamento_origem_tipo === 'RELATORIO_DESPESA_VIAGEM' ? porId.get(String(row.lancamento_origem_id)) : undefined
    const url = porOrigem ?? porLancamento ?? porCaminho.get(String(row.url_doc)) ?? porCaminho.get(String(row.documentoUrl))
    if (!url) return row
    return { ...row, relatorio_pdf_url: url,
      url_doc: porCaminho.get(String(row.url_doc)) ?? row.url_doc ?? url,
      documentoUrl: porCaminho.get(String(row.documentoUrl)) ?? row.documentoUrl ?? url,
    }
  })
}

/** Instalações antigas podem não ter a coluna opcional de anexos. */
export async function colunaAnexosLancamento(db: D1Database): Promise<string> {
  const existe = await db.prepare("SELECT name FROM pragma_table_info('lancamentos') WHERE name = 'anexos_json'").first()
  return existe ? 'l.anexos_json' : 'NULL AS anexos_json'
}
