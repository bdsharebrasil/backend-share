# API de lançamentos unificados

## Modelo e compatibilidade

A migração `migrations/20261026_lancamentos_unificados.sql` cria `lancamentos_unificados`, preenche os registros históricos e instala triggers D1 que mantêm a projeção no mesmo commit das escritas legadas. `schema.sql` inclui o snapshot da nova tabela e triggers para bancos inicializados do zero. A migração não remove nem reescreve linhas das fontes originais.

`lancamentos`, `contas_apagar`, `contas_areceber`, `envio_despesas` e `solicitacoes_compra` continuam sendo as fontes operacionais (pagamento, rateio, aprovação e anexos). Os endpoints canônicos reutilizam `FinanceiroKernel` para criar ou baixar contas e atualizam as fontes legadas; os triggers espelham os resultados. Registros ligados são consolidados por `lancamento_id` e não aparecem duas vezes. Solicitação de compra sem conversão usa a soma estimada dos itens; ao aprovar/converter, essa linha desaparece do livro canônico e o lançamento/conta real assume seu lugar.

Movimentos de Holding (`movimentos_holding`/`rateio_hold`), folha, NF e recibo de saída, e baixas de cotista enviadas pelo portal não são movidos para `lancamentos_unificados`. Contas associadas a Holding ou colaborador são excluídas da projeção financeira geral. O endpoint de baixa delega contas pagar/receber e rateios de cliente ao kernel atual.

Campos centrais: `fluxo` ENTRADA/SAIDA, `natureza`, `caixa` SHARE/CLIENTE, `descricao`, `categoria_id`/`categoria`, `favorecido_id`/`favorecido`, `conta_bancaria_id`, datas de lançamento/vencimento/pagamento, `status` PENDENTE/PAGO/CANCELADO, centavos, `reembolsavel`, cotista, número e URLs de documentos, anexos, observações e referências de origem/conta/solicitação. `situacao` na resposta deriva ATRASADO quando um registro ainda pendente tem vencimento anterior ao dia corrente; essa condição não reescreve o estado original.

## Rotas (sob `/api/financeiro`)

- `GET /lancamentos-unificados`: filtros opcionais `fluxo`, `caixa`, `status` (inclui `ATRASADO`), `inicio`, `fim`, `q`; paginação `pagina` e `limite` (1–200). Retorno `{ lancamentos, total, pagina, por_pagina }`; cada linha inclui campos do modelo, os vínculos de origem e `situacao` calculada.
- `POST /lancamentos-unificados`: grava entrada/saída via `issueRevenue`/`createExpense`. Recebe `fluxo`, `caixa` SHARE/CLIENTE, descrição, `valor_centavos` (preferido) ou valor em reais, datas e campos de classificação/vínculo permitidos pelo Kernel. Retorna o resultado do Kernel e `lancamento_unificado` quando houver uma origem individual projetável. Não aceita caixa HOLDING.
- `PATCH /lancamentos-unificados/:id`: edita campos explicitamente permitidos da linha e sincroniza a origem legada; solicitações em etapa de aprovação retornam 409 para manter a autoridade do respectivo fluxo.
- `DELETE /lancamentos-unificados/:id`: cancelamento lógico (`CANCELADO`), nunca exclusão de histórico; atualiza conta/lancamento relacionado e recusa registros pagos.
- `POST /lancamentos-unificados/:id/baixa`: delega para `settlePayable`, `settleReceivable` ou `settleCotista`; lançamento simples sem conta relacionada tem data de pagamento validada e atualização sincronizada. Baixa de Holding continua exclusivamente em suas rotas próprias.

Todas as rotas ficam sob a autorização financeira já aplicada ao grupo `/api/financeiro`; não há acesso anônimo nem rota de migração pública.

## Aplicação

A migração foi validada localmente contra `schema.sql` com SQLite, inclusive backfill vazio, inserção/atualização de conta, conversão de compra e exclusão de Holding. **Ela ainda não foi aplicada ao banco D1 remoto nem o Worker foi implantado.** Após revisão operacional e backup do banco, aplicar pela rotina de deploy aprovada do projeto, por exemplo `pnpm exec wrangler d1 migrations apply SHARE_DB --remote`, verificar a saída e então implantar o Worker. `GET /api/financeiro/schema/validate` também exige a nova tabela e falhará com erro claro caso o rollout do schema não tenha sido aplicado.
