INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE _cf_KV (
        key TEXT PRIMARY KEY,
        value BLOB
      ) WITHOUT ROWID'), ('CREATE TABLE abastecimentos (
    id TEXT PRIMARY KEY,
    cliente_id TEXT,
    socio_id TEXT,
    aeronave_id TEXT,
    data TEXT,
    tipo_combustivel TEXT,
    trecho TEXT,
    local TEXT,
    numero_comanda TEXT,
    numero_nf TEXT,
    litros REAL,
    valor_unitario REAL,
    valor_total REAL,
    desconto REAL,
    comanda_url TEXT,
    nota_url TEXT,
    boleto_url TEXT,

    fornecedor_id TEXT,
    
    status TEXT,
    observacao TEXT,
    forma_pagamento TEXT,
    data_vencimento_boleto TEXT,
    criado_por TEXT,
    lancamento_diario_id TEXT,
    data_pagamento TEXT,
    banco TEXT,
    voo_emprestado INT,
    numero_voo TEXT,
    prazo_envio_cliente_dias INT,
    prazo_envio_cliente_em TEXT,

    FOREIGN KEY (socio_id) REFERENCES hold_socios(id),
    FOREIGN KEY (fornecedor_id) REFERENCES fornecedores_favoritos(id)
)'), ('CREATE TABLE aerodromo (
    id TEXT PRIMARY KEY NOT NULL,
    nome TEXT NOT NULL,
    designativo_icao TEXT NOT NULL,
    coordenadas TEXT NULL
)'), ('CREATE TABLE aeronave (
    id TEXT PRIMARY KEY NOT NULL,

    matricula_registro TEXT NOT NULL,
    fabricante TEXT NOT NULL,
    modelo TEXT NOT NULL,
    numero_serie TEXT NOT NULL,
    nome_proprietario TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT ''ativa'',

    consumo_combustivel REAL NULL DEFAULT 0,

    ano TEXT NULL,
    base TEXT NULL,
    preco_hora TEXT NULL,
    url_imagem TEXT NULL,
    velocidade_cruzeiro TEXT NULL,

    tipo_aeronave TEXT NULL,

    performance_aeronave_id TEXT NULL, numero_motores INTEGER NULL,

    CHECK (
        tipo_aeronave IS NULL
        OR tipo_aeronave IN (
            ''PISTAO'',
            ''TURBOELICE'',
            ''JATO''
        )
    )
)'), ('CREATE TABLE agenda_contatos (
    id TEXT PRIMARY KEY NOT NULL,

    nome TEXT NOT NULL,

    telefone TEXT,
    email TEXT,

    empresa TEXT,
    cargo TEXT,

    observacoes TEXT,

    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,

    endereco TEXT,
     uf TEXT,
     cidade TEXT,

    categoria TEXT

)'), ('CREATE TABLE alerta_checklist (
    id TEXT PRIMARY KEY NOT NULL,

    checklists_pre_voo_id TEXT NULL,

    alerta1 TEXT NULL,
    alerta2 TEXT NULL,
    alerta3 TEXT NULL,
    alerta4 TEXT NULL,
    alerta5 TEXT NULL,
    alerta6 TEXT NULL,
    alerta7 TEXT NULL,
    alerta8 TEXT NULL,
    alerta9 TEXT NULL,
    alerta10 TEXT NULL,

    criado_em TEXT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE alteracoes_contratuais (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    contrato_id TEXT NOT NULL,
    tipo_alteracao TEXT NOT NULL,
    campo_alterado TEXT NOT NULL,
    valor_anterior TEXT,
    valor_novo TEXT,
    data_efetiva TEXT NOT NULL,
    alterado_por TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (contrato_id)
        REFERENCES contratos_trabalho(id)
        ON DELETE CASCADE,
    FOREIGN KEY (alterado_por)
        REFERENCES user_profiles(id)
        ON DELETE RESTRICT
)'), ('CREATE TABLE anexos_mensagens (
    id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),

    mensagem_id TEXT NOT NULL,

    nome_arquivo TEXT NOT NULL,
    caminho_arquivo TEXT NOT NULL,
    tipo_arquivo TEXT NULL,
    tamanho_arquivo INTEGER NULL,

    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (mensagem_id)
        REFERENCES mensagens_internas(id)
        ON DELETE CASCADE
)'), ('CREATE TABLE aniversarios (
    id TEXT PRIMARY KEY NOT NULL,

    nome TEXT NOT NULL,

    data_aniversario TEXT NOT NULL,

    empresa TEXT,

    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,

    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,

    categoria TEXT,

    url_avatar TEXT
)'), ('CREATE TABLE assinaturas_email (id TEXT PRIMARY KEY NOT NULL, usuario_id TEXT NOT NULL UNIQUE, nome TEXT NOT NULL, cargo TEXT, telefone TEXT, endereco TEXT, email TEXT NOT NULL, logo_url TEXT, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE auditoria_financeira (
  id TEXT PRIMARY KEY NOT NULL,
  entidade TEXT NOT NULL,
  entidade_id TEXT NOT NULL,
  operacao TEXT NOT NULL,
  valor_anterior_centavos INTEGER,
  valor_novo_centavos INTEGER,
  usuario_id TEXT,
  motivo TEXT,
  idempotency_key TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE auditoria_rh (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    empresa_id TEXT,
    usuario_id TEXT NOT NULL,
    acao TEXT NOT NULL,
    entidade TEXT NOT NULL,
    entidade_id TEXT,
    dados_anteriores TEXT,
    dados_novos TEXT,
    ip TEXT,
    user_agent TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (empresa_id)
        REFERENCES empresa(id)
        ON DELETE SET NULL,
    FOREIGN KEY (usuario_id)
        REFERENCES user_profiles(id)
        ON DELETE RESTRICT
)'), ('CREATE TABLE cartoes_beneficios (
    id TEXT PRIMARY KEY NOT NULL,

    usuario_id TEXT NOT NULL,

    tipo_cartao TEXT NOT NULL,

    mes INTEGER NOT NULL,
    ano INTEGER NOT NULL,

    saldo_inicial REAL NOT NULL DEFAULT 0,

    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (usuario_id)
        REFERENCES user_profiles(id)
        ON DELETE CASCADE,

    UNIQUE (
        usuario_id,
        tipo_cartao,
        mes,
        ano
    ),

    CHECK (
        tipo_cartao IN (''ALIMENTACAO'', ''COMBUSTIVEL'')
    ),

    CHECK (
        mes >= 1 AND mes <= 12
    ),

    CHECK (
        ano >= 2020
    )
)'), ('CREATE TABLE categoria_movimentacao_cliente (
    id TEXT PRIMARY KEY NOT NULL,

    nome TEXT NOT NULL,

    subcategoria_1 TEXT NULL,
    subcategoria_2 TEXT NULL,
    subcategoria_3 TEXT NULL,
    subcategoria_4 TEXT NULL
)'), ('CREATE TABLE categoria_movimentacao_share (
    id TEXT PRIMARY KEY NOT NULL,

    nome TEXT NOT NULL,

    tipo TEXT NULL,

    reembolsavel INTEGER NOT NULL DEFAULT 0,

    criado_por TEXT NULL,

    grupo_categoria TEXT NULL,

    tipo_despesa TEXT NULL,

    categoria_cliente_id TEXT NULL,

    FOREIGN KEY (criado_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL,

    FOREIGN KEY (categoria_cliente_id)
        REFERENCES categoria_movimentacao_cliente(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE categorias_calendario (
    id TEXT PRIMARY KEY NOT NULL,

    usuario_id TEXT NOT NULL,

    nome TEXT NOT NULL,
    cor TEXT NOT NULL,

    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (usuario_id)
        REFERENCES user_profiles(id)
        ON DELETE CASCADE
)'), ('CREATE TABLE centro_reunioes (id TEXT PRIMARY KEY NOT NULL, titulo TEXT NOT NULL, descricao TEXT, status TEXT NOT NULL DEFAULT ''ATIVA'', criado_por TEXT NOT NULL, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, encerrado_em TEXT NULL)'), ('CREATE TABLE "checklists_pre_voo"(
  id TEXT,
  solicitacao_id TEXT,
  aeronave_id TEXT,
  status TEXT,
  precisa_abastecer INT,
  abastecimento_id TEXT,
  respostas TEXT,
  observacoes TEXT,
  executado_por TEXT,
  executado_por_nome TEXT,
  concluido_em TEXT,
  criado_por TEXT,
  criado_em TEXT,
  atualizado_em TEXT,
  numero_voo TEXT,
  nivel_oleo TEXT,
  alerta_id TEXT,
  cotista_id TEXT
)'), ('CREATE TABLE cliente (
    id TEXT PRIMARY KEY NOT NULL,
    razao_social TEXT NULL,
    cnpj TEXT NULL,
    inscricao_estadual TEXT NULL,
    proprietario TEXT NULL,
    endereco TEXT NULL,
    cidade TEXT NULL,
    uf TEXT NULL,
    contato_financeiro TEXT NULL,
    telefone_financeiro TEXT NULL,
    telefone_cliente TEXT NULL,
    telefone_outro TEXT NULL,
    email_principal TEXT NULL,
    emails TEXT NOT NULL DEFAULT ''[]'',
    url_logo TEXT NULL,
    status TEXT NULL,
    holding INTEGER NOT NULL DEFAULT 0,
    codigo_cliente TEXT NULL,
    observacoes TEXT NULL,
    criado_em TEXT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE colaboradores (
  id TEXT PRIMARY KEY NOT NULL,
  user_profile_id TEXT UNIQUE,
  nome TEXT NOT NULL,
  cpf TEXT,
  pix TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE "contas_apagar" (
  id TEXT PRIMARY KEY NOT NULL,
  data_vencimento TEXT NOT NULL,
  data_pagamento TEXT,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  categoria_id TEXT REFERENCES categoria_movimentacao_share(id),
  categoria_nome TEXT,
  descricao TEXT,
  aeronave_id TEXT REFERENCES aeronave(id),
  fornecedor_id TEXT REFERENCES fornecedores_favoritos(id),
  cotista_id TEXT REFERENCES cotista_aeronave(id),
  boleto_url TEXT,
  nf_url TEXT,
  lancamentos_id TEXT REFERENCES lancamentos(id),
  banco_recebimento  TEXT REFERENCES contas_bancarias(id),
  colaborador_id TEXT REFERENCES user_profiles(id),
  status TEXT NOT NULL DEFAULT ''EM_ABERTO'' CHECK (status IN (''EM_ABERTO'',''EM_ATRASO'',''PAGO'',''CANCELADO'')),
  comprovante_pagamento_url TEXT,
  banco_pagamento TEXT REFERENCES contas_bancarias(id),
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  origem_tipo TEXT,
  idempotency_key TEXT
)'), ('CREATE TABLE "contas_areceber" (
  id TEXT PRIMARY KEY NOT NULL,
  data_vencimento TEXT,
  data_recebimento TEXT,
  data_pagamento TEXT,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  categoria_id TEXT REFERENCES categoria_movimentacao_share(id),
  categoria_nome TEXT,
  descricao TEXT,
  aeronave_id TEXT REFERENCES aeronave(id),
  cotista_id TEXT REFERENCES cotista_aeronave(id),
  lancamentos_id TEXT REFERENCES lancamentos(id),
  movimentos_id TEXT REFERENCES movimentos_holding(id),
  nf_saida_id TEXT REFERENCES notas_fiscais_saida(id),
  recibos_saida_id  TEXT REFERENCES recibos_saida(id), 
  status TEXT NOT NULL DEFAULT ''EM_ABERTO'' CHECK (status IN (''EM_ABERTO'',''RECEBIDO'',''EM_ATRASO'',''PAGO'',''CANCELADO'')),
  banco_recebimento  TEXT REFERENCES contas_bancarias(id),
  comprovante_recebimento_url TEXT,
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  origem_tipo TEXT,
  idempotency_key TEXT
)'), ('CREATE TABLE contas_bancarias (
  id TEXT PRIMARY KEY NOT NULL,
  razao_social TEXT NOT NULL,
  cnpj TEXT NOT NULL,
  chave_pix TEXT NOT NULL,
  nome TEXT NOT NULL,
    banco TEXT NOT NULL,

  numero_conta TEXT NULL,
  tipo_caixa TEXT NOT NULL CHECK (tipo_caixa IN (''SHARE'', ''CLIENTE'', ''HOLDING'')),
  cliente_id TEXT REFERENCES cliente(id),
  holding_id TEXT REFERENCES holdings(id),
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1))
)'), ('CREATE TABLE "contrato_cotista"(
  id TEXT,
  nome_arquivo TEXT,
  caminho_arquivo TEXT,
  tamanho_arquivo INT,
  descricao TEXT,
  url_publica TEXT,
  enviado_por TEXT,
  enviado_em TEXT,
  criado_em TEXT,
  atualizado_em TEXT,
  cotista_id TEXT
)'), ('CREATE TABLE contratos_trabalho (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    empresa_id TEXT NOT NULL,
    user_id TEXT NOT NULL,

    tipo_contrato TEXT NOT NULL DEFAULT ''CLT''
        CHECK (tipo_contrato IN (
            ''CLT'',
            ''ESTAGIO'',
            ''APRENDIZ'',
            ''TEMPORARIO'',
            ''AUTONOMO'',
            ''PJ'',
            ''OUTRO''
        )),
    matricula TEXT,
    cargo TEXT NOT NULL,
    jornada_semanal_minutos INTEGER,
    tipo_salario TEXT NOT NULL DEFAULT ''MENSAL''
        CHECK (tipo_salario IN (''MENSAL'', ''HORISTA'', ''DIARISTA'', ''COMISSIONADO'')),

    salario_base_centavos INTEGER NOT NULL DEFAULT 0
        CHECK (salario_base_centavos >= 0),
    percentual_insalubridade REAL NOT NULL DEFAULT 0
        CHECK (percentual_insalubridade >= 0),
    percentual_periculosidade REAL NOT NULL DEFAULT 0
        CHECK (percentual_periculosidade >= 0),

    data_inicio TEXT NOT NULL,
    data_fim TEXT,
    sindicato TEXT,
    centro_custo TEXT,
    status TEXT NOT NULL DEFAULT ''ATIVO''
        CHECK (status IN (''ATIVO'', ''SUSPENSO'', ''ENCERRADO'')),

    criado_por TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (empresa_id)
        REFERENCES empresa(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (user_id)
        REFERENCES user_profiles(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (criado_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE cotista_aeronave (id TEXT PRIMARY KEY NOT NULL, cliente_id TEXT, codigo_cliente TEXT, socio_id TEXT, aeronave_id TEXT NOT NULL, percentual_sociedade REAL NOT NULL, modelo_aeronave TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT, FOREIGN KEY (cliente_id) REFERENCES cliente(id), FOREIGN KEY (socio_id) REFERENCES hold_socios(id), FOREIGN KEY (aeronave_id) REFERENCES aeronave(id), CHECK (percentual_sociedade >= 0 AND percentual_sociedade <= 100))'), ('CREATE TABLE ctm_analise_oleo (
  id TEXT PRIMARY KEY,
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id) ON DELETE CASCADE,
  data_analise TEXT NOT NULL,
  ferro REAL NOT NULL,
  cobre REAL NOT NULL,
  aluminio REAL NOT NULL,
  silicio REAL NOT NULL,
  viscosidade REAL NOT NULL,
  ordem_servico_id TEXT REFERENCES ctm_ordem_acompanhamento_servico(id) ON DELETE SET NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_aprovacoes_ordem_servico (
  id TEXT PRIMARY KEY,
  ordem_servico_id TEXT NOT NULL REFERENCES ctm_orcamentos(id) ON DELETE CASCADE,
  nivel_aprovacao INTEGER NOT NULL DEFAULT 1,
  user_id TEXT REFERENCES user_profiles(id),
  acao TEXT,
  status TEXT NOT NULL DEFAULT ''pendente'' CHECK (status IN (''pendente'',''aprovado'',''rejeitado'')),
  motivo_rejeicao TEXT,
  comentarios TEXT,
  submetido_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revisado_em TEXT,
  data_acao TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ordem_servico_id, nivel_aprovacao)
)'), ('CREATE TABLE ctm_categoria (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  descricao TEXT,
  intervalo_horas INTEGER,
  intervalo_meses INTEGER,
  cor TEXT DEFAULT ''#3B82F6'',
  icone TEXT,
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_componente_eventos (
  id TEXT PRIMARY KEY,
  componente_id TEXT NOT NULL REFERENCES ctm_mapa_componente(id) ON DELETE CASCADE,
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id) ON DELETE CASCADE,
  tipo_evento TEXT NOT NULL CHECK (tipo_evento IN (''instalacao'',''remocao'',''inspecao'',''revisao'',''transferencia'',''ajuste'')),
  data_evento TEXT NOT NULL,
  horas_aeronave REAL,
  pousos_aeronave INTEGER,
  ciclos_aeronave INTEGER,
  posicao TEXT,
  p_n_removido TEXT,
  s_n_removido TEXT,
  p_n_instalado TEXT,
  s_n_instalado TEXT,
  motivo TEXT,
  descricao TEXT,
  ordem_servico_id TEXT REFERENCES ctm_ordem_acompanhamento_servico(id) ON DELETE SET NULL,
  peca_trocada_id TEXT REFERENCES ctm_pecas_trocadas(id) ON DELETE SET NULL,
  programa_manutencao_id TEXT REFERENCES ctm_programa_manutencao(id) ON DELETE SET NULL,
  documento_url TEXT,
  documento_nome TEXT,
  criado_por TEXT REFERENCES user_profiles(id),
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE ctm_despesas_motor (
  id TEXT PRIMARY KEY,
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN (''overhaul'',''reparo'',''manutencao'',''inspecao'')),
  lado_motor TEXT NOT NULL CHECK (lado_motor IN (''LH'',''RH'',''ambos'')),
  descricao TEXT NOT NULL,
  valor REAL NOT NULL DEFAULT 0,
  horas_motor REAL,
  fornecedor TEXT,
  numero_oas TEXT,
  observacoes TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_diretrizes (
  id TEXT PRIMARY KEY,
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN (''AD'',''SB'')),
  numero TEXT NOT NULL,
  titulo TEXT NOT NULL,
  descricao TEXT,
  aplicabilidade TEXT,
  data_vencimento TEXT,
  devido_horas REAL,
  ciclos_devidos INTEGER,
  data_de_conformidade TEXT,
  horas_de_conformidade REAL,
  metodo_de_conformidade TEXT,
  status TEXT DEFAULT ''pending'' CHECK (status IN (''expired'',''urgent'',''attention'',''complied'',''pending'',''not_applicable'')),
  responsavel TEXT,
  observacoes TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_documentos_oas (
  id TEXT PRIMARY KEY,
  ordem_servico_id TEXT NOT NULL REFERENCES ctm_ordem_acompanhamento_servico(id) ON DELETE CASCADE,
  nome_arquivo TEXT NOT NULL,
  tipo_arquivo TEXT,
  url_arquivo TEXT NOT NULL,
  caminho_arquivo TEXT,
  tamanho_bytes INTEGER,
  enviado_por TEXT REFERENCES user_profiles(id),
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_estacoes (
  id TEXT PRIMARY KEY,
  peso_balanceamento_id TEXT NOT NULL REFERENCES ctm_peso_balanceamento(id) ON DELETE CASCADE,
  descricao TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT ''OUTRO'',
  peso_sem_combustivel REAL NOT NULL DEFAULT 0,
  braco_posicao REAL NOT NULL DEFAULT 0,
  momento REAL NOT NULL DEFAULT 0,
  incluir_no_calculo INTEGER NOT NULL DEFAULT 1 CHECK (incluir_no_calculo IN (0,1)),
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_execucoes (
  id TEXT PRIMARY KEY,
  item_aeronave_id TEXT NOT NULL REFERENCES ctm_programa_manutencao(id) ON DELETE CASCADE,
  ordem_servico TEXT REFERENCES ctm_ordem_acompanhamento_servico(id) ON DELETE SET NULL,
  data_execucao TEXT NOT NULL,
  horas_aeronave_na_execucao REAL,
  pousos_aeronave_na_execucao INTEGER,
  oficina TEXT,
  observacoes TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_ficha_peso_balanceamento (
    id TEXT PRIMARY KEY NOT NULL
        DEFAULT (lower(hex(randomblob(16)))),

    -- Referências
    aeronave_id TEXT NOT NULL,
    peso_balanceamento_id TEXT NOT NULL,

    -- Identificação do voo
    data_voo TEXT NOT NULL,
    numero_voo TEXT,
    piloto_responsavel TEXT NOT NULL,

    -- =====================================================
    -- DADOS BASE DA AERONAVE NO MOMENTO DA FICHA
    -- =====================================================

    peso_vazio_kg REAL NOT NULL,
    braco_vazio REAL,
    momento_vazio REAL,

    -- =====================================================
    -- CARREGAMENTO DA AERONAVE
    -- JSON com piloto, copiloto, passageiros,
    -- bagagens, combustível e outros itens
    -- =====================================================

    itens_carregamento TEXT NOT NULL DEFAULT ''[]'',

    -- =====================================================
    -- COMBUSTÍVEL
    -- =====================================================

    fuel_litros REAL,
    fuel_kg REAL,
    fuel_braco REAL,
    fuel_momento REAL,

    -- =====================================================
    -- TOTAIS CALCULADOS
    -- =====================================================

    peso_total_kg REAL,
    momento_total REAL,
    cg_calculado REAL,

    -- =====================================================
    -- LIMITES UTILIZADOS NESTA FICHA
    -- =====================================================

    peso_maximo_decolagem REAL,
    peso_maximo_pouso REAL,
    peso_maximo_sem_combustivel REAL,

    cg_limite_dianteiro REAL,
    cg_limite_traseiro REAL,

    -- =====================================================
    -- RESULTADO
    -- =====================================================

    dentro_dos_limites INTEGER,

    status TEXT NOT NULL DEFAULT ''RASCUNHO'',

    -- =====================================================
    -- SNAPSHOT COMPLETO DOS DADOS DA CONFIGURAÇÃO
    -- =====================================================

    snapshot_limites TEXT NOT NULL,

    -- =====================================================
    -- OBSERVAÇÕES
    -- =====================================================

    observacoes TEXT,

    -- =====================================================
    -- CONTROLE
    -- =====================================================

    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    finalizado_em TEXT, solicitacao_id TEXT, assinatura_nome TEXT,

    FOREIGN KEY (aeronave_id)
        REFERENCES aeronave(id),

    FOREIGN KEY (peso_balanceamento_id)
        REFERENCES ctm_peso_balanceamento(id)
)'), ('CREATE TABLE ctm_horas_voadas_rateio (
  id TEXT PRIMARY KEY,
  ordem_servico_id TEXT NOT NULL REFERENCES ctm_ordem_acompanhamento_servico(id) ON DELETE CASCADE,
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id),
  clientes_id TEXT NOT NULL REFERENCES cliente(id),
  socio_id TEXT REFERENCES hold_socios(id),
  categoria TEXT NOT NULL DEFAULT ''cotista'',
  mes_referencia TEXT NOT NULL,
  horas_voadas REAL NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_itens_aeronave (
  id TEXT PRIMARY KEY,
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id),
  modelo_item_id TEXT REFERENCES ctm_modelos_item(id),
  nome_item_override TEXT,
  intervalo_horas_override REAL,
  intervalo_pousos_override REAL,
  intervalo_meses_override REAL,
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1))
)'), ('CREATE TABLE ctm_itens_nao_controlados (
  id TEXT PRIMARY KEY,
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id) ON DELETE CASCADE,
  tipo_controle TEXT NOT NULL CHECK (tipo_controle IN (''pneu_camara'',''vela_ignicao'',''pastilha_freio'',''disco_freio'')),
  posicao TEXT,
  media_horas REAL,
  marca TEXT,
  data_ultima_troca TEXT,
  horas_ultima_troca REAL,
  ordem_servico TEXT,
  nota_fiscal TEXT,
  horas_apos REAL,
  pousos_apos REAL,
  horas_restantes REAL,
  pousos_restantes REAL,
  observacoes TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_itens_orcamento (
  id TEXT PRIMARY KEY,
  servico_id TEXT NOT NULL REFERENCES ctm_orcamentos(id) ON DELETE CASCADE,
  ordenacao INTEGER NOT NULL DEFAULT 1,
  descricao TEXT NOT NULL,
  quantidade REAL NOT NULL DEFAULT 1,
  valor_unitario REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE ctm_mapa_componente (
  id TEXT PRIMARY KEY,
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  numero_da_peca TEXT NOT NULL,
  numero_de_serie TEXT NOT NULL,
  localizacao TEXT,
  categoria TEXT,
  total_horas_de_vida REAL,
  ciclos_de_vida_totais INTEGER,
  horas_de_vida_atuais REAL DEFAULT 0,
  ciclos_de_vida_atuais INTEGER DEFAULT 0,
  data_instalada TEXT NOT NULL,
  horas_instaladas REAL,
  ciclos_instalados INTEGER,
  status TEXT DEFAULT ''ok'' CHECK (status IN (''vencido'',''urgente'',''atencao'',''ok'')),
  fabricante TEXT,
  observacoes TEXT,
  tso REAL,
  csn INTEGER,
  cso INTEGER,
  data_de_vencimento TEXT,
  horas_restantes REAL,
  porcentagem_restante REAL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_modelos_item (
  id TEXT PRIMARY KEY,
  categoria_id TEXT NOT NULL REFERENCES ctm_categoria(id),
  modelo_aeronave TEXT NOT NULL,
  modelo_motor TEXT,
  tipo_operacao TEXT NOT NULL DEFAULT ''subparte_k'',
  nome_item TEXT NOT NULL,
  base_legal TEXT,
  fonte_mpd TEXT,
  intervalo_horas REAL,
  intervalo_pousos REAL,
  intervalo_meses REAL,
  criterio TEXT DEFAULT ''o_que_ocorrer_primeiro''
)'), ('CREATE TABLE ctm_oas_item_rateios (
  id TEXT PRIMARY KEY,
  ordem_servico_id TEXT NOT NULL REFERENCES ctm_ordem_acompanhamento_servico(id) ON DELETE CASCADE,
  item_tipo TEXT NOT NULL CHECK (item_tipo IN (''servico'',''peca'')),
  servico_id TEXT REFERENCES ctm_oas_servicos(id) ON DELETE CASCADE,
  peca_id TEXT REFERENCES ctm_pecas_trocadas(id) ON DELETE CASCADE,
  cliente_id TEXT NOT NULL REFERENCES cliente(id) ON DELETE CASCADE,
  socio_id TEXT REFERENCES hold_socios(id),
  tipo_rateio TEXT NOT NULL DEFAULT ''cota'',
  percentual REAL NOT NULL DEFAULT 0,
  valor REAL NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (item_tipo = ''servico'' AND servico_id IS NOT NULL AND peca_id IS NULL)
    OR (item_tipo = ''peca'' AND peca_id IS NOT NULL AND servico_id IS NULL)
  )
)'), ('CREATE TABLE ctm_oas_servicos (
  id TEXT PRIMARY KEY,
  ordem_servico_id TEXT NOT NULL REFERENCES ctm_ordem_acompanhamento_servico(id) ON DELETE CASCADE,
  oficina_nome TEXT,
  os_oficina TEXT,
  descricao TEXT NOT NULL,
  valor REAL NOT NULL DEFAULT 0,
  numero_nota_fiscal TEXT,
  data_servico TEXT,
  observacoes TEXT,
  nota_fiscal_path TEXT,
  nota_fiscal_nome TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_orcamentos (
  id TEXT PRIMARY KEY,
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id) ON DELETE CASCADE,
  numero_orcamento TEXT NOT NULL,
  descricao TEXT,
  nome_fornecedor TEXT,
  tipo_fornecedor TEXT DEFAULT ''servico'',
  notas TEXT,
  valor_total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT ''draft'' CHECK (status IN (''draft'',''enviado'',''aprovado'',''rejeitado'',''convertido_em_os'')),
  status_aprovacao TEXT NOT NULL DEFAULT ''pendente'' CHECK (status_aprovacao IN (''pendente'',''aprovado'',''rejeitado'')),
  submetido_em TEXT,
  aprovado_em TEXT,
  itens_orcamento TEXT,      -- JSON
  detalhes_orcamento TEXT,   -- JSON
  criado_por TEXT REFERENCES user_profiles(id),
  itens_servico_id TEXT REFERENCES ctm_ordem_acompanhamento_servico(id) ON DELETE SET NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_ordem_acompanhamento_servico (
  id TEXT PRIMARY KEY,
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id) ON DELETE CASCADE,
  numero TEXT,
  objetivo TEXT,
  tipo_manutencao TEXT,
  oficina_nome TEXT,
  mecanico_responsavel TEXT,
  data_entrada TEXT,
  data_saida TEXT,
  periodo_inicio TEXT,
  periodo_fim TEXT,
  status TEXT DEFAULT ''aberto'' CHECK (status IN (''aberto'',''em_andamento'',''aguardando_aprovacao'',''concluido'',''cancelado'')),
  status_aprovacao TEXT DEFAULT ''pendente'' CHECK (status_aprovacao IN (''pendente'',''aprovado'',''rejeitado'')),
  tipo_rateio TEXT DEFAULT ''horas'',
  total_mao_obra REAL DEFAULT 0,
  total_pecas REAL DEFAULT 0,
  total_geral REAL DEFAULT 0,
  total_valor_os REAL DEFAULT 0,
  periodo TEXT,
  observacoes TEXT,
  os_oficina TEXT,
  horas_celula REAL,
  dias_previstos INTEGER,
  dias_efetivos INTEGER,
  relatorio_voo_de TEXT,
  relatorio_voo_ate TEXT,
  total_voado_porcentagem TEXT,
  porcentagem_rateio TEXT,
  programa_manutencao_id TEXT REFERENCES ctm_programa_manutencao(id) ON DELETE SET NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_pecas_trocadas (
  id TEXT PRIMARY KEY,
  ordem_servico_id TEXT NOT NULL REFERENCES ctm_ordem_acompanhamento_servico(id) ON DELETE CASCADE,
  descricao TEXT NOT NULL,
  p_n_removido TEXT,
  s_n_removido TEXT,
  p_n_instalado TEXT,
  s_n_instalado TEXT,
  quantidade REAL NOT NULL DEFAULT 1,
  fornecedor TEXT,
  observacoes TEXT,
  valor_total REAL NOT NULL DEFAULT 0,
  numero_nota_fiscal TEXT,
  data_compra TEXT,
  nota_fiscal_path TEXT,
  nota_fiscal_nome TEXT,
  componente_id TEXT REFERENCES ctm_mapa_componente(id) ON DELETE SET NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_peso_balanceamento (
    id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),

    aeronave_id TEXT NOT NULL,

    peso_vazio_padrao REAL NOT NULL,
    braco_cg_padrao REAL NOT NULL,
    momento_padrao REAL,

    peso_maximo_decolagem REAL NOT NULL,
    peso_maximo_pouso REAL NOT NULL,
    peso_maximo_sem_combustivel REAL,

    cg_limite_dianteiro REAL NOT NULL,
    cg_limite_traseiro REAL NOT NULL,

    mac_comprimento REAL NOT NULL,
    lemac_distancia REAL NOT NULL,

    capacidade_combustivel_total REAL,
    capacidade_combustivel_util REAL,

    validado INTEGER DEFAULT 0,
    validado_em TEXT,
    validado_por TEXT,

    notas TEXT,

    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,

    criado_por TEXT,

    data_ultima_pesagem TEXT,
    numero_relatorio_pesagem TEXT,
    responsavel_tecnico TEXT,

    limite_bagagem_diant_kg REAL,
    limite_bagagem_tras_kg REAL,

    CONSTRAINT weight_balance_aircraft_id_key UNIQUE (aeronave_id),

    FOREIGN KEY (aeronave_id)
        REFERENCES aeronave(id)
        ON DELETE CASCADE
)'), ('CREATE TABLE ctm_programa_manutencao (
  id TEXT PRIMARY KEY,
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id) ON DELETE CASCADE,
  categoria TEXT NOT NULL DEFAULT ''PREVENTIVA_PROGRAMADA''
    CHECK (categoria IN (''PREVENTIVA_PROGRAMADA'',''PNEU'',''OLEO'',''MANUTENCAO_PROGRAMADA'',''REGULATORIO'',''OUTRO'')),
  grupo TEXT,
  item TEXT NOT NULL,
  base_legal TEXT,
  referencia TEXT,
  tipo_controle TEXT NOT NULL DEFAULT ''calendario'' CHECK (tipo_controle IN (''calendario'',''horas'',''pousos'',''ciclos'')),
  obrigatorio INTEGER NOT NULL DEFAULT 1 CHECK (obrigatorio IN (0,1)),
  intervalo_meses INTEGER,
  intervalo_horas REAL,
  intervalo_ciclos INTEGER,
  intervalo_pousos INTEGER,
  ultima_execucao_data TEXT,
  ultima_execucao_horas REAL,
  ultima_execucao_ciclos INTEGER,
  ultima_execucao_pousos INTEGER,
  alerta_antecedencia_dias INTEGER NOT NULL DEFAULT 30,
  alerta_antecedencia_horas REAL NOT NULL DEFAULT 10,
  alerta_antecedencia_pousos INTEGER NOT NULL DEFAULT 20,
  responsavel TEXT,
  status TEXT NOT NULL DEFAULT ''ativo'' CHECK (status IN (''ativo'',''inativo'',''concluido'')),
  observacoes TEXT,
  criado_por TEXT REFERENCES user_profiles(id),
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_ras (
  id TEXT PRIMARY KEY,
  numero TEXT NOT NULL UNIQUE,
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id) ON DELETE CASCADE,
  oas_numero TEXT,
  tipo_manutencao TEXT NOT NULL CHECK (tipo_manutencao IN (''preventiva'',''corretiva'',''programada'')),
  periodo TEXT,
  objetivo TEXT,
  data_entrada TEXT NOT NULL,
  data_saida TEXT,
  dias_planejados INTEGER,
  dias_efetivos INTEGER,
  horas_celula_entrada REAL,
  horas_celula_saida REAL,
  descricao TEXT,
  total_trabalho REAL DEFAULT 0,
  total_pecas REAL DEFAULT 0,
  total_geral REAL DEFAULT 0,
  status TEXT CHECK (status IN (''in_progress'',''completed'',''cancelled'')),
  criado_por TEXT REFERENCES user_profiles(id),
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE ctm_ras_fotos (
  id TEXT PRIMARY KEY,
  ras_id TEXT NOT NULL REFERENCES ctm_ras(id) ON DELETE CASCADE,
  url_foto TEXT NOT NULL,
  legenda TEXT,
  enviado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_ras_itens (
  id TEXT PRIMARY KEY,
  ras_id TEXT NOT NULL REFERENCES ctm_ras(id) ON DELETE CASCADE,
  item_tipo TEXT NOT NULL CHECK (item_tipo IN (''servico'',''peca'')),
  descricao TEXT NOT NULL,
  fornecedor TEXT,
  periodo TEXT,
  quantidade REAL DEFAULT 1,
  valor_unitario REAL DEFAULT 0,
  valor_total REAL DEFAULT 0,
  numero_fatura TEXT,
  numero_peca TEXT,
  numero_serie TEXT,
  motivo TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE ctm_rastreamento (
  id TEXT PRIMARY KEY,
  aeronave_id TEXT REFERENCES aeronave(id) ON DELETE CASCADE,
  mes INTEGER NOT NULL,
  ano INTEGER NOT NULL,
  tipo_controle TEXT NOT NULL,
  nome_item TEXT NOT NULL,
  valor_esquerdo TEXT,
  valor_direito TEXT,
  data_ultima_troca TEXT,
  horas_ultima_troca REAL,
  numero_ordem_servico TEXT,
  numero_nota_fiscal TEXT,
  horas_apos REAL,
  horas_restantes REAL,
  cliente_id TEXT REFERENCES cliente(id),
  orcamento TEXT,
  nome_socio TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (aeronave_id, mes, ano, tipo_controle, nome_item)
)'), ('CREATE TABLE ctm_rateio_custos (
  id TEXT PRIMARY KEY,
  ordem_servico_id TEXT NOT NULL REFERENCES ctm_ordem_acompanhamento_servico(id) ON DELETE CASCADE,
  cliente_id TEXT NOT NULL REFERENCES cliente(id) ON DELETE CASCADE,
  horas_voadas REAL DEFAULT 0,
  percentual REAL DEFAULT 0,
  valor REAL DEFAULT 0,
  status_pagamento TEXT DEFAULT ''pendente'' CHECK (status_pagamento IN (''pendente'',''pago'',''cancelado'')),
  data_pagamento TEXT,
  comprovante_url TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)'), ('CREATE TABLE decimo_terceiro (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    empresa_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    ano INTEGER NOT NULL CHECK (ano >= 2000),
    parcela TEXT NOT NULL
        CHECK (parcela IN (''PRIMEIRA'', ''SEGUNDA'', ''INTEGRAL'', ''RESCISAO'')),
    meses_trabalhados INTEGER NOT NULL DEFAULT 0 CHECK (meses_trabalhados BETWEEN 0 AND 12),
    salario_base_centavos INTEGER NOT NULL DEFAULT 0 CHECK (salario_base_centavos >= 0),
    media_variaveis_centavos INTEGER NOT NULL DEFAULT 0 CHECK (media_variaveis_centavos >= 0),
    valor_bruto_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_bruto_centavos >= 0),
    inss_centavos INTEGER NOT NULL DEFAULT 0 CHECK (inss_centavos >= 0),
    irrf_centavos INTEGER NOT NULL DEFAULT 0 CHECK (irrf_centavos >= 0),
    valor_liquido_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_liquido_centavos >= 0),
    data_pagamento TEXT,
    status TEXT NOT NULL DEFAULT ''CALCULADO''
        CHECK (status IN (''CALCULADO'', ''AGUARDANDO_APROVACAO'', ''APROVADO'', ''PAGO'', ''CANCELADO'')),
    aprovado_por TEXT,
    aprovado_em TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (empresa_id)
        REFERENCES empresa(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (user_id)
        REFERENCES user_profiles(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (aprovado_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL,

    UNIQUE (empresa_id, user_id, ano, parcela)
)'), ('CREATE TABLE departamentos_email (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  email_from TEXT NOT NULL,       -- reply-to do departamento
  telefone_padrao TEXT,
  endereco_padrao TEXT,
  logo_url_padrao TEXT
)'), ('CREATE TABLE destinatarios_mensagens (
    id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),

    mensagem_id TEXT NOT NULL,
    destinatario_id TEXT NOT NULL,

    tipo_destinatario TEXT NOT NULL DEFAULT ''para'',

    lida INTEGER NOT NULL DEFAULT 0,
    lida_em TEXT NULL,

    arquivada INTEGER NOT NULL DEFAULT 0,
    excluida INTEGER NOT NULL DEFAULT 0,
    marcada INTEGER NOT NULL DEFAULT 0,

    pasta_id TEXT NULL,

    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (mensagem_id, destinatario_id),

    FOREIGN KEY (mensagem_id)
        REFERENCES mensagens_internas(id)
        ON DELETE CASCADE,

    FOREIGN KEY (pasta_id)
        REFERENCES pastas_mensagens(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE diario_mes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  aeronave_id TEXT NOT NULL,
  ano INTEGER NOT NULL,
  mes INTEGER NOT NULL,
  celula_anterior_ttotal REAL DEFAULT 0,
  celula_atual_ttotal REAL DEFAULT 0,
  celula_prox_revisao_ttotal REAL DEFAULT 0,
  celula_disponivel_ttotal REAL DEFAULT 0,
  horimetro_inicio REAL DEFAULT 0,
  horimetro_final REAL DEFAULT 0,
  horimetro_ativo REAL DEFAULT 0,
  fechado INTEGER DEFAULT 0,
  aerodromo_base TEXT,
  tarifa_diaria REAL DEFAULT 0,
  consumo_combustivel TEXT,
  tem_tarifa_diaria INTEGER DEFAULT 1,
  celula_atual_tvoo REAL,
  celula_disponivel_tvoo REAL,
  celula_anterior_tvoo REAL,
  celula_prox_revisao_tvoo REAL,
  FOREIGN KEY (aeronave_id) REFERENCES aeronave(id)
)'), ('CREATE TABLE documentos_colaboradores (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    empresa_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    tipo_documento TEXT NOT NULL
        CHECK (tipo_documento IN (
            ''HOLERITE'',
            ''RECIBO_FERIAS'',
            ''AVISO_FERIAS'',
            ''COMPROVANTE_PAGAMENTO'',
            ''CONTRATO'',
            ''ADITIVO_CONTRATUAL'',
            ''ATESTADO'',
            ''DOCUMENTO_PESSOAL'',
            ''TERMO_RESCISAO'',
            ''OUTRO''
        )),
    nome_arquivo TEXT NOT NULL,
    caminho_arquivo TEXT NOT NULL,
    hash_arquivo TEXT,
    tipo_arquivo TEXT NOT NULL,
    tamanho_bytes INTEGER,
    competencia_ano INTEGER,
    competencia_mes INTEGER CHECK (competencia_mes IS NULL OR competencia_mes BETWEEN 1 AND 12),
    visibilidade TEXT NOT NULL DEFAULT ''COLABORADOR''
        CHECK (visibilidade IN (''SOMENTE_RH'', ''CONTABILIDADE'', ''COLABORADOR'', ''FINANCEIRO'', ''TODOS_AUTORIZADOS'')),
    enviado_por TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (empresa_id)
        REFERENCES empresa(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (user_id)
        REFERENCES user_profiles(id)
        ON DELETE CASCADE,
    FOREIGN KEY (enviado_por)
        REFERENCES user_profiles(id)
        ON DELETE RESTRICT
)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE "documentos_cotista"(
  id TEXT,
  nome_arquivo TEXT,
  caminho_arquivo TEXT,
  tipo_arquivo TEXT,
  tamanho_arquivo INT,
  enviado_por TEXT,
  categoria TEXT,
  criado_em TEXT,
  atualizado_em TEXT,
  cotista_id TEXT
)'), ('CREATE TABLE documentos_internos (
    id TEXT PRIMARY KEY NOT NULL,

    pasta_id TEXT,

    nome TEXT NOT NULL,

    caminho_arquivo TEXT NOT NULL,

    tipo_arquivo TEXT NOT NULL,

    tamanho_arquivo INTEGER NOT NULL,

    enviado_por TEXT NOT NULL,

    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (pasta_id)
        REFERENCES pastas_documentos(id)
        ON DELETE CASCADE
)'), ('CREATE TABLE documentos_socio (id TEXT PRIMARY KEY NOT NULL, socio_id TEXT NOT NULL, cliente_id TEXT, nome_arquivo TEXT NOT NULL, caminho_arquivo TEXT NOT NULL, tipo_arquivo TEXT NOT NULL, tamanho_arquivo INTEGER NOT NULL DEFAULT 0, enviado_por TEXT, categoria TEXT NOT NULL DEFAULT ''documentos-pessoais'', criado_em TEXT DEFAULT CURRENT_TIMESTAMP)'), ('CREATE TABLE documentos_usuarios (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    nome_arquivo TEXT NOT NULL,
    caminho_arquivo TEXT NOT NULL,
    tipo_arquivo TEXT NOT NULL,
    tamanho_arquivo INTEGER,
    enviado_por TEXT,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    categoria TEXT DEFAULT ''documentos'',

    FOREIGN KEY (user_id)
        REFERENCES user_profiles(id)
        ON DELETE CASCADE,

    FOREIGN KEY (enviado_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE email_templates (id TEXT PRIMARY KEY NOT NULL, tipo TEXT NOT NULL, assunto TEXT NOT NULL, corpo_html TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'), ('CREATE TABLE "emails_enviados"(
  id TEXT,
  assunto TEXT,
  mensagem TEXT,
  destinatarios TEXT,
  copias TEXT,
  responder_para TEXT,
  categoria TEXT,
  referencia_tipo TEXT,
  referencia_id TEXT,
  anexos TEXT,
  quantidade_anexos INT,
  status TEXT,
  erro_mensagem TEXT,
  provedor_id TEXT,
  enviado_por TEXT,
  criado_em TEXT,
  cotista_id TEXT
)'), ('CREATE TABLE emails_modelos (
  id TEXT PRIMARY KEY NOT NULL,
  nome TEXT NOT NULL,
  assunto TEXT NOT NULL,
  corpo TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT ''geral'',
  criado_por TEXT NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE empresa (
    id TEXT PRIMARY KEY NOT NULL,
  razao_social TEXT NULL,
  cnpj TEXT NULL,
  numero_telefone TEXT NULL,
 endereco TEXT NULL,

  telefone_coordenacao_1 TEXT NULL,
      criado_em TEXT NULL DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TEXT NULL DEFAULT CURRENT_TIMESTAMP


, telegram_chat_id TEXT
  , "logo_url" TEXT)'), ('CREATE TABLE emprestimos_aeronave (
    id TEXT NOT NULL PRIMARY KEY,

    horas_emprestadas REAL NOT NULL,
    horas_devolvidas REAL DEFAULT 0,

    lancamento_diario_id TEXT,
    lancamento_devolucao_id TEXT,

    data_lancamento TEXT NOT NULL,

    observacoes TEXT,

    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,

    aerodromo_partida TEXT NOT NULL,
    aerodromo_chegada TEXT,

    trecho TEXT,

    combustivel_adicionado REAL,

    nome_piloto TEXT,

    numero_voo TEXT
)'), ('CREATE TABLE "envio_despesas"(
  id TEXT,
  tipo TEXT,
  descricao TEXT,
  valor REAL,
  data_despesa TEXT,
  vencimento TEXT,
  fornecedor TEXT,
  aeronave_id TEXT,
  numero_voo TEXT,
  centro_custo TEXT,
  observacoes TEXT,
  status TEXT,
  criado_por TEXT,
  criado_em TEXT,
  atualizado_em TEXT,
  grupo_categoria TEXT,
  tipo_caixa TEXT,
  tipo_despesa TEXT,
  pago_diretamente INT,
  pago_por TEXT,
  movimentacao_id TEXT,
  rateio_id TEXT,
  cotista_id TEXT
, lancamento_id TEXT, fornecedor_id TEXT, cotista_ids TEXT DEFAULT ''[]'', categoria_id TEXT, categoria_nome TEXT, email_solicitado INTEGER NOT NULL DEFAULT 0, email_enviado INTEGER NOT NULL DEFAULT 0, email_enviado_em TEXT, email_id TEXT, movimentos_holding_id TEXT, periodicidade TEXT, anexos_json TEXT DEFAULT ''[]'', tipo_rateio TEXT, subcategoria_1 TEXT, subcategoria_2 TEXT, subcategoria_3 TEXT, subcategoria_4 TEXT, rateio_linhas_json TEXT DEFAULT ''[]'')');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE escala_tripulacao (
    id TEXT PRIMARY KEY NOT NULL,

    tripulacao_id TEXT NOT NULL,

    aeronave_id TEXT NULL,

    solicitacao_id TEXT NULL,

    funcao TEXT NOT NULL DEFAULT ''PIC'',

    data_inicio TEXT NOT NULL,

    data_fim TEXT NOT NULL,

    status TEXT NULL,

    observacoes TEXT NULL,

    criado_por TEXT NULL,

    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (tripulacao_id)
        REFERENCES tripulacao(id)
        ON DELETE CASCADE,

    FOREIGN KEY (aeronave_id)
        REFERENCES aeronave(id)
        ON DELETE SET NULL,

    FOREIGN KEY (solicitacao_id)
        REFERENCES solicitacoes_reserva_voo(id)
        ON DELETE SET NULL,

    FOREIGN KEY (criado_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE eventos_folha (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    item_folha_id TEXT NOT NULL,
    tipo_evento TEXT NOT NULL,
    codigo TEXT,
    descricao TEXT NOT NULL,
    referencia REAL,
    quantidade REAL,
    valor_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_centavos >= 0),
    natureza TEXT NOT NULL
        CHECK (natureza IN (''PROVENTO'', ''DESCONTO'', ''ENCARGO'', ''INFORMATIVO'')),
    incide_inss INTEGER NOT NULL DEFAULT 0 CHECK (incide_inss IN (0, 1)),
    incide_irrf INTEGER NOT NULL DEFAULT 0 CHECK (incide_irrf IN (0, 1)),
    incide_fgts INTEGER NOT NULL DEFAULT 0 CHECK (incide_fgts IN (0, 1)),
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (item_folha_id)
        REFERENCES itens_folha(id)
        ON DELETE CASCADE
)'), ('CREATE TABLE ferias (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    empresa_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    periodo_aquisitivo_id TEXT NOT NULL,
    solicitacao_id TEXT,
    data_inicio TEXT NOT NULL,
    data_fim TEXT NOT NULL,
    quantidade_dias INTEGER NOT NULL CHECK (quantidade_dias > 0),
    dias_abono INTEGER NOT NULL DEFAULT 0 CHECK (dias_abono >= 0),
    salario_base_centavos INTEGER NOT NULL DEFAULT 0 CHECK (salario_base_centavos >= 0),
    media_variaveis_centavos INTEGER NOT NULL DEFAULT 0 CHECK (media_variaveis_centavos >= 0),
    valor_ferias_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_ferias_centavos >= 0),
    adicional_um_terco_centavos INTEGER NOT NULL DEFAULT 0 CHECK (adicional_um_terco_centavos >= 0),
    descontos_centavos INTEGER NOT NULL DEFAULT 0 CHECK (descontos_centavos >= 0),
    valor_liquido_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_liquido_centavos >= 0),
    data_pagamento TEXT,
    status TEXT NOT NULL DEFAULT ''CALCULADA''
        CHECK (status IN (
            ''PROGRAMADA'',
            ''CALCULADA'',
            ''AGUARDANDO_APROVACAO'',
            ''APROVADA'',
            ''PAGA'',
            ''CANCELADA''
        )),
    aprovado_por TEXT,
    aprovado_em TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (empresa_id)
        REFERENCES empresa(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (user_id)
        REFERENCES user_profiles(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (periodo_aquisitivo_id)
        REFERENCES periodos_aquisitivos_ferias(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (solicitacao_id)
        REFERENCES solicitacoes_ferias(id)
        ON DELETE SET NULL,
    FOREIGN KEY (aprovado_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL,

    CHECK (date(data_fim) >= date(data_inicio))
)'), ('CREATE TABLE financeiro_fila (
  id TEXT PRIMARY KEY NOT NULL,
  operacao TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT ''PENDENTE'',
  tentativas INTEGER NOT NULL DEFAULT 0,
  erro TEXT,
  processado_em TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE financeiro_vinculos (
  id TEXT PRIMARY KEY NOT NULL,
  origem_tipo TEXT NOT NULL,
  origem_id TEXT NOT NULL,
  destino_tipo TEXT NOT NULL,
  destino_id TEXT NOT NULL,
  tipo_vinculo TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (origem_tipo, origem_id, destino_tipo, destino_id, tipo_vinculo)
)'), ('CREATE TABLE folhas_pagamento (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    empresa_id TEXT NOT NULL,
    competencia_ano INTEGER NOT NULL CHECK (competencia_ano >= 2000),
    competencia_mes INTEGER NOT NULL CHECK (competencia_mes BETWEEN 1 AND 12),
    tipo_folha TEXT NOT NULL DEFAULT ''MENSAL''
        CHECK (tipo_folha IN (
            ''MENSAL'',
            ''FERIAS'',
            ''DECIMO_TERCEIRO'',
            ''RESCISAO'',
            ''COMPLEMENTAR'',
            ''ADIANTAMENTO''
        )),
    status TEXT NOT NULL DEFAULT ''RASCUNHO''
        CHECK (status IN (
            ''RASCUNHO'',
            ''EM_CALCULO'',
            ''AGUARDANDO_REVISAO'',
            ''AGUARDANDO_APROVACAO'',
            ''APROVADA'',
            ''ENVIADA_AO_FINANCEIRO'',
            ''PAGA'',
            ''CANCELADA''
        )),

    total_bruto_centavos INTEGER NOT NULL DEFAULT 0 CHECK (total_bruto_centavos >= 0),
    total_descontos_centavos INTEGER NOT NULL DEFAULT 0 CHECK (total_descontos_centavos >= 0),
    total_liquido_centavos INTEGER NOT NULL DEFAULT 0 CHECK (total_liquido_centavos >= 0),
    total_encargos_centavos INTEGER NOT NULL DEFAULT 0 CHECK (total_encargos_centavos >= 0),

    criada_por TEXT NOT NULL,
    revisada_por TEXT,
    aprovada_por TEXT,
    aprovada_em TEXT,
    fechada_em TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (empresa_id)
        REFERENCES empresa(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (criada_por)
        REFERENCES user_profiles(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (revisada_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL,
    FOREIGN KEY (aprovada_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL,

    UNIQUE (empresa_id, competencia_ano, competencia_mes, tipo_folha)
)'), ('CREATE TABLE fornecedores_favoritos (
    id TEXT PRIMARY KEY NOT NULL,

    nome_completo TEXT NOT NULL,

    endereco TEXT NULL,

    cidade TEXT NULL,

    uf TEXT NULL,

    codigo_icao TEXT NULL,

    pessoa_contato TEXT NULL,

    preco_avgas REAL NULL DEFAULT 0,

    preco_jet REAL NULL DEFAULT 0,

    telefone TEXT NULL,

    documento TEXT NULL,

    apelido TEXT NULL,

    conta_pagamento TEXT NULL
)'), ('CREATE TABLE habilitacoes_tripulante (
    id TEXT PRIMARY KEY NOT NULL,

    tripulacao_id TEXT NULL,

    tipo_habilitacao TEXT NOT NULL,

    data_validade TEXT NULL,

    classe_cma TEXT NULL,

    validade_cma TEXT NULL,

    fs_rh TEXT NULL,

    FOREIGN KEY (tripulacao_id)
        REFERENCES tripulacao(id)
        ON DELETE CASCADE
)'), ('CREATE TABLE hold_socios (id TEXT PRIMARY KEY NOT NULL, cotista_id TEXT NOT NULL, nome TEXT NOT NULL, cpf TEXT NOT NULL, email_principal TEXT, emails TEXT NOT NULL DEFAULT ''[]'', endereco TEXT, cidade TEXT, uf TEXT, contato_financeiro TEXT, telefone_financeiro TEXT, telefone TEXT, observacoes TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP, holding_id TEXT NOT NULL, FOREIGN KEY (cotista_id) REFERENCES cotista_aeronave(id), FOREIGN KEY (holding_id) REFERENCES holdings(id))'), ('CREATE TABLE holdings (
    id TEXT PRIMARY KEY NOT NULL,
    nome TEXT NOT NULL,
    conta_bancaria TEXT,
    ativo INTEGER NOT NULL DEFAULT 1
, cnpj TEXT, proprietario TEXT, endereco TEXT, cidade TEXT, uf TEXT, emails TEXT, url_logo TEXT, inscricao_estadual TEXT, documentos TEXT)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE hoteis (
    id TEXT PRIMARY KEY NOT NULL,

    nome TEXT NOT NULL,

    telefone TEXT,
      endereco TEXT,
    uf TEXT,

    cidade TEXT,

    preco_single REAL,
    preco_duplo REAL,


    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,


    estrelas INTEGER,

    convenio INTEGER NOT NULL DEFAULT 0,

    email TEXT,

    telefone_reservas TEXT,
    contato_comercial TEXT,

    telefone_comercial TEXT,
    email_comercial TEXT,

    observacoes TEXT
)'), ('CREATE TABLE itens_folha (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    folha_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    contrato_id TEXT,

    dias_trabalhados INTEGER NOT NULL DEFAULT 0 CHECK (dias_trabalhados >= 0),
    horas_extras_minutos INTEGER NOT NULL DEFAULT 0 CHECK (horas_extras_minutos >= 0),
    salario_base_centavos INTEGER NOT NULL DEFAULT 0 CHECK (salario_base_centavos >= 0),
    total_proventos_centavos INTEGER NOT NULL DEFAULT 0 CHECK (total_proventos_centavos >= 0),
    total_descontos_centavos INTEGER NOT NULL DEFAULT 0 CHECK (total_descontos_centavos >= 0),
    total_liquido_centavos INTEGER NOT NULL DEFAULT 0 CHECK (total_liquido_centavos >= 0),
    inss_centavos INTEGER NOT NULL DEFAULT 0 CHECK (inss_centavos >= 0),
    irrf_centavos INTEGER NOT NULL DEFAULT 0 CHECK (irrf_centavos >= 0),
    fgts_centavos INTEGER NOT NULL DEFAULT 0 CHECK (fgts_centavos >= 0),

    status TEXT NOT NULL DEFAULT ''CALCULADO''
        CHECK (status IN (''PENDENTE'', ''CALCULADO'', ''REVISADO'', ''APROVADO'', ''PAGO'', ''CANCELADO'')),
    observacoes TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (folha_id)
        REFERENCES folhas_pagamento(id)
        ON DELETE CASCADE,
    FOREIGN KEY (user_id)
        REFERENCES user_profiles(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (contrato_id)
        REFERENCES contratos_trabalho(id)
        ON DELETE SET NULL,

    UNIQUE (folha_id, user_id)
)'), ('CREATE TABLE itens_solicitacao_compra (
    id TEXT PRIMARY KEY NOT NULL,

    solicitacao_compra_id TEXT NOT NULL,

    numero_item INTEGER NOT NULL,
    descricao TEXT NOT NULL,

    quantidade REAL NOT NULL,
    unidade TEXT NOT NULL,

    valor_unitario REAL NOT NULL,

    especificacoes TEXT,
    codigo_fornecedor TEXT,

    data_criacao TEXT DEFAULT CURRENT_TIMESTAMP,
    data_atualizacao TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (solicitacao_compra_id)
        REFERENCES solicitacoes_compra(id)
        ON DELETE CASCADE,

    UNIQUE (solicitacao_compra_id, numero_item)
)'), ('CREATE TABLE jornadas_voo (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),

  solicitacao_id TEXT NOT NULL,
  aeronave_id TEXT,

  numero_jornada INTEGER NOT NULL,
  data_jornada TEXT NOT NULL,

  apresentacao_em TEXT NOT NULL,
  inicio_em TEXT,
  fim_em TEXT,

  minutos_pos_corte INTEGER NOT NULL DEFAULT 45,

  status TEXT NOT NULL DEFAULT ''aberta'',

  observacoes TEXT,
  criado_por TEXT,

  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  limite_jornada_minutos INTEGER,
  limite_tempo_voo_minutos INTEGER,

  nivel_alerta_jornada TEXT NOT NULL DEFAULT ''normal''
, tripulante_id TEXT NULL, data TEXT NULL, horario_acionamento TEXT NULL, horario_apresentacao TEXT NULL, horario_corte_inicio TEXT NULL, horario_corte_final TEXT NULL)'), ('CREATE TABLE justificativa_ausencia (
    id TEXT PRIMARY KEY NOT NULL,

    id_usuario TEXT NOT NULL,

    data_registro TEXT NOT NULL,

    justificativa TEXT NOT NULL,

    url_documento TEXT,

    status TEXT NOT NULL DEFAULT ''pendente'',

    aprovado_por TEXT,

    aprovado_em TEXT,

    motivo_rejeicao TEXT,

    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE lancamento_ponto (
    id TEXT PRIMARY KEY NOT NULL,

    user_id TEXT NOT NULL,

    data_entrada TEXT NOT NULL DEFAULT (date(''now'')),

    entrada_hora TEXT,
    inicio_almoco TEXT,
    fim_almoco TEXT,
    saida_hora TEXT,

    horas_totais REAL,

    status TEXT NOT NULL DEFAULT ''not_started'',

    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,

    ausencia_aprovada INTEGER,
    ausencia_aprovada_por TEXT,
    ausencia_aprovada_em TEXT,

    motivo_da_ausencia TEXT
)'), ('CREATE TABLE lancamento_ponto_anexos (
    id TEXT PRIMARY KEY NOT NULL,

    lancamento_ponto_id TEXT,

    user_id TEXT NOT NULL,

    data_entrada TEXT NOT NULL,

    caminho_arquivo TEXT NOT NULL,
    nome_arquivo TEXT NOT NULL,

    tipo_arquivo TEXT,

    tipo_justificativa TEXT NOT NULL DEFAULT ''medical'',

    observacoes TEXT,

    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (lancamento_ponto_id)
        REFERENCES lancamento_ponto(id)
        ON DELETE CASCADE
)'), ('CREATE TABLE lancamentos (
  id TEXT PRIMARY KEY NOT NULL,

  aeronave_id TEXT 
    REFERENCES aeronave(id),

  cotista_aeronave_id TEXT 
    REFERENCES cotista_aeronave(id),

  colaborador_id TEXT 
    REFERENCES user_profiles(id),
periodicidade TEXT
    CHECK (periodicidade IN (
      ''ÚNICO'', ''EVENTUAL'', ''MENSAL'', ''BIMESTRAL'', ''TRIMESTRAL'', ''SEMESTRAL'', ''ANUAL''
    )),
  
  data_emissao TEXT,
  data_vencimento TEXT,
  data_pagamento TEXT,
  data_competencia_demonstrativo TEXT,

  descricao TEXT NOT NULL,

  fornecedores_favoritos_id TEXT 
    REFERENCES fornecedores_favoritos(id),

  fornecedor_nome TEXT,
  abastecimentos_id TEXT 
    REFERENCES abastecimentos(id),
  categoria_id TEXT 
    REFERENCES categoria_movimentacao_share(id),
 categoria_cliente_id TEXT 
    REFERENCES categoria_movimentacao_cliente(id),
status TEXT

    CHECK (status IN (

     ''EM_ABERTO'', ''PAGO'', ''RECEITA'',''EM_ATRASO'',''ESTORNO'', ''RECEBIDO'',''SAIDA'',  ''ENTRADA'',''SAIDA_REEMBOLSO'', ''ENTRADA_REEMBOLSO'',''AGUARDANDO_REEMBOLSO'', ''REEMBOLSADO'', ''CANCELADO'')),
  categoria_nome TEXT,
  grupo_categoria TEXT,

  fluxo TEXT NOT NULL
    CHECK (fluxo IN (
      ''RECEITA'',
  	''ESTORNO'',
      ''DESPESA'',
      ''REEMBOLSO'',
      ''ENTRADA'',
      ''SAIDA''
    )),

tipo_caixa TEXT NOT NULL
    CHECK (tipo_caixa IN (''SHARE'', ''CLIENTE'' , ''HOLDING'')),
  valor_centavos INTEGER NOT NULL
    CHECK (valor_centavos > 0),

  numero_nf TEXT,
  numero_recibo TEXT,
  numero_boleto TEXT,
  numero_doc TEXT,
numero_demonstrativo TEXT,
  url_demonstrativo TEXT,
  url_nf TEXT,
  url_recibo TEXT,
  url_boleto TEXT,
  url_doc TEXT,

  conta_bancaria_id TEXT 
    REFERENCES contas_bancarias(id),

  pago_por_cotista_aeronave_id TEXT 
    REFERENCES cotista_aeronave(id),

  pago_por TEXT 
    REFERENCES user_profiles(id),

  pago_diretamente INTEGER NOT NULL DEFAULT 0
    CHECK (pago_diretamente IN (0, 1)),

  reembolsavel INTEGER NOT NULL DEFAULT 0
    CHECK (reembolsavel IN (0, 1)),

  reembolso_quitado INTEGER NOT NULL DEFAULT 0
    CHECK (reembolso_quitado IN (0, 1)),

  forma_pagamento TEXT,

  comprovante_url TEXT,

  observacoes TEXT,

  anexos_json TEXT NOT NULL DEFAULT ''[]'',

  criado_por TEXT,

  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  origem_tipo TEXT,


  idempotency_key TEXT
)'), ('CREATE TABLE lancamentos_diario_bordo (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  numero_sequencial INTEGER,
  diario_mes_id TEXT NOT NULL,
  numero_voo TEXT,
  jornada_id TEXT,
  aeronave_id TEXT NOT NULL,
  cliente_id TEXT,
  socio_id TEXT,
  voo_emprestado INTEGER DEFAULT 0,
  socio_tomador_emprestimo_id TEXT,
  cliente_tomador_emprestimo_id TEXT,
  data_registro TEXT NOT NULL,
  aerodromo_partida TEXT NOT NULL,
  aerodromo_chegada TEXT NOT NULL,
  trecho TEXT,
  pic_canac TEXT NOT NULL,
  pic_nome TEXT,
  sic_canac TEXT,
  sic_nome TEXT,
  tripulacao_checkin_hora TEXT,
  tempo_ac TEXT,
  tempo_dep TEXT,
  tempo_pou TEXT,
  tempo_cor TEXT,
  tempo_ifr REAL DEFAULT 0,
  tempo_voo REAL DEFAULT 0,
  tempo_total REAL DEFAULT 0,
  horas_diurnas REAL DEFAULT 0,
  horas_noturnas REAL DEFAULT 0,
  pousos_total INTEGER DEFAULT 0,
  distancia_nm REAL DEFAULT 0,
  diarias TEXT,
  consumo_combustivel_voo REAL DEFAULT 0,
  consumo_combustivel_total REAL,
  litros_combustivel_inicio_voo REAL DEFAULT 0,
  litros_combustivel_abastecido REAL DEFAULT 0,
  local_combustivel TEXT,
  abastecido INTEGER DEFAULT 0,
  celula REAL DEFAULT 0,
  confirmado INTEGER DEFAULT 0,
  confirmado_em TEXT,
  assinado_pic TEXT,
  data_assinatura TEXT,
  passageiros INTEGER DEFAULT 0,
  carga_kg TEXT,
  natureza_voo TEXT NOT NULL,
  ocorrencias TEXT,
  discrepancias TEXT,
  acoes_corretivas TEXT,
  tipo_manutencao_ultima TEXT,
  tipo_manutencao_proxima TEXT,
  responsavel_aprovacao_manutencao TEXT,
  detectado_por TEXT,
  criado_por TEXT,
  FOREIGN KEY (diario_mes_id) REFERENCES diario_mes(id),
  FOREIGN KEY (aeronave_id) REFERENCES aeronave(id)
)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE lancamentos_financeiros_rh (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    empresa_id TEXT NOT NULL,
    origem_tipo TEXT NOT NULL
        CHECK (origem_tipo IN (''FOLHA'', ''FERIAS'', ''DECIMO_TERCEIRO'', ''RESCISAO'', ''PAGAMENTO_FOLHA'')),
    origem_id TEXT NOT NULL,
    tipo TEXT NOT NULL,
    descricao TEXT NOT NULL,
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
    data_vencimento TEXT NOT NULL,
    data_pagamento TEXT,
    status TEXT NOT NULL DEFAULT ''AGUARDANDO_APROVACAO''
        CHECK (status IN (''RASCUNHO'', ''AGUARDANDO_APROVACAO'', ''APROVADO'', ''AGENDADO'', ''PAGO'', ''REJEITADO'', ''CANCELADO'')),
    conta_pagamento_id TEXT,
    criado_por TEXT NOT NULL,
    aprovado_por TEXT,
    aprovado_em TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (empresa_id)
        REFERENCES empresa(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (conta_pagamento_id)
        REFERENCES contas_bancarias(id)
        ON DELETE SET NULL,
    FOREIGN KEY (criado_por)
        REFERENCES user_profiles(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (aprovado_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL,

    UNIQUE (origem_tipo, origem_id)
)'), ('CREATE TABLE lembretes_calendario (
    id TEXT PRIMARY KEY NOT NULL,

    usuario_id TEXT NOT NULL,

    titulo TEXT NOT NULL,
    descricao TEXT,

    data TEXT NOT NULL,
    hora TEXT,

    visibilidade TEXT NOT NULL DEFAULT ''PRIVADO'',

    cor_categoria_id TEXT,

    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (cor_categoria_id)
        REFERENCES categorias_calendario(id)
        ON DELETE SET NULL,

    FOREIGN KEY (usuario_id)
        REFERENCES user_profiles(id)
        ON DELETE CASCADE,

    CHECK (
        visibilidade IN (''PRIVADO'', ''TODOS'')
    )
)'), ('CREATE TABLE manual_tutoriais (
    id TEXT PRIMARY KEY NOT NULL,

    titulo TEXT NOT NULL,

    descricao TEXT NOT NULL,

    video_url TEXT,

    conteudo_html TEXT,

    categoria TEXT NOT NULL DEFAULT ''GERAL'',

    ordem INTEGER NOT NULL DEFAULT 0,

    criado_por TEXT,

    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP, tema TEXT, arquivo_url TEXT, tipo_arquivo TEXT, tamanho_arquivo INTEGER, publicado INTEGER NOT NULL DEFAULT 1,

    FOREIGN KEY (criado_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE mensagens (id TEXT PRIMARY KEY NOT NULL, remetente_id TEXT NOT NULL, destinatario_id TEXT NOT NULL, assunto TEXT, conteudo TEXT NOT NULL, lida INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'), ('CREATE TABLE mensagens_internas (
    id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),

    remetente_id TEXT NOT NULL,

    assunto TEXT NOT NULL DEFAULT '''',
    corpo TEXT NOT NULL DEFAULT '''',

    rascunho INTEGER NOT NULL DEFAULT 0,

    remetente_excluiu INTEGER NOT NULL DEFAULT 0,
    remetente_arquivou INTEGER NOT NULL DEFAULT 0,

    mensagem_pai_id TEXT NULL,

    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (mensagem_pai_id)
        REFERENCES mensagens_internas(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE mensagens_usuario (mensagem_id TEXT NOT NULL, usuario_id TEXT NOT NULL, papel TEXT NOT NULL CHECK (papel IN (''remetente'', ''destinatario'')), lida INTEGER NOT NULL DEFAULT 0, favorita INTEGER NOT NULL DEFAULT 0, arquivada INTEGER NOT NULL DEFAULT 0, excluida INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (mensagem_id, usuario_id))'), ('CREATE TABLE movimentos_holding (
  id TEXT PRIMARY KEY NOT NULL,
  holding_id TEXT REFERENCES holdings(id),
  socio_id TEXT REFERENCES hold_socios(id),
  aeronave_id TEXT REFERENCES aeronave(id),
   periodicidade TEXT
    CHECK (periodicidade IN (
      ''ÚNICO'', ''EVENTUAL'', ''MENSAL'', ''BIMESTRAL'', ''TRIMESTRAL'', ''SEMESTRAL'', ''ANUAL''
    )),
  tipo_caixa TEXT NOT NULL
    CHECK (tipo_caixa IN (''SHARE'', ''HOLD'')),
  colaborador_id TEXT 
    REFERENCES user_profiles(id),
  data_emissao TEXT,
  data_vencimento TEXT,
  data_pagamento TEXT,
  data_competencia_demonstrativo TEXT,
  descricao TEXT NOT NULL,
    abastecimentos_id TEXT 
    REFERENCES abastecimentos(id),
  fornecedor_id TEXT REFERENCES fornecedores_favoritos(id),
  fornecedor_nome TEXT,
  categoria_id TEXT REFERENCES categoria_movimentacao_cliente(id),
  categoria_nome TEXT,
  grupo_categoria TEXT,
  fluxo TEXT NOT NULL CHECK (fluxo IN (''APORTE'',''ESTORNO'',
      ''REEMBOLSO'',
      ''ENTRADA'',
      ''SAIDA''
    )),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  status TEXT NOT NULL CHECK (status IN (''EM_ABERTO'', ''PAGO'', ''RECEBIDO'', ''ENTRADA'', ''APORTE_MENSAL'',''RENDIMENTO_BANCARIO'', ''AGUARDANDO_REEMBOLSO'', ''REEMBOLSADO'', ''CANCELADO'')),
  pago_diretamente INTEGER NOT NULL DEFAULT 0 CHECK (pago_diretamente IN (0, 1)),
  conta_bancaria_id TEXT REFERENCES contas_bancarias(id),
  forma_pagamento TEXT,
  comprovante_url TEXT,
  numero_nf TEXT,
  numero_recibo TEXT,
  numero_boleto TEXT,
  numero_doc TEXT,
numero_demonstrativo TEXT,
  url_demonstrativo TEXT,
  url_nf TEXT,
  url_recibo TEXT,
  url_boleto TEXT,
  url_doc TEXT,
  observacoes TEXT,
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE notas_fiscais_saida (
    id TEXT PRIMARY KEY NOT NULL,
    numero TEXT NOT NULL,
        lancamentos_id TEXT NULL,
      cotista_id TEXT NULL,
    aeronave_id TEXT NULL,
    valor_total REAL NULL,
    percentual REAL NULL,
    descricao_servico TEXT NOT NULL,
    nome_categoria TEXT NULL,
    categoria_id TEXT NULL,
    subcategoria_1 TEXT NULL,
    subcategoria_2 TEXT NULL,
    subcategoria_3 TEXT NULL,
    subcategoria_4 TEXT NULL,
    data_emissao TEXT NOT NULL,
    data_vencimento TEXT NULL,
    status TEXT NULL DEFAULT ''EM_ABERTO'',
    arquivo_pdf_url TEXT NULL,

    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
   FOREIGN KEY (cotista_id)
        REFERENCES cotista_aeronave(id)
        ON DELETE SET NULL
    FOREIGN KEY (aeronave_id)
        REFERENCES aeronave(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE pagamentos_folha (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    empresa_id TEXT NOT NULL,
    folha_id TEXT,
    user_id TEXT NOT NULL,
    tipo_pagamento TEXT NOT NULL
        CHECK (tipo_pagamento IN (''SALARIO'', ''FERIAS'', ''DECIMO_TERCEIRO'', ''RESCISAO'', ''ADIANTAMENTO'', ''OUTRO'')),
    competencia_ano INTEGER,
    competencia_mes INTEGER CHECK (competencia_mes IS NULL OR competencia_mes BETWEEN 1 AND 12),
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
    data_prevista TEXT NOT NULL,
    data_pagamento TEXT,
    status TEXT NOT NULL DEFAULT ''PENDENTE''
        CHECK (status IN (
            ''PENDENTE'',
            ''AGUARDANDO_APROVACAO'',
            ''APROVADO'',
            ''AGENDADO'',
            ''PAGO'',
            ''REJEITADO'',
            ''CANCELADO''
        )),
    comprovante_url TEXT,
    criado_por TEXT NOT NULL,
    aprovado_por TEXT,
    aprovado_em TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (empresa_id)
        REFERENCES empresa(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (folha_id)
        REFERENCES folhas_pagamento(id)
        ON DELETE SET NULL,
    FOREIGN KEY (user_id)
        REFERENCES user_profiles(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (criado_por)
        REFERENCES user_profiles(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (aprovado_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE pastas_documentos (
    id TEXT PRIMARY KEY NOT NULL,
    nome TEXT NOT NULL,
    pasta_pai_id TEXT,
    criado_por TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    restrita INTEGER DEFAULT 0,

    FOREIGN KEY (pasta_pai_id)
        REFERENCES pastas_documentos(id)
        ON DELETE CASCADE
)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE performance_aeronave (
    id TEXT PRIMARY KEY NOT NULL,
    categoria TEXT NOT NULL,
    modelo TEXT NOT NULL,
    teto_servico_ft INTEGER NOT NULL,
    nivel_cruzeiro_min_ft INTEGER NOT NULL,
    nivel_cruzeiro_max_ft INTEGER NOT NULL,
    aprovado_rvsm INTEGER NOT NULL DEFAULT 1,
    velocidade_cruzeiro_kt INTEGER NULL,
    taxa_subida_fpm INTEGER NULL,
    taxa_descida_fpm INTEGER NULL,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE periodos_aquisitivos_ferias (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    empresa_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    data_inicio TEXT NOT NULL,
    data_fim TEXT NOT NULL,
    data_limite_concessao TEXT,
    dias_direito INTEGER NOT NULL DEFAULT 30 CHECK (dias_direito >= 0),
    dias_gozados INTEGER NOT NULL DEFAULT 0 CHECK (dias_gozados >= 0),
    dias_abono INTEGER NOT NULL DEFAULT 0 CHECK (dias_abono >= 0),
    dias_disponiveis INTEGER NOT NULL DEFAULT 30 CHECK (dias_disponiveis >= 0),
    status TEXT NOT NULL DEFAULT ''ABERTO''
        CHECK (status IN (''ABERTO'', ''PARCIALMENTE_GOZADO'', ''GOZADO'', ''VENCIDO'', ''CANCELADO'')),
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (empresa_id)
        REFERENCES empresa(id)
        ON DELETE RESTRICT,
    FOREIGN KEY (user_id)
        REFERENCES user_profiles(id)
        ON DELETE RESTRICT,

    CHECK (date(data_fim) >= date(data_inicio)),
    CHECK (dias_gozados + dias_abono <= dias_direito)
)'), ('CREATE TABLE pernas_jornada_voo (id TEXT PRIMARY KEY NOT NULL, jornada_id TEXT NOT NULL, numero INTEGER NOT NULL, origem TEXT NOT NULL, destino TEXT NOT NULL, horario_ac TEXT NULL, horario_dep TEXT NULL, horario_pouso TEXT NULL, horario_corte TEXT NULL, status TEXT NOT NULL DEFAULT ''em_voo'', lancamento_diario_id TEXT NULL, criado_em TEXT DEFAULT CURRENT_TIMESTAMP)'), ('CREATE TABLE planos_voo (
    id TEXT PRIMARY KEY NOT NULL,
    numero_voo TEXT NULL,
    adep TEXT NOT NULL,
    ades TEXT NOT NULL,
    data_voo TEXT NULL,
    eobt TEXT NULL,
    payload_json TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )'), ('CREATE TABLE rateio_despesas (
  id TEXT PRIMARY KEY NOT NULL,
  lancamento_id TEXT REFERENCES lancamentos(id),
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id),
  cotista_id TEXT NOT NULL REFERENCES cotista_aeronave(id),
   data_emissao TEXT,
  data_vencimento TEXT,
  data_pagamento TEXT,
  data_competencia_demonstrativo TEXT,
  categoria_id TEXT REFERENCES categoria_movimentacao_cliente(id),
  categoria_nome TEXT,

    subcategoria_1 TEXT NULL,
    subcategoria_2 TEXT NULL,
    subcategoria_3 TEXT NULL,
    subcategoria_4 TEXT NULL,
  fornecedor_id TEXT REFERENCES fornecedores_favoritos(id),
  tipo_rateio TEXT NOT NULL CHECK (tipo_rateio IN (''FIXO'', ''VARIAVEL_POR_VOO'', ''VARIAVEL_POR_HORA'', ''EXTRA'')),
 periodicidade TEXT
    CHECK (periodicidade IN (
      ''ÚNICO'', ''EVENTUAL'', ''MENSAL'', ''BIMESTRAL'', ''TRIMESTRAL'', ''SEMESTRAL'', ''ANUAL''
    )),
  percentual_sociedade REAL,
  percentual_uso REAL,
  valor_total_centavos INTEGER NOT NULL CHECK (valor_total_centavos > 0),
  valor_rateado_centavos INTEGER NOT NULL CHECK (valor_rateado_centavos > 0),
  valor_pago_real_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_pago_real_centavos >= 0),
  pago_por_cotista_id TEXT REFERENCES cotista_aeronave(id),
  pago_diretamente INTEGER NOT NULL DEFAULT 0 CHECK (pago_diretamente IN (0, 1)),
status TEXT

    CHECK (status IN (

     ''EM_ABERTO'', ''PAGO'',''PAGO_DIRETAMENTE'' , ''EM_ATRASO'', ''ESTORNO'', ''SAIDA'',

   ''AGUARDANDO_REEMBOLSO'',

     ''REEMBOLSADO'', ''CANCELADO''

    )),
  descricao_despesa TEXT,
  observacoes TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, documento_url TEXT, documento_numero TEXT, origem_id TEXT, origem_tipo TEXT)'), ('CREATE TABLE rateio_hold (
  id TEXT PRIMARY KEY NOT NULL,
  movimento_holding_id TEXT REFERENCES movimentos_holding(id),
  aeronave_id TEXT NOT NULL REFERENCES aeronave(id),
  socio_id TEXT NOT NULL REFERENCES hold_socios(id),
   data_emissao TEXT,
  data_vencimento TEXT,
  data_pagamento TEXT,
  data_competencia_demonstrativo TEXT,
  categoria_id TEXT REFERENCES categoria_movimentacao_cliente(id),
  categoria_nome TEXT,
      subcategoria_1 TEXT NULL,
    subcategoria_2 TEXT NULL,
    subcategoria_3 TEXT NULL,
    subcategoria_4 TEXT NULL,
  periodicidade TEXT
    CHECK (periodicidade IN (
      ''ÚNICO'', ''EVENTUAL'', ''MENSAL'', ''BIMESTRAL'', ''TRIMESTRAL'', ''SEMESTRAL'', ''ANUAL''
    )),
  tipo_rateio TEXT NOT NULL CHECK (tipo_rateio IN (''FIXO'', ''VARIAVEL_POR_VOO'', ''VARIAVEL_POR_HORA'', ''EXTRA'')),
  percentual_sociedade REAL,
  percentual_uso REAL,
  valor_total_centavos INTEGER NOT NULL CHECK (valor_total_centavos > 0),
  valor_rateado_centavos INTEGER NOT NULL CHECK (valor_rateado_centavos > 0),
  valor_pago_real_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_pago_real_centavos >= 0),
  pago_por_socio_id TEXT REFERENCES hold_socios(id),
  pago_diretamente INTEGER NULL DEFAULT 0 CHECK (pago_diretamente IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN (''EM_ABERTO'', ''PAGO'',''PAGO_DIRETAMENTE'', ''RECEBIDO'',''SAIDA'',''ESTORNO'', ''EM_ATRASO'',  ''ENTRADA'', ''AGUARDANDO_REEMBOLSO'', ''REEMBOLSADO'', ''CANCELADO'')),
  descricao_despesa TEXT,
  observacoes TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, origem_tipo TEXT, origem_id TEXT, documento_numero TEXT, documento_url TEXT)'), ('CREATE TABLE rateio_pagamentos (
  id TEXT PRIMARY KEY NOT NULL,

  rateio_id TEXT NOT NULL
    REFERENCES rateio_despesas(id),

  recibo_id TEXT NULL
    REFERENCES recibos(id),

  conta_receber_id TEXT NULL,

  tipo_pagador TEXT NOT NULL
    CHECK (
      tipo_pagador IN (
        ''COTISTA'',
        ''SHARE'',
        ''HOLDING''
      )
    ),

  pagador_cotista_id TEXT NULL
    REFERENCES cotista_aeronave(id),

  pagador_holding_id TEXT NULL
    REFERENCES holdings(id),

  valor_centavos INTEGER NOT NULL
    CHECK (valor_centavos > 0),

  data_pagamento TEXT NOT NULL,

  conta_bancaria_id TEXT NULL
    REFERENCES contas_bancarias(id),

  comprovante_url TEXT NULL,

  forma_pagamento TEXT NULL,

  status TEXT NOT NULL DEFAULT ''CONFIRMADO''
    CHECK (
      status IN (
        ''PENDENTE'',
        ''CONFIRMADO'',
        ''ESTORNADO'',
        ''CANCELADO''
      )
    ),

  observacoes TEXT NULL,

  criado_por TEXT NULL,

  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, idempotency_key TEXT)'), ('CREATE TABLE recados (
    id TEXT PRIMARY KEY NOT NULL,

    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,

    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,

    autor_id TEXT NOT NULL,

    mensagem TEXT NOT NULL,

    fixado INTEGER NOT NULL DEFAULT 0,

    departamento_id TEXT NULL,

    lido_por TEXT NOT NULL DEFAULT ''[]'',

    FOREIGN KEY (autor_id)
        REFERENCES user_profiles(id)
        ON DELETE CASCADE,

    FOREIGN KEY (departamento_id)
        REFERENCES usuarios_funcoes(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE recibo_anexos (id TEXT PRIMARY KEY NOT NULL, nome_arquivo TEXT NOT NULL, caminho_arquivo TEXT NOT NULL, tipo_arquivo TEXT NOT NULL, tamanho_arquivo INTEGER NOT NULL DEFAULT 0, enviado_por TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, recibo_id TEXT, finalidade TEXT)'), ('CREATE TABLE recibo_rateio (
  id TEXT PRIMARY KEY NOT NULL,
  recibo_id TEXT NOT NULL REFERENCES recibos(id),
  rateio_id TEXT,
  percentual REAL, -- percentual (ex: 33.33), não é valor monetário
  valor INTEGER NOT NULL DEFAULT 0, -- valor rateado em centavos
  cotista_id TEXT REFERENCES cotista_aeronave(id)
)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE recibos (
  id TEXT PRIMARY KEY NOT NULL,
  numero_recibo TEXT UNIQUE,

  tipo_recibo TEXT NOT NULL CHECK (
    tipo_recibo IN (
      ''recibo_reembolso'',
      ''recibo_colaborador'',
      ''recibo_pagamento''
    )
  ),

  colaborador_id TEXT REFERENCES user_profiles(id),
  aeronave_id TEXT REFERENCES aeronave(id),

  rateado INTEGER NOT NULL DEFAULT 0 CHECK (rateado IN (0,1)),

  pagador_tipo TEXT NOT NULL CHECK (
    pagador_tipo IN (''empresa'',''cotista_aeronave'')
  ),

  pagador_id TEXT NOT NULL,
  nome_pagador TEXT,
  documento_pagador TEXT,
  endereco_pagador TEXT,
  cidade_pagador TEXT,
  uf_pagador TEXT,

  valor INTEGER NOT NULL DEFAULT 0,
  descricao TEXT,
  data_emissao TEXT,
  data_vencimento TEXT,
  forma_pagamento TEXT,

  tipo_caixa TEXT NOT NULL CHECK (
    tipo_caixa IN (''share'',''cliente'',''holding'')
  ),

  categoria_movimentacao_id TEXT NOT NULL,
  grupo_categoria TEXT,

  status TEXT,

  lancamento_id TEXT,
  criado_por TEXT,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
  url_recibo TEXT,
  recebedor_nome TEXT,
  numero_documento_anexo TEXT,
  observacoes TEXT
)'), ('CREATE TABLE recibos_saida (
    id TEXT PRIMARY KEY NOT NULL,
    numero_recibo TEXT NOT NULL,
    sequencia_numeros_recibo_saida_id TEXT,
    cotista_id TEXT NULL,
    aeronave_id TEXT NULL,
    valor_total REAL NULL,
    percentual REAL NULL,
    descricao_servico TEXT NOT NULL,
    nome_categoria TEXT NULL,
    categoria_id TEXT NULL,
    subcategoria_1 TEXT NULL,
    subcategoria_2 TEXT NULL,
    subcategoria_3 TEXT NULL,
    subcategoria_4 TEXT NULL,
    data_emissao TEXT NOT NULL,
    data_vencimento TEXT NULL,
    status TEXT NULL DEFAULT ''EM_ABERTO'',
    pdf_url TEXT NULL,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    contas_areceber_id TEXT NULL,
    lancamentos_id TEXT NULL,
    criado_por TEXT NULL,
    FOREIGN KEY (aeronave_id)
        REFERENCES aeronave(id)
        ON DELETE SET NULL,
    FOREIGN KEY (cotista_id)
        REFERENCES cotista_aeronave(id)
        ON DELETE SET NULL,
    FOREIGN KEY (criado_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL,
    FOREIGN KEY (sequencia_numeros_recibo_saida_id)
        REFERENCES sequencia_numeros_recibo_saida(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE reembolsos (
  id TEXT PRIMARY KEY NOT NULL,
  lancamento_origem_id TEXT NOT NULL,
  conta_receber_id TEXT,
  colaborador_id TEXT,
  cotista_id TEXT,
  valor_centavos INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT ''PENDENTE'',
  recebido_em TEXT,
  idempotency_key TEXT UNIQUE,
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)'), ('CREATE TABLE relatorio_despesa_viagem (
    id                              TEXT PRIMARY KEY NOT NULL,
    numero_relatorio                TEXT NOT NULL,
    numero_voo                      TEXT NULL,
    cliente_id                      TEXT NULL,
    socio_id                        TEXT NULL,
    aeronave_id                     TEXT NULL,
    rota                            TEXT NULL,
    data_inicio                     TEXT NOT NULL,
    data_fim                        TEXT NOT NULL,
    quantidade_dias                 INTEGER NOT NULL,
    observacoes                     TEXT NULL,
    total_valor                     REAL NULL DEFAULT 0,
    total_combustivel               REAL NULL DEFAULT 0,
    total_hospedagem                REAL NULL DEFAULT 0,
    total_alimentacao               REAL NULL DEFAULT 0,
    total_transporte                REAL NULL DEFAULT 0,
    total_outros                    REAL NULL DEFAULT 0,
    total_tripulacao                REAL NULL DEFAULT 0,
    total_cliente                   REAL NULL DEFAULT 0,
    total_sharebrasil               REAL NULL DEFAULT 0,
    matricula_aeronave              TEXT NULL,
    despesas                        TEXT NULL,
    status                          TEXT NULL,
    total_tripulante_1              REAL NULL DEFAULT 0,
    total_tripulante_2              REAL NULL DEFAULT 0,
    tripulacao_id                   TEXT NULL,
    nome_tripulante                TEXT NULL,
    tripulante_id_2                 TEXT NULL,
    nome_tripulante_2               TEXT NULL,
    criado_por                      TEXT NULL,
    token_aprovacao                 TEXT NULL,
    requer_aprovacao_cliente        INTEGER NULL DEFAULT 0,
    status_aprovacao_tripulante     TEXT NULL DEFAULT ''pendente'',
    observacoes_aprovacao_tripulante TEXT NULL,
    status_aprovacao_tripulante_2   TEXT NULL,
    aprovado_tripulante_2_em        TEXT NULL,
    observacoes_aprovacao_tripulante_2 TEXT NULL,
    gerado_por_usuario_id           TEXT NULL,
    contas_apagar_tripulante_1_id   TEXT NULL,
    contas_apagar_tripulante_2_id   TEXT NULL,
    enviado_para_tripulante_em      TEXT NULL,
    enviado_para_tripulante_2_em    TEXT NULL,
    enviado_para_cliente_em         TEXT NULL,
    criado_em                       TEXT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em                   TEXT NULL DEFAULT CURRENT_TIMESTAMP,
    pdf_url TEXT,
    pdf_path TEXT
)'), ('CREATE TABLE relatorio_despesa_viagem_anexos (
    id                          TEXT PRIMARY KEY NOT NULL,

    relatorio_despesa_viagem_id TEXT NULL,

    indice_despesa              INTEGER NOT NULL,

    nome_arquivo                TEXT NOT NULL,
    caminho_arquivo             TEXT NOT NULL,
    url_arquivo                 TEXT NOT NULL,

    tipo_arquivo                TEXT NULL,
    tamanho_arquivo             INTEGER NULL,

    criado_em                   TEXT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (relatorio_despesa_viagem_id)
        REFERENCES "relatorio_despesa_viagem_legacy2" (id)
        ON DELETE CASCADE
)'), ('CREATE TABLE relatorios_despesa_viagem (
    id TEXT PRIMARY KEY NOT NULL,
    numero_relatorio TEXT NOT NULL,
    numero_voo TEXT,
    cliente_id TEXT,
    socio_id TEXT,
    aeronave_id TEXT,
    rota TEXT,
    data_inicio TEXT NOT NULL,
    data_fim TEXT NOT NULL,
    quantidade_dias INTEGER NOT NULL DEFAULT 1,
    tripulacao_id TEXT,
    nome_tripulante TEXT,
    tripulante_id_2 TEXT,
    nome_tripulante_2 TEXT,
    despesas TEXT NOT NULL DEFAULT ''[]'',
    total_valor REAL NOT NULL DEFAULT 0,
    observacoes TEXT,
    status TEXT NOT NULL DEFAULT ''rascunho'',
    pdf_url TEXT,
    criado_por TEXT,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
  )'), ('CREATE TABLE reservas_hoteis (id TEXT PRIMARY KEY NOT NULL, hotel_id TEXT NOT NULL, criado_por TEXT, data_checkin TEXT NOT NULL, data_checkout TEXT NOT NULL, tipo_quarto TEXT, quantidade_hospedes INTEGER NOT NULL, hospede_nome TEXT NOT NULL, hospede_telefone TEXT NOT NULL, hospede_email TEXT, observacoes TEXT, destinatario_email TEXT NOT NULL, status TEXT NOT NULL DEFAULT ''SOLICITADA'', criado_em TEXT DEFAULT CURRENT_TIMESTAMP)'), ('CREATE TABLE senhas (
    id TEXT PRIMARY KEY NOT NULL,
    titulo TEXT NOT NULL,

    site TEXT NOT NULL,
    login TEXT NOT NULL,
    senha TEXT NOT NULL,

    observacoes TEXT,

    criado_por TEXT,

    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,

    setor TEXT,

    FOREIGN KEY (criado_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE sequencia_numeros_recibo_saida (
  id TEXT PRIMARY KEY NOT NULL,
  cotista_aeronave_id TEXT NOT NULL,
  codigo_cliente TEXT NOT NULL,
  ano TEXT NOT NULL,
  proximo_numero INTEGER NOT NULL DEFAULT 1,
  UNIQUE (codigo_cliente, ano),
  FOREIGN KEY (cotista_aeronave_id)
    REFERENCES cotista_aeronave(id)
    ON DELETE CASCADE
)'), ('CREATE TABLE sequencia_numeros_recibos (
  id TEXT PRIMARY KEY NOT NULL,
  cotista_aeronave_id TEXT NOT NULL,
  codigo_cliente TEXT NOT NULL,
  ano TEXT NOT NULL,
  proximo_numero INTEGER NOT NULL DEFAULT 1,
  UNIQUE (codigo_cliente, ano),
  FOREIGN KEY (cotista_aeronave_id)
    REFERENCES cotista_aeronave(id)
    ON DELETE CASCADE
)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE short_links (code TEXT PRIMARY KEY NOT NULL, r2_key TEXT NOT NULL, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'), ('CREATE TABLE solicitacoes_compra (
    id TEXT PRIMARY KEY NOT NULL,

    numero_solicitacao TEXT NOT NULL,
    tipo TEXT NOT NULL,
    descricao TEXT NOT NULL,
    observacoes TEXT,

    user_id TEXT NOT NULL,

    data_solicitacao TEXT DEFAULT CURRENT_TIMESTAMP,
    data_necessaria TEXT,

    status TEXT DEFAULT ''RASCUNHO'',

    aprovador_1_id TEXT,
    data_aprovacao_1 TEXT,
    motivo_rejeicao_1 TEXT,

    aprovador_2_id TEXT,
    data_aprovacao_2 TEXT,
    motivo_rejeicao_2 TEXT,

    prioridade TEXT,
    tipo_servico TEXT,

    solicitante_nome TEXT,
    departamento TEXT,
    centro_custo TEXT,

    data_criacao TEXT DEFAULT CURRENT_TIMESTAMP,
    data_atualizacao TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES user_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (aprovador_1_id) REFERENCES user_profiles(id) ON DELETE SET NULL,
    FOREIGN KEY (aprovador_2_id) REFERENCES user_profiles(id) ON DELETE SET NULL
)'), ('CREATE TABLE solicitacoes_correcao_ponto (
    id TEXT PRIMARY KEY NOT NULL,

    user_id TEXT NOT NULL,

    data_entrada TEXT NOT NULL,

    lancamento_ponto_id TEXT,

    tipo_correcao TEXT NOT NULL,

    tempo_original TEXT,

    tempo_corrigido TEXT NOT NULL,

    justificativa TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT ''pending'',

    aprovado_por TEXT,

    aprovado_em TEXT,

    motivo_rejeicao TEXT,

    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (lancamento_ponto_id)
        REFERENCES lancamento_ponto(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE "solicitacoes_ferias" (id TEXT PRIMARY KEY, colaborador_id TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE, data_inicio TEXT NOT NULL, data_fim TEXT NOT NULL, quantidade_dias INTEGER NOT NULL CHECK (quantidade_dias > 0), status TEXT NOT NULL DEFAULT ''solicitada'' CHECK (status IN (''solicitada'', ''aprovada'', ''reprovada'', ''cancelada'')), observacoes TEXT, motivo_reprovacao TEXT, aprovado_por TEXT, aprovado_em TEXT, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'), ('CREATE TABLE solicitacoes_reserva_voo (
    id TEXT PRIMARY KEY NOT NULL,
    cliente_id TEXT NULL,
    aeronave_id TEXT NOT NULL,
     voo_emprestado TEXT NOT NULL,

    origem TEXT NOT NULL,
    destino TEXT NOT NULL,
    data_agendada TEXT NOT NULL,
    horario_previsto_agendamento TEXT NULL,
    dias_duracao INTEGER NOT NULL DEFAULT 1,
    numero_passageiros INTEGER NOT NULL DEFAULT 1,
    status TEXT NULL,
    observacoes TEXT NULL,
    motivo_rejeicao TEXT NULL,
    criado_em TEXT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NULL DEFAULT CURRENT_TIMESTAMP,
    aprovado_por TEXT NULL,
    aprovado_em TEXT NULL,
    piloto_id TEXT NULL,
    copiloto_id TEXT NULL,
    numero_voo TEXT NULL
, socio_id TEXT NULL, cliente_emprestimo_id TEXT NULL, socio_emprestimo_id TEXT NULL)'), ('CREATE TABLE sqlite_sequence(name,seq)'), ('CREATE TABLE tarefas (
    id TEXT PRIMARY KEY NOT NULL,

    titulo TEXT NOT NULL,
    descricao TEXT,

    status TEXT DEFAULT ''ABERTO'',
    prioridade TEXT DEFAULT ''MEDIA'',

    criado_por TEXT,

    prazo TEXT,

    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,

    publico INTEGER DEFAULT 0,

    origem TEXT NOT NULL DEFAULT ''KANBAN'',

    equipes TEXT NOT NULL DEFAULT ''[]'',

    progresso INTEGER NOT NULL DEFAULT 0,

    atribuido_para TEXT DEFAULT ''[]'',

    status_por_usuario TEXT,

    FOREIGN KEY (criado_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL
)'), ('CREATE TABLE tarefas_comentarios (
    id TEXT PRIMARY KEY NOT NULL,

    tarefa_id TEXT NOT NULL,
    usuario_id TEXT NOT NULL,

    comentario TEXT NOT NULL,

    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (tarefa_id)
        REFERENCES tarefas(id)
        ON DELETE CASCADE,

    FOREIGN KEY (usuario_id)
        REFERENCES user_profiles(id)
        ON DELETE CASCADE
)'), ('CREATE TABLE tarefas_notificacoes (
    id TEXT PRIMARY KEY NOT NULL,

    id_da_tarefa TEXT NOT NULL,

    user_id TEXT NOT NULL,

    mensagem TEXT NOT NULL,

    status_alterado_para TEXT,

    lido INTEGER DEFAULT 0,

    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (id_da_tarefa)
        REFERENCES tarefas(id)
        ON DELETE CASCADE,

    FOREIGN KEY (user_id)
        REFERENCES user_profiles(id)
        ON DELETE CASCADE
)'), ('CREATE TABLE transacoes_beneficios (
    id TEXT PRIMARY KEY NOT NULL,

    cartao_beneficio_id TEXT NOT NULL,

    descricao TEXT NOT NULL,

    valor REAL NOT NULL,

    data_transacao TEXT NOT NULL,

    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    usuario_id TEXT NOT NULL,

    FOREIGN KEY (cartao_beneficio_id)
        REFERENCES cartoes_beneficios(id)
        ON DELETE CASCADE,

    FOREIGN KEY (usuario_id)
        REFERENCES user_profiles(id)
        ON DELETE CASCADE
)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TABLE transferencias (
    id TEXT PRIMARY KEY NOT NULL,
    data TEXT NOT NULL,
    de_cotista TEXT,
    para_cotista TEXT,
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
    descricao TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (de_cotista) REFERENCES cotistas(id),
    FOREIGN KEY (para_cotista) REFERENCES cotistas(id)
)'), ('CREATE TABLE tripulacao (

    id TEXT PRIMARY KEY NOT NULL,

  user_id uuid null,

  canac text not null,

  nome_completo text not null,

  status TEXT DEFAULT ''ativo'',

  tipo_licenca text null,
  
   FOREIGN KEY (user_id)
        REFERENCES user_profiles(id)
        ON DELETE CASCADE

)'), ('CREATE TABLE tripulacao_freelancer 
  (
id TEXT PRIMARY KEY NOT NULL,  
  canac text not null,
  nome_completo text not null,
  data_nascimento text null,
  url_avatar text null,
status TEXT DEFAULT ''ativo'',
  rg text null,
  cpf text null,
 endereco TEXT, 
  cidade TEXT,
  uf TEXT, 
  telefone TEXT,
  aeronave_id TEXT ,
  observacao TEXT
  
)'), ('CREATE TABLE "user_cliente"(
  id TEXT,
  login TEXT,
  senha TEXT,
  nome_exibicao TEXT,
  url_avatar TEXT,
  criado_em TEXT,
  atualizado_em TEXT,
  cotista_id TEXT
)'), ('CREATE TABLE user_profiles (
    id TEXT PRIMARY KEY NOT NULL,

    email TEXT NOT NULL,
    nome_completo TEXT NOT NULL,
    nome_exibicao TEXT,

    url_avatar TEXT,

    endereco TEXT,
  cidade TEXT,
  uf TEXT,
    telefone TEXT,

    data_criacao TEXT DEFAULT CURRENT_TIMESTAMP,
    data_atualizacao TEXT DEFAULT CURRENT_TIMESTAMP,

    data_nascimento TEXT,
    data_admissao TEXT,

    cpf TEXT,
    rg TEXT,
    canac TEXT,

    status TEXT DEFAULT ''ativo'',

  	 nome_banco TEXT,
    tipo_conta TEXT DEFAULT ''corrente'',
    conta_numero TEXT,
    agencia_numero TEXT,
  tipo_chave_pix TEXT,
    pix TEXT,

    tipo_user TEXT,

    departamento TEXT,

    cliente_id TEXT
, "departamentos_email" TEXT, email_envio TEXT)'), ('CREATE TABLE usuarios_empresas (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    usuario_id TEXT NOT NULL,
    empresa_id TEXT NOT NULL,
    perfil TEXT NOT NULL DEFAULT ''COLABORADOR''
        CHECK (perfil IN (
            ''ADMINISTRADOR'',
            ''CONTABILIDADE'',
            ''FINANCEIRO'',
            ''GESTOR_RH'',
            ''COLABORADOR'',
            ''AUDITOR''
        )),
    status TEXT NOT NULL DEFAULT ''ATIVO''
        CHECK (status IN (''ATIVO'', ''INATIVO'')),
    criado_por TEXT,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (usuario_id)
        REFERENCES user_profiles(id)
        ON DELETE CASCADE,
    FOREIGN KEY (empresa_id)
        REFERENCES empresa(id)
        ON DELETE CASCADE,
    FOREIGN KEY (criado_por)
        REFERENCES user_profiles(id)
        ON DELETE SET NULL,

    UNIQUE (usuario_id, empresa_id)
)'), ('CREATE TABLE usuarios_funcoes (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    funcao TEXT NOT NULL,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES user_profiles(id)
        ON DELETE CASCADE,

    UNIQUE (user_id, funcao)
)'), ('CREATE TABLE voo_sequencia (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ultimo_numero INTEGER NOT NULL DEFAULT 0
)'), ('CREATE TABLE voo_sequencia_cotista (cotista_key TEXT PRIMARY KEY NOT NULL, ultimo_numero INTEGER NOT NULL DEFAULT 0)'), ('CREATE INDEX hold_socios_cotista_idx ON hold_socios(cotista_id)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE INDEX hold_socios_holding_idx ON hold_socios(holding_id)'), ('CREATE UNIQUE INDEX idx_aerodromo_designativo_icao
ON aerodromo(designativo_icao)'), ('CREATE INDEX idx_aeronave_id
ON tripulacao_freelancer (aeronave_id)'), ('CREATE INDEX idx_aeronave_proprietario
ON aeronave(nome_proprietario)'), ('CREATE INDEX idx_agenda_contatos_cidade
ON agenda_contatos (cidade)'), ('CREATE INDEX idx_alteracoes_contratuais_contrato
    ON alteracoes_contratuais (contrato_id, data_efetiva DESC)'), ('CREATE INDEX idx_anexos_mensagens_mensagem
ON anexos_mensagens (mensagem_id)'), ('CREATE INDEX idx_auditoria_financeira_entidade ON auditoria_financeira(entidade, entidade_id, criado_em)'), ('CREATE INDEX idx_auditoria_rh_empresa_data
    ON auditoria_rh (empresa_id, criado_em DESC)'), ('CREATE INDEX idx_auditoria_rh_entidade
    ON auditoria_rh (entidade, entidade_id, criado_em DESC)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE INDEX idx_cartoes_beneficios_periodo
ON cartoes_beneficios (ano, mes)'), ('CREATE UNIQUE INDEX idx_cliente_codigo
ON cliente(codigo_cliente)'), ('CREATE INDEX idx_contratos_trabalho_empresa
    ON contratos_trabalho (empresa_id, status)'), ('CREATE INDEX idx_contratos_trabalho_usuario
    ON contratos_trabalho (user_id, data_inicio DESC)'), ('CREATE INDEX idx_ctm_analise_oleo_os ON ctm_analise_oleo(ordem_servico_id)'), ('CREATE INDEX idx_ctm_despesas_motor_tipo ON ctm_despesas_motor(tipo)'), ('CREATE INDEX idx_ctm_diretrizes_status ON ctm_diretrizes(status)'), ('CREATE INDEX idx_ctm_estacoes_pb ON ctm_estacoes(peso_balanceamento_id)'), ('CREATE INDEX idx_ctm_execucoes_os ON ctm_execucoes(ordem_servico)'), ('CREATE INDEX idx_ctm_horas_voadas_socio ON ctm_horas_voadas_rateio(socio_id)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE INDEX idx_ctm_itens_aeronave_aeronave ON ctm_itens_aeronave(aeronave_id)'), ('CREATE INDEX idx_ctm_itens_nc_aeronave ON ctm_itens_nao_controlados(aeronave_id)'), ('CREATE INDEX idx_ctm_modelos_item_categoria ON ctm_modelos_item(categoria_id)'), ('CREATE INDEX idx_ctm_oas_item_rateios_socio ON ctm_oas_item_rateios(socio_id)'), ('CREATE INDEX idx_ctm_oas_servicos_oas ON ctm_oas_servicos(ordem_servico_id)'), ('CREATE INDEX idx_ctm_pecas_componente ON ctm_pecas_trocadas(componente_id)'), ('CREATE INDEX idx_ctm_ras_fotos_ras ON ctm_ras_fotos(ras_id)'), ('CREATE INDEX idx_ctm_ras_itens_ras ON ctm_ras_itens(ras_id)'), ('CREATE INDEX idx_ctm_ras_status ON ctm_ras(status)'), ('CREATE INDEX idx_ctm_rastreamento_socio ON ctm_rastreamento(nome_socio)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE INDEX idx_ctm_rateio_custos_cliente ON ctm_rateio_custos(cliente_id)'), ('CREATE INDEX idx_decimo_terceiro_empresa_ano
    ON decimo_terceiro (empresa_id, ano, status)'), ('CREATE INDEX idx_destinatarios_mensagens_destinatario
ON destinatarios_mensagens (
    destinatario_id,
    excluida,
    arquivada
)'), ('CREATE INDEX idx_documentos_colaboradores_competencia
    ON documentos_colaboradores (empresa_id, competencia_ano, competencia_mes, tipo_documento)'), ('CREATE INDEX idx_documentos_colaboradores_usuario
    ON documentos_colaboradores (user_id, tipo_documento, criado_em DESC)'), ('CREATE INDEX idx_documentos_internos_enviado_por
ON documentos_internos (enviado_por)'), ('CREATE INDEX idx_eventos_folha_item
    ON eventos_folha (item_folha_id, natureza)'), ('CREATE INDEX idx_ferias_status
    ON ferias (empresa_id, status)'), ('CREATE INDEX idx_ferias_usuario_data
    ON ferias (user_id, data_inicio DESC)'), ('CREATE INDEX idx_ficha_peso_balanceamento
ON ctm_ficha_peso_balanceamento (peso_balanceamento_id)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE INDEX idx_financeiro_fila_status ON financeiro_fila(status, criado_em)'), ('CREATE INDEX idx_folhas_pagamento_empresa_competencia
    ON folhas_pagamento (empresa_id, competencia_ano DESC, competencia_mes DESC)'), ('CREATE INDEX idx_folhas_pagamento_status
    ON folhas_pagamento (status)'), ('CREATE INDEX idx_hold_socios_holding ON hold_socios(holding_id)'), ('CREATE INDEX idx_hoteis_nome
ON hoteis (nome)'), ('CREATE INDEX idx_itens_folha_usuario
    ON itens_folha (user_id, folha_id)'), ('CREATE INDEX idx_lancamentos_rh_empresa_status
    ON lancamentos_financeiros_rh (empresa_id, status, data_vencimento)'), ('CREATE INDEX idx_lembretes_calendario_categoria
ON lembretes_calendario (cor_categoria_id)'), ('CREATE INDEX idx_manual_tutoriais_ordem
ON manual_tutoriais (ordem)'), ('CREATE INDEX idx_mensagens_usuario_pasta ON mensagens_usuario (usuario_id, papel, excluida, arquivada, favorita, lida)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE INDEX idx_pagamentos_folha_empresa_status
    ON pagamentos_folha (empresa_id, status, data_prevista)'), ('CREATE INDEX idx_pagamentos_folha_usuario
    ON pagamentos_folha (user_id, data_prevista DESC)'), ('CREATE INDEX idx_pastas_documentos_criado_por
ON pastas_documentos(criado_por)'), ('CREATE INDEX idx_periodos_ferias_usuario
    ON periodos_aquisitivos_ferias (user_id, status, data_fim)'), ('CREATE INDEX idx_rateio_despesas_lancamento_status
ON rateio_despesas(lancamento_id, status)'), ('CREATE INDEX idx_rateio_pagamentos_conta_receber_status
ON rateio_pagamentos(conta_receber_id, status)'), ('CREATE INDEX idx_rateio_pagamentos_pagador
ON rateio_pagamentos(tipo_pagador, pagador_cotista_id, pagador_holding_id)'), ('CREATE INDEX idx_rateio_pagamentos_rateio_confirmado ON rateio_pagamentos(rateio_id, status)'), ('CREATE INDEX idx_rateio_pagamentos_rateio_status
ON rateio_pagamentos(rateio_id, status)'), ('CREATE INDEX idx_rateio_pagamentos_recebimento
ON rateio_pagamentos(conta_receber_id)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE INDEX idx_rateio_pagamentos_recibo
ON rateio_pagamentos(recibo_id)'), ('CREATE INDEX idx_recados_criado_em
ON recados(criado_em)'), ('CREATE INDEX idx_solicitacoes_ferias_colaborador
    ON solicitacoes_ferias (colaborador_id, status, data_inicio)'), ('CREATE INDEX idx_tarefas_comentarios_usuario
ON tarefas_comentarios (usuario_id)'), ('CREATE INDEX idx_tarefas_criado_por
ON tarefas (criado_por)'), ('CREATE INDEX idx_tarefas_notificacoes_tarefa
ON tarefas_notificacoes (id_da_tarefa)'), ('CREATE INDEX idx_transacoes_beneficios_data
ON transacoes_beneficios (data_transacao)'), ('CREATE INDEX idx_user_profiles_departamentos_email
ON user_profiles(departamentos_email)'), ('CREATE INDEX idx_usuarios_empresas_empresa
    ON usuarios_empresas (empresa_id, perfil, status)'), ('CREATE INDEX idx_usuarios_empresas_usuario
    ON usuarios_empresas (usuario_id, status)');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE INDEX idx_usuarios_funcoes_funcao
ON usuarios_funcoes(funcao)'), ('CREATE INDEX idx_weight_balance_aircraft_id
ON ctm_peso_balanceamento (aeronave_id)'), ('CREATE INDEX solicitacoes_ferias_status_idx ON solicitacoes_ferias(status, data_inicio)'), ('CREATE INDEX solicitacoes_reserva_voo_cliente_idx
  ON solicitacoes_reserva_voo(cliente_id, criado_em DESC)'), ('CREATE INDEX solicitacoes_reserva_voo_status_data_idx
  ON solicitacoes_reserva_voo(status, data_agendada)'), ('CREATE UNIQUE INDEX uq_rateio_pagamentos_idempotency ON rateio_pagamentos(idempotency_key) WHERE idempotency_key IS NOT NULL'), ('CREATE TRIGGER trg_ctm_aprov_os_upd
AFTER UPDATE ON ctm_aprovacoes_ordem_servico FOR EACH ROW
BEGIN
  UPDATE ctm_aprovacoes_ordem_servico SET atualizado_em = CURRENT_TIMESTAMP WHERE id = NEW.id;
END'), ('CREATE TRIGGER trg_ctm_comp_evento_upd
AFTER UPDATE ON ctm_componente_eventos FOR EACH ROW
BEGIN
  UPDATE ctm_componente_eventos SET atualizado_em = CURRENT_TIMESTAMP WHERE id = NEW.id;
END'), ('CREATE TRIGGER trg_ctm_componente_upd
AFTER UPDATE ON ctm_mapa_componente FOR EACH ROW
BEGIN
  UPDATE ctm_mapa_componente SET atualizado_em = CURRENT_TIMESTAMP WHERE id = NEW.id;
END'), ('CREATE TRIGGER trg_ctm_documentos_oas_upd
AFTER UPDATE ON ctm_documentos_oas FOR EACH ROW
BEGIN
  UPDATE ctm_documentos_oas SET atualizado_em = CURRENT_TIMESTAMP WHERE id = NEW.id;
END');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TRIGGER trg_ctm_execucao_atualiza_programa
AFTER INSERT ON ctm_execucoes FOR EACH ROW
BEGIN
  UPDATE ctm_programa_manutencao SET
    ultima_execucao_data = NEW.data_execucao,
    ultima_execucao_horas = COALESCE(NEW.horas_aeronave_na_execucao, ultima_execucao_horas),
    ultima_execucao_pousos = COALESCE(NEW.pousos_aeronave_na_execucao, ultima_execucao_pousos),
    atualizado_em = CURRENT_TIMESTAMP
  WHERE id = NEW.item_aeronave_id;
END'), ('CREATE TRIGGER trg_ctm_itens_orcamento_upd
AFTER UPDATE ON ctm_itens_orcamento FOR EACH ROW
BEGIN
  UPDATE ctm_itens_orcamento SET atualizado_em = CURRENT_TIMESTAMP WHERE id = NEW.id;
END'), ('CREATE TRIGGER trg_ctm_oas_upd
AFTER UPDATE ON ctm_ordem_acompanhamento_servico FOR EACH ROW
BEGIN
  UPDATE ctm_ordem_acompanhamento_servico SET atualizado_em = CURRENT_TIMESTAMP WHERE id = NEW.id;
END'), ('CREATE TRIGGER trg_ctm_orcamento_total_del
AFTER DELETE ON ctm_itens_orcamento FOR EACH ROW
BEGIN
  UPDATE ctm_orcamentos SET valor_total = (SELECT COALESCE(SUM(subtotal),0) FROM ctm_itens_orcamento WHERE servico_id = OLD.servico_id)
  WHERE id = OLD.servico_id;
END'), ('CREATE TRIGGER trg_ctm_orcamentos_upd
AFTER UPDATE ON ctm_orcamentos FOR EACH ROW
BEGIN
  UPDATE ctm_orcamentos SET atualizado_em = CURRENT_TIMESTAMP WHERE id = NEW.id;
END'), ('CREATE TRIGGER trg_ctm_programa_upd
AFTER UPDATE ON ctm_programa_manutencao FOR EACH ROW
BEGIN
  UPDATE ctm_programa_manutencao SET atualizado_em = CURRENT_TIMESTAMP WHERE id = NEW.id;
END'), ('CREATE TRIGGER trg_ctm_ras_total_del
AFTER DELETE ON ctm_ras_itens FOR EACH ROW
BEGIN
  UPDATE ctm_ras SET
    total_trabalho = (SELECT COALESCE(SUM(valor_total),0) FROM ctm_ras_itens WHERE ras_id = OLD.ras_id AND item_tipo = ''servico''),
    total_pecas = (SELECT COALESCE(SUM(valor_total),0) FROM ctm_ras_itens WHERE ras_id = OLD.ras_id AND item_tipo = ''peca''),
    total_geral = (SELECT COALESCE(SUM(valor_total),0) FROM ctm_ras_itens WHERE ras_id = OLD.ras_id)
  WHERE id = OLD.ras_id;
END'), ('CREATE TRIGGER trg_ctm_totais_oas_peca_del
AFTER DELETE ON ctm_pecas_trocadas FOR EACH ROW
BEGIN
  UPDATE ctm_ordem_acompanhamento_servico SET
    total_pecas = (SELECT COALESCE(SUM(valor_total),0) FROM ctm_pecas_trocadas WHERE ordem_servico_id = OLD.ordem_servico_id),
    total_geral = (SELECT COALESCE(SUM(valor),0) FROM ctm_oas_servicos WHERE ordem_servico_id = OLD.ordem_servico_id)
                + (SELECT COALESCE(SUM(valor_total),0) FROM ctm_pecas_trocadas WHERE ordem_servico_id = OLD.ordem_servico_id)
  WHERE id = OLD.ordem_servico_id;
END'), ('CREATE TRIGGER trg_rateio_pagamentos_ad_recalcula AFTER DELETE ON rateio_pagamentos BEGIN UPDATE rateio_despesas SET valor_pago_real_centavos = (SELECT COALESCE(SUM(valor_centavos), 0) FROM rateio_pagamentos WHERE rateio_id = OLD.rateio_id AND status = ''CONFIRMADO''), atualizado_em = CURRENT_TIMESTAMP WHERE id = OLD.rateio_id; END'), ('CREATE TRIGGER trg_rateio_pagamentos_ai_recalcula AFTER INSERT ON rateio_pagamentos BEGIN UPDATE rateio_despesas SET valor_pago_real_centavos = (SELECT COALESCE(SUM(valor_centavos), 0) FROM rateio_pagamentos WHERE rateio_id = NEW.rateio_id AND status = ''CONFIRMADO''), atualizado_em = CURRENT_TIMESTAMP WHERE id = NEW.rateio_id; END');
INSERT INTO "sqlite_master"("sql") VALUES('CREATE TRIGGER trg_rateio_pagamentos_au_recalcula AFTER UPDATE OF valor_centavos, status, rateio_id ON rateio_pagamentos BEGIN UPDATE rateio_despesas SET valor_pago_real_centavos = (SELECT COALESCE(SUM(valor_centavos), 0) FROM rateio_pagamentos WHERE rateio_id = NEW.rateio_id AND status = ''CONFIRMADO''), atualizado_em = CURRENT_TIMESTAMP WHERE id = NEW.rateio_id; UPDATE rateio_despesas SET valor_pago_real_centavos = (SELECT COALESCE(SUM(valor_centavos), 0) FROM rateio_pagamentos WHERE rateio_id = OLD.rateio_id AND status = ''CONFIRMADO''), atualizado_em = CURRENT_TIMESTAMP WHERE id = OLD.rateio_id AND OLD.rateio_id <> NEW.rateio_id; END'), ('CREATE VIEW vw_colaboradores_rh AS
SELECT
    u.id AS user_id,
    u.nome_completo,
    u.email,
    u.cpf,
    u.data_nascimento,
    u.data_admissao,
    u.status,
    u.departamento,
    GROUP_CONCAT(DISTINCT uf.funcao) AS funcoes,
    u.cliente_id
FROM user_profiles u
LEFT JOIN usuarios_funcoes uf ON uf.user_id = u.id
GROUP BY u.id'), ('CREATE VIEW vw_resumo_pagamentos_colaborador AS
SELECT
    p.id,
    p.empresa_id,
    p.user_id,
    u.nome_completo,
    p.tipo_pagamento,
    p.competencia_ano,
    p.competencia_mes,
    p.valor_centavos,
    p.data_prevista,
    p.data_pagamento,
    p.status,
    p.comprovante_url
FROM pagamentos_folha p
JOIN user_profiles u ON u.id = p.user_id');
