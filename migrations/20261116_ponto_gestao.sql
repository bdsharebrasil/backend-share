-- Adição compatível: nenhuma tabela ou marcação antiga é excluída.
CREATE TABLE IF NOT EXISTS ponto_preferencias (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user_profiles(id),
  fuso_horario TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ponto_login_diario (
  user_id TEXT NOT NULL REFERENCES user_profiles(id),
  data_local TEXT NOT NULL,
  fuso_horario TEXT NOT NULL,
  exibido_em TEXT NOT NULL,
  resposta TEXT NOT NULL DEFAULT 'EXIBIDO' CHECK(resposta IN ('EXIBIDO','REGISTRADO','ADIADO')),
  PRIMARY KEY(user_id, data_local)
);
CREATE TABLE IF NOT EXISTS ponto_marcacoes (
  id TEXT PRIMARY KEY NOT NULL,
  lancamento_ponto_id TEXT NOT NULL REFERENCES lancamento_ponto(id),
  user_id TEXT NOT NULL REFERENCES user_profiles(id),
  data_jornada TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK(tipo IN ('ENTRADA','INICIO_INTERVALO','FIM_INTERVALO','SAIDA')),
  registrado_em TEXT NOT NULL,
  hora_local TEXT NOT NULL,
  fuso_horario TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  precisao_metros REAL,
  geolocalizacao_status TEXT NOT NULL CHECK(geolocalizacao_status IN ('INFORMADA','NEGADA','INDISPONIVEL','NAO_SOLICITADA')),
  ip TEXT,
  user_agent TEXT,
  requisicao_id TEXT NOT NULL,
  UNIQUE(user_id, requisicao_id),
  UNIQUE(lancamento_ponto_id, tipo)
);
CREATE INDEX IF NOT EXISTS idx_ponto_marcacoes_usuario_data ON ponto_marcacoes(user_id,data_jornada);
CREATE TRIGGER IF NOT EXISTS ponto_marcacoes_imutaveis_update BEFORE UPDATE ON ponto_marcacoes BEGIN SELECT RAISE(ABORT,'marcacao_original_imutavel'); END;
CREATE TRIGGER IF NOT EXISTS ponto_marcacoes_imutaveis_delete BEFORE DELETE ON ponto_marcacoes BEGIN SELECT RAISE(ABORT,'marcacao_original_imutavel'); END;
CREATE TABLE IF NOT EXISTS ponto_regras (
  id TEXT PRIMARY KEY NOT NULL,
  grupo_codigo TEXT NOT NULL,
  nome TEXT NOT NULL,
  vigencia_inicio TEXT NOT NULL,
  vigencia_fim TEXT,
  fonte_documento TEXT NOT NULL,
  parametros_json TEXT NOT NULL CHECK(json_valid(parametros_json)),
  status TEXT NOT NULL CHECK(status IN ('RASCUNHO','VALIDADA','REFERENCIA_INTERNA')),
  criado_por TEXT,
  validado_por TEXT,
  validado_em TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(grupo_codigo,vigencia_inicio)
);
CREATE TRIGGER IF NOT EXISTS ponto_regras_versionadas BEFORE UPDATE ON ponto_regras WHEN OLD.status = 'VALIDADA' BEGIN SELECT RAISE(ABORT,'crie_nova_versao_da_regra'); END;
CREATE TABLE IF NOT EXISTS ponto_escalas (
  id TEXT PRIMARY KEY NOT NULL,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK(tipo IN ('12X36','6X1','5X2','ROTATIVA','SOBREAVISO')),
  ciclo_json TEXT NOT NULL CHECK(json_valid(ciclo_json)),
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ponto_vinculos (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user_profiles(id),
  escala_id TEXT NOT NULL REFERENCES ponto_escalas(id),
  regra_id TEXT NOT NULL REFERENCES ponto_regras(id),
  gestor_id TEXT REFERENCES user_profiles(id),
  comunicada_em TEXT,
  justificativa_escala TEXT,
  anuencia_colaborador INTEGER NOT NULL DEFAULT 0,
  data_base TEXT NOT NULL,
  vigencia_inicio TEXT NOT NULL,
  vigencia_fim TEXT,
  fuso_horario TEXT NOT NULL,
  criado_por TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio)
);
CREATE INDEX IF NOT EXISTS idx_ponto_vinculos_usuario_vigencia ON ponto_vinculos(user_id,vigencia_inicio,vigencia_fim);
CREATE TABLE IF NOT EXISTS ponto_solicitacoes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user_profiles(id),
  data_referencia TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK(tipo IN ('CORRECAO','ATESTADO','DISPENSA','HORA_EXTRA','COMPENSACAO')),
  minutos INTEGER NOT NULL DEFAULT 0 CHECK(minutos BETWEEN 0 AND 1440),
  campo TEXT CHECK(campo IS NULL OR campo IN ('entrada_hora','inicio_almoco','fim_almoco','saida_hora')),
  horario_corrigido TEXT,
  justificativa TEXT NOT NULL,
  anexo_id TEXT REFERENCES lancamento_ponto_anexos(id),
  status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK(status IN ('PENDENTE','APROVADA','REJEITADA')),
  aprovado_por TEXT,
  aprovado_em TEXT,
  motivo_rejeicao TEXT,
  origem_tipo TEXT,
  origem_id TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(origem_tipo,origem_id)
);
CREATE INDEX IF NOT EXISTS idx_ponto_solicitacoes_pendencias ON ponto_solicitacoes(user_id,status,data_referencia);
-- Importação idempotente dos pedidos antigos. Os originais continuam disponíveis.
INSERT OR IGNORE INTO ponto_solicitacoes (id,user_id,data_referencia,tipo,campo,horario_corrigido,justificativa,status,aprovado_por,aprovado_em,motivo_rejeicao,origem_tipo,origem_id,criado_em)
SELECT 'legado-correcao:' || id,user_id,data_entrada,'CORRECAO',
 CASE tipo_correcao WHEN 'entrada' THEN 'entrada_hora' WHEN 'saida' THEN 'saida_hora' WHEN 'entrada_hora' THEN 'entrada_hora' WHEN 'inicio_almoco' THEN 'inicio_almoco' WHEN 'fim_almoco' THEN 'fim_almoco' WHEN 'saida_hora' THEN 'saida_hora' ELSE NULL END,
 tempo_corrigido,justificativa,CASE lower(status) WHEN 'approved' THEN 'APROVADA' WHEN 'aprovada' THEN 'APROVADA' WHEN 'rejected' THEN 'REJEITADA' WHEN 'rejeitada' THEN 'REJEITADA' ELSE 'PENDENTE' END,
 aprovado_por,aprovado_em,motivo_rejeicao,'CORRECAO_LEGADA',id,criado_em FROM solicitacoes_correcao_ponto WHERE NOT EXISTS (SELECT 1 FROM ponto_solicitacoes p WHERE p.origem_tipo='CORRECAO_LEGADA' AND p.origem_id=solicitacoes_correcao_ponto.id);
INSERT OR IGNORE INTO ponto_solicitacoes (id,user_id,data_referencia,tipo,minutos,justificativa,status,aprovado_por,aprovado_em,motivo_rejeicao,origem_tipo,origem_id,criado_em)
SELECT 'legado-ausencia:' || id,id_usuario,data_registro,'ATESTADO',0,justificativa,
 CASE lower(status) WHEN 'approved' THEN 'APROVADA' WHEN 'aprovada' THEN 'APROVADA' WHEN 'rejected' THEN 'REJEITADA' WHEN 'rejeitada' THEN 'REJEITADA' ELSE 'PENDENTE' END,
 aprovado_por,aprovado_em,motivo_rejeicao,'AUSENCIA_LEGADA',id,criado_em FROM justificativa_ausencia WHERE NOT EXISTS (SELECT 1 FROM ponto_solicitacoes p WHERE p.origem_tipo='AUSENCIA_LEGADA' AND p.origem_id=justificativa_ausencia.id);
CREATE TABLE IF NOT EXISTS ponto_fechamentos (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user_profiles(id),
  competencia TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'EM_CONFERENCIA' CHECK(status IN ('EM_CONFERENCIA','CONFERIDO','APROVADO_GESTOR','FECHADO_DP')),
  espelho_json TEXT,
  fonte_hash TEXT,
  conferido_em TEXT,
  aprovado_por TEXT,
  aprovado_em TEXT,
  fechado_por TEXT,
  fechado_em TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id,competencia)
);
CREATE TABLE IF NOT EXISTS ponto_banco_movimentos (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user_profiles(id),
  fechamento_id TEXT NOT NULL REFERENCES ponto_fechamentos(id),
  origem_chave TEXT NOT NULL,
  data_referencia TEXT NOT NULL,
  minutos REAL NOT NULL,
  validade_ate TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(fechamento_id,origem_chave)
);
CREATE TRIGGER IF NOT EXISTS ponto_banco_imutavel_update BEFORE UPDATE ON ponto_banco_movimentos BEGIN SELECT RAISE(ABORT,'movimento_banco_imutavel'); END;
CREATE TRIGGER IF NOT EXISTS ponto_banco_imutavel_delete BEFORE DELETE ON ponto_banco_movimentos BEGIN SELECT RAISE(ABORT,'movimento_banco_imutavel'); END;
CREATE TABLE IF NOT EXISTS ponto_auditoria (
  id TEXT PRIMARY KEY NOT NULL,
  ator_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  acao TEXT NOT NULL,
  entidade_id TEXT NOT NULL,
  dados_json TEXT NOT NULL CHECK(json_valid(dados_json)),
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS ponto_auditoria_imutavel_update BEFORE UPDATE ON ponto_auditoria BEGIN SELECT RAISE(ABORT,'auditoria_imutavel'); END;
CREATE TRIGGER IF NOT EXISTS ponto_auditoria_imutavel_delete BEFORE DELETE ON ponto_auditoria BEGIN SELECT RAISE(ABORT,'auditoria_imutavel'); END;
-- Travas e invalidação transacional impedem gravar em espelho fechado ou aprovar versões desatualizadas.
CREATE TRIGGER IF NOT EXISTS ponto_marcacao_mes_fechado BEFORE INSERT ON ponto_marcacoes
WHEN EXISTS(SELECT 1 FROM ponto_fechamentos WHERE user_id=NEW.user_id AND competencia=substr(NEW.data_jornada,1,7) AND status='FECHADO_DP')
BEGIN SELECT RAISE(ABORT,'competencia_fechada'); END;
CREATE TRIGGER IF NOT EXISTS ponto_solicitacao_mes_fechado BEFORE INSERT ON ponto_solicitacoes
WHEN EXISTS(SELECT 1 FROM ponto_fechamentos WHERE user_id=NEW.user_id AND competencia=substr(NEW.data_referencia,1,7) AND status='FECHADO_DP')
BEGIN SELECT RAISE(ABORT,'competencia_fechada'); END;
CREATE TRIGGER IF NOT EXISTS ponto_solicitacao_update_mes_fechado BEFORE UPDATE ON ponto_solicitacoes
WHEN EXISTS(SELECT 1 FROM ponto_fechamentos WHERE user_id=OLD.user_id AND competencia=substr(OLD.data_referencia,1,7) AND status='FECHADO_DP')
BEGIN SELECT RAISE(ABORT,'competencia_fechada'); END;
CREATE TRIGGER IF NOT EXISTS ponto_solicitacao_invalida_conferencia AFTER INSERT ON ponto_solicitacoes
BEGIN UPDATE ponto_fechamentos SET status='EM_CONFERENCIA',fonte_hash=NULL,espelho_json=NULL WHERE user_id=NEW.user_id AND competencia=substr(NEW.data_referencia,1,7) AND status<>'FECHADO_DP'; END;
CREATE TRIGGER IF NOT EXISTS ponto_solicitacao_decidida_invalida_conferencia AFTER UPDATE ON ponto_solicitacoes
BEGIN UPDATE ponto_fechamentos SET status='EM_CONFERENCIA',fonte_hash=NULL,espelho_json=NULL WHERE user_id=NEW.user_id AND competencia=substr(NEW.data_referencia,1,7) AND status<>'FECHADO_DP'; END;
CREATE TRIGGER IF NOT EXISTS ponto_marcacao_invalida_conferencia AFTER INSERT ON ponto_marcacoes
BEGIN UPDATE ponto_fechamentos SET status='EM_CONFERENCIA',fonte_hash=NULL,espelho_json=NULL WHERE user_id=NEW.user_id AND competencia=substr(NEW.data_jornada,1,7) AND status<>'FECHADO_DP'; END;
CREATE TRIGGER IF NOT EXISTS ponto_vinculo_invalida_conferencia AFTER INSERT ON ponto_vinculos
BEGIN UPDATE ponto_fechamentos SET status='EM_CONFERENCIA',fonte_hash=NULL,espelho_json=NULL WHERE user_id=NEW.user_id AND competencia>=substr(NEW.vigencia_inicio,1,7) AND status<>'FECHADO_DP'; END;
CREATE TRIGGER IF NOT EXISTS ponto_nova_versao_invalida_conferencia AFTER INSERT ON ponto_regras WHEN NEW.status='VALIDADA'
BEGIN UPDATE ponto_fechamentos SET status='EM_CONFERENCIA',fonte_hash=NULL,espelho_json=NULL WHERE competencia>=substr(NEW.vigencia_inicio,1,7) AND status<>'FECHADO_DP' AND user_id IN (SELECT v.user_id FROM ponto_vinculos v JOIN ponto_regras r ON r.id=v.regra_id WHERE r.grupo_codigo=NEW.grupo_codigo); END;
CREATE TABLE IF NOT EXISTS ponto_feriados (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL,
  nome TEXT NOT NULL,
  uf TEXT,
  municipio TEXT,
  recorrente_anual INTEGER NOT NULL DEFAULT 0,
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO ponto_feriados (id,data,nome,recorrente_anual) VALUES
 ('nacional-01-01','2025-01-01','Confraternização Universal',1),
 ('nacional-04-21','2025-04-21','Tiradentes',1),
 ('nacional-05-01','2025-05-01','Dia do Trabalho',1),
 ('nacional-09-07','2025-09-07','Independência do Brasil',1),
 ('nacional-10-12','2025-10-12','Nossa Senhora Aparecida',1),
 ('nacional-11-02','2025-11-02','Finados',1),
 ('nacional-11-15','2025-11-15','Proclamação da República',1),
 ('nacional-11-20','2025-11-20','Dia Nacional de Zumbi e da Consciência Negra',1),
 ('nacional-12-25','2025-12-25','Natal',1);
INSERT OR IGNORE INTO ponto_regras (id,grupo_codigo,nome,vigencia_inicio,vigencia_fim,fonte_documento,parametros_json,status) VALUES ('cct-sineata-fenascon-2025-admin','SINEATA_FENASCON_ADMIN','SINEATA × FENASCON 2025 · Administrativo','2025-01-01','2025-12-31','CCT assinada, páginas 1, 5, 16, 19-20; SHA-256 415a7dd96ec95630a776fb258ae120283de9b81f28570fd7c8c282408c5b2834','{"tolerancia_atraso_min": 5, "pausa_apos_min": 360, "intervalo_longo_min": 60, "intervalo_curto_min": 15, "noturno_inicio": "22:00", "noturno_fim": "05:00", "hora_noturna_min": 52.5, "adicional_noturno_percentual": 40, "sobreaviso_fator": 0.3333333333333333, "banco_horas": true, "banco_validade_meses": 2, "prorrogacao_noturna": false, "fechamento_automatico": true, "dsr_noturno_percentual": 25, "extra_util_percentual": 60, "extra_domingo_feriado_percentual": 100, "dsr_extras_percentual": 25, "banco_fator_util": 2, "banco_fator_domingo_feriado": 2.5, "carga_semanal_limite_min": 2640, "intervalo_curto_remunerado": true, "sobreaviso_validado": false, "antecedencia_escala_dias": 5, "ufs_abrangencia": "AC,AL,AP,BA,CE,DF,ES,GO,MA,MS,PA,PB,PE,PI,PR,RN,RO,RR,RS,SC,SE,TO"}','RASCUNHO');
INSERT OR IGNORE INTO ponto_regras (id,grupo_codigo,nome,vigencia_inicio,vigencia_fim,fonte_documento,parametros_json,status) VALUES ('cct-sineata-fenascon-2025-operacional','SINEATA_FENASCON_OPERACIONAL','SINEATA × FENASCON 2025 · Operacional','2025-01-01','2025-12-31','CCT assinada, páginas 1, 5, 16, 19-20; SHA-256 415a7dd96ec95630a776fb258ae120283de9b81f28570fd7c8c282408c5b2834','{"tolerancia_atraso_min": 5, "pausa_apos_min": 360, "intervalo_longo_min": 60, "intervalo_curto_min": 15, "noturno_inicio": "22:00", "noturno_fim": "05:00", "hora_noturna_min": 52.5, "adicional_noturno_percentual": 40, "sobreaviso_fator": 0.3333333333333333, "banco_horas": true, "banco_validade_meses": 2, "prorrogacao_noturna": false, "fechamento_automatico": true, "dsr_noturno_percentual": 25, "extra_util_percentual": 60, "extra_domingo_feriado_percentual": 100, "dsr_extras_percentual": 25, "banco_fator_util": 2, "banco_fator_domingo_feriado": 2.5, "carga_semanal_limite_min": 2520, "intervalo_curto_remunerado": true, "sobreaviso_validado": false, "antecedencia_escala_dias": 5, "ufs_abrangencia": "AC,AL,AP,BA,CE,DF,ES,GO,MA,MS,PA,PB,PE,PI,PR,RN,RO,RR,RS,SC,SE,TO"}','RASCUNHO');
INSERT OR IGNORE INTO ponto_regras (id,grupo_codigo,nome,vigencia_inicio,vigencia_fim,fonte_documento,parametros_json,status) VALUES ('referencia-interna-2026-admin','SINEATA_FENASCON_ADMIN','SINEATA × FENASCON 2026 · referência interna baseada em 2025 · Administrativo','2026-01-01','2026-12-31','Aplicação interna em 2026 solicitada pelo responsável; documento original de 2025, sem declaração de prorrogação sindical. CCT assinada, páginas 1, 5, 16, 19-20; SHA-256 415a7dd96ec95630a776fb258ae120283de9b81f28570fd7c8c282408c5b2834','{"tolerancia_atraso_min": 5, "pausa_apos_min": 360, "intervalo_longo_min": 60, "intervalo_curto_min": 15, "noturno_inicio": "22:00", "noturno_fim": "05:00", "hora_noturna_min": 52.5, "adicional_noturno_percentual": 40, "sobreaviso_fator": 0.3333333333333333, "banco_horas": true, "banco_validade_meses": 2, "prorrogacao_noturna": false, "fechamento_automatico": true, "dsr_noturno_percentual": 25, "extra_util_percentual": 60, "extra_domingo_feriado_percentual": 100, "dsr_extras_percentual": 25, "banco_fator_util": 2, "banco_fator_domingo_feriado": 2.5, "carga_semanal_limite_min": 2640, "intervalo_curto_remunerado": true, "sobreaviso_validado": false, "antecedencia_escala_dias": 5, "ufs_abrangencia": ""}','REFERENCIA_INTERNA');
INSERT OR IGNORE INTO ponto_regras (id,grupo_codigo,nome,vigencia_inicio,vigencia_fim,fonte_documento,parametros_json,status) VALUES ('referencia-interna-2026-operacional','SINEATA_FENASCON_OPERACIONAL','SINEATA × FENASCON 2026 · referência interna baseada em 2025 · Operacional','2026-01-01','2026-12-31','Aplicação interna em 2026 solicitada pelo responsável; documento original de 2025, sem declaração de prorrogação sindical. CCT assinada, páginas 1, 5, 16, 19-20; SHA-256 415a7dd96ec95630a776fb258ae120283de9b81f28570fd7c8c282408c5b2834','{"tolerancia_atraso_min": 5, "pausa_apos_min": 360, "intervalo_longo_min": 60, "intervalo_curto_min": 15, "noturno_inicio": "22:00", "noturno_fim": "05:00", "hora_noturna_min": 52.5, "adicional_noturno_percentual": 40, "sobreaviso_fator": 0.3333333333333333, "banco_horas": true, "banco_validade_meses": 2, "prorrogacao_noturna": false, "fechamento_automatico": true, "dsr_noturno_percentual": 25, "extra_util_percentual": 60, "extra_domingo_feriado_percentual": 100, "dsr_extras_percentual": 25, "banco_fator_util": 2, "banco_fator_domingo_feriado": 2.5, "carga_semanal_limite_min": 2520, "intervalo_curto_remunerado": true, "sobreaviso_validado": false, "antecedencia_escala_dias": 5, "ufs_abrangencia": ""}','REFERENCIA_INTERNA');
-- Mantém a trilha de RH existente e espelha ações humanas do módulo, sem criar usuário fictício para o cron.
CREATE TABLE IF NOT EXISTS auditoria_rh (
 id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), empresa_id TEXT, usuario_id TEXT NOT NULL,
 acao TEXT NOT NULL, entidade TEXT NOT NULL, entidade_id TEXT, dados_anteriores TEXT, dados_novos TEXT,
 ip TEXT, user_agent TEXT, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(empresa_id) REFERENCES empresa(id) ON DELETE SET NULL,
 FOREIGN KEY(usuario_id) REFERENCES user_profiles(id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS ponto_auditoria_espelha_rh AFTER INSERT ON ponto_auditoria
WHEN EXISTS(SELECT 1 FROM user_profiles WHERE id=NEW.ator_id)
BEGIN INSERT OR IGNORE INTO auditoria_rh (id,usuario_id,acao,entidade,entidade_id,dados_novos) VALUES ('ponto:'||NEW.id,NEW.ator_id,NEW.acao,'PONTO',NEW.entidade_id,NEW.dados_json); END;
CREATE TRIGGER IF NOT EXISTS ponto_marcacao_auditada AFTER INSERT ON ponto_marcacoes
BEGIN INSERT OR IGNORE INTO ponto_auditoria (id,ator_id,user_id,acao,entidade_id,dados_json) VALUES ('marcacao:'||NEW.id,NEW.user_id,NEW.user_id,'MARCACAO_REGISTRADA',NEW.id,json_object('tipo',NEW.tipo,'registrado_em',NEW.registrado_em,'fuso_horario',NEW.fuso_horario,'geolocalizacao_status',NEW.geolocalizacao_status)); END;
INSERT OR IGNORE INTO ponto_auditoria (id,ator_id,user_id,acao,entidade_id,dados_json)
SELECT 'referencia-interna:'||id,'CONFIGURACAO_SOLICITADA','SISTEMA','REFERENCIA_INTERNA_2026_CONFIGURADA',id,json_object('origem','instrução do responsável pelo projeto','documento_base','CCT SINEATA x FENASCON 2025','inicio_operacional','2026-01-01','fim_operacional','2026-12-31','observacao','parâmetros internos; sem declaração de nova CCT ou prorrogação sindical') FROM ponto_regras WHERE status='REFERENCIA_INTERNA';
CREATE TRIGGER IF NOT EXISTS ponto_regra_validada_invalida_conferencia AFTER UPDATE OF status ON ponto_regras WHEN NEW.status='VALIDADA' AND OLD.status<>NEW.status
BEGIN UPDATE ponto_fechamentos SET status='EM_CONFERENCIA',fonte_hash=NULL,espelho_json=NULL WHERE competencia>=substr(NEW.vigencia_inicio,1,7) AND status<>'FECHADO_DP' AND user_id IN (SELECT v.user_id FROM ponto_vinculos v JOIN ponto_regras r ON r.id=v.regra_id WHERE r.grupo_codigo=NEW.grupo_codigo); END;
CREATE TRIGGER IF NOT EXISTS ponto_feriado_invalida_conferencia AFTER INSERT ON ponto_feriados
BEGIN UPDATE ponto_fechamentos SET status='EM_CONFERENCIA',fonte_hash=NULL,espelho_json=NULL WHERE status<>'FECHADO_DP' AND (competencia=substr(NEW.data,1,7) OR (NEW.recorrente_anual=1 AND substr(competencia,6,2)=substr(NEW.data,6,2))) AND user_id IN (SELECT id FROM user_profiles WHERE (NEW.uf IS NULL OR uf=NEW.uf) AND (NEW.municipio IS NULL OR lower(cidade)=lower(NEW.municipio))); END;
