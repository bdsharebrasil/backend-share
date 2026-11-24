-- Próximas pernas são agendamentos confirmados vinculados à solicitação original.
ALTER TABLE solicitacoes_reserva_voo ADD COLUMN solicitacao_origem_id TEXT REFERENCES solicitacoes_reserva_voo(id);

CREATE INDEX IF NOT EXISTS idx_agendamento_solicitacao_origem
  ON solicitacoes_reserva_voo(solicitacao_origem_id, status, data_agendada)
  WHERE solicitacao_origem_id IS NOT NULL;

-- A perna realizada mantém o ID do agendamento que lhe deu origem.
CREATE TRIGGER IF NOT EXISTS agendamento_continuacao_atualizar_status
AFTER UPDATE OF horario_ac, horario_dep, horario_pouso, horario_corte ON pernas_jornada_voo
BEGIN
  UPDATE solicitacoes_reserva_voo SET
    status = CASE
      WHEN NEW.horario_corte IS NOT NULL THEN 'concluida'
      WHEN NEW.horario_pouso IS NOT NULL THEN 'em_solo'
      WHEN NEW.horario_dep IS NOT NULL THEN 'decolado'
      ELSE 'acionado'
    END,
    atualizado_em = CURRENT_TIMESTAMP
  WHERE id = NEW.id AND solicitacao_origem_id IS NOT NULL
    AND lower(status) IN ('acionado', 'decolado', 'em_solo', 'concluida') AND excluida_em IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS agendamento_continuacao_encerrar
AFTER UPDATE OF status ON solicitacoes_reserva_voo
WHEN NEW.solicitacao_origem_id IS NULL AND lower(NEW.status) IN ('encerrada', 'concluida', 'excluida', 'cancelada')
BEGIN
  UPDATE solicitacoes_reserva_voo SET
    status = CASE WHEN lower(status) = 'aprovada' THEN 'cancelada' ELSE 'encerrada' END,
    atualizado_em = CURRENT_TIMESTAMP
  WHERE solicitacao_origem_id = NEW.id AND excluida_em IS NULL
    AND lower(status) IN ('aprovada', 'acionado', 'decolado', 'em_solo');
END;
