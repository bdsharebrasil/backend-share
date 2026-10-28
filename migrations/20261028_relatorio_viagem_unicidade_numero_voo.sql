DROP INDEX IF EXISTS idx_relatorio_viagem_voo_tripulante_unico;

CREATE UNIQUE INDEX IF NOT EXISTS idx_relatorio_viagem_voo_tripulante_unico
  ON relatorio_despesa_viagem(numero_voo)
  WHERE origem_criacao = 'tripulante'
    AND numero_voo IS NOT NULL
    AND trim(numero_voo) <> '';
