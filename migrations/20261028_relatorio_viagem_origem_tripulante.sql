ALTER TABLE relatorio_despesa_viagem
  ADD COLUMN origem_criacao TEXT NOT NULL DEFAULT 'financeiro';

CREATE UNIQUE INDEX IF NOT EXISTS idx_relatorio_viagem_voo_tripulante_unico
  ON relatorio_despesa_viagem(numero_voo, aeronave_id, cliente_id, COALESCE(NULLIF(trim(socio_id), ''), ''))
  WHERE origem_criacao = 'tripulante'
    AND numero_voo IS NOT NULL
    AND trim(numero_voo) <> '';
