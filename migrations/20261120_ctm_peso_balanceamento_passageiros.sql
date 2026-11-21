-- Campos aditivos para passageiros nominados e envelope AFM/manual aprovado.
-- Não preenche limites técnicos nem altera configurações existentes.
ALTER TABLE solicitacoes_reserva_voo
  ADD COLUMN passageiros_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE ctm_peso_balanceamento
  ADD COLUMN envelope_pontos_json TEXT NOT NULL DEFAULT '[]';
