import type { D1Database } from "@cloudflare/workers-types"

export async function garantirTabelasFinanceiras(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS rateios_cotistas (
      id TEXT PRIMARY KEY NOT NULL,
      lancamento_id TEXT NOT NULL,
      cotista TEXT NOT NULL,
      percentual REAL NOT NULL CHECK (percentual >= 0 AND percentual <= 100),
      valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lancamento_id) REFERENCES lancamentos(id) ON DELETE CASCADE,
      FOREIGN KEY (cotista) REFERENCES cotistas(id) ON UPDATE CASCADE
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS rateios_cotistas_lancamento_idx ON rateios_cotistas(lancamento_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS rateios_cotistas_cotista_idx ON rateios_cotistas(cotista)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS holdings (
      id TEXT PRIMARY KEY NOT NULL,
      nome TEXT NOT NULL,
      conta_bancaria TEXT,
      ativo INTEGER NOT NULL DEFAULT 1
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hold_socios (
      id TEXT PRIMARY KEY NOT NULL,
      holding_id TEXT NOT NULL,
      cotista_id TEXT NOT NULL,
      percentual REAL NOT NULL CHECK (percentual >= 0),
      FOREIGN KEY (holding_id) REFERENCES holdings(id)
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS hold_socios_holding_idx ON hold_socios(holding_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS hold_socios_cotista_idx ON hold_socios(cotista_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS movimentos_holding (
      id TEXT PRIMARY KEY NOT NULL,
      holding_id TEXT NOT NULL,
      lancamento_id TEXT,
      data TEXT NOT NULL,
      tipo TEXT NOT NULL,
      cotista_id TEXT,
      valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
      descricao TEXT,
      FOREIGN KEY (holding_id) REFERENCES holdings(id),
      FOREIGN KEY (lancamento_id) REFERENCES lancamentos(id)
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS movimentos_holding_holding_idx ON movimentos_holding(holding_id, data)"),
    db.prepare("CREATE INDEX IF NOT EXISTS movimentos_holding_cotista_idx ON movimentos_holding(cotista_id, data)"),
  ])
}
