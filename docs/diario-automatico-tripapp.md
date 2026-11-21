# Diário de Bordo automático a partir de Meus Voos — 21/11/2026

## Fluxo

1. O usuário registra AC, DEP, POU ou COR pela Agenda do Trip Share.
2. O Worker grava os horários **na perna** (`pernas_jornada_voo`) e chama `sincronizarDiarioDaPerna` no próprio backend, independentemente do dispositivo.
3. Após o primeiro AC, cria (se necessário) a competência `diario_mes` para **aeronave + ano/mês UTC do acionamento** e o lançamento em `lancamentos_diario_bordo`.
4. O rascunho recebe a matrícula através do ID da aeronave, voo, jornada, rota, data, cliente/holding/sócio validado, PIC/SIC, passageiros, tempos AC/DEP/POU/COR e horas de voo/tempo total derivados dos instantes UTC.
5. `confirmado=0`, `assinado_pic=NULL`, `data_assinatura=NULL`. Complementos (IFR, natureza, combustível, observações, carga, pousos, informações de manutenção) permanecem editáveis e **não são inventados**.
6. Novos horários gravados na mesma perna atualizam **o mesmo ID de lançamento**, sem duplicar registro, preservando complementos manuais. A associação já existente `pernas_jornada_voo.lancamento_diario_id` é reutilizada.
7. O comandante escalado confere dados complementares e assina eletronicamente: o Worker valida PIC pela identidade autenticada (não pelo payload), vincula nome, data/hora e ID do usuário e registra `confirmado=1`. Depois disso, horários e dados não podem mais ser alterados pelos fluxos comuns.
8. SIC e equipe operacional podem complementar rascunhos dentro da autorização existente; **somente PIC** pode assinar. Integração administrativa autenticada continua disponível para retificações autorizadas.

## Rotas

- `GET /api/colaborador/diario-bordo/voos/:vooId`: lançamentos por perna e permissão `pode_assinar`, acesso restrito à tripulação do voo/equipe operacional.
- `POST /api/colaborador/diario-bordo/voos/:vooId/sincronizar`: retroagir criação/sincronização dos rascunhos de jornadas anteriores. Reexecutável.
- `PATCH /api/colaborador/diario-bordo/pernas/:id`: complementação somente dos campos permitidos e **não** dos horários operacionais.
- `POST /api/colaborador/diario-bordo/pernas/:id/assinar` com `{ "confirmar_assinatura": true }`: assinatura exclusiva do comandante com horários completos, natureza do voo, CANAC PIC e horas diurnas/noturnas consistentes.

As respostas de início de jornada, nova perna e PATCH de horários incluem `diario_bordo: { status, lancamento_id?, diario_mes_id?, detalhe? }`. Se AC ainda não existe, `status=aguardando_ac`. Se mês fechado/dados inconsistentes, a operação não finge ter criado rascunho; os horários já registrados continuam válidos e a pendência é informada. Erros operacionais inesperados não descartam horários gravados.

## D1 e implantação

- A sincronização usa colunas e FKs existentes. O ID do lançamento é **igual ao UUID da perna**, garantindo idempotência; lançamento manual já vinculado mantém seu ID.
- Sem competência existente, o Worker abre a competência automaticamente. O modo de célula e leitura inicial são herdados do último mês conhecido. Na **primeira competência de uma aeronave**, o sistema usa modo `tempo_total` e leitura inicial 0 como valor técnico inicial **a ser conferido** pelo responsável; isso não constitui aferição real de célula/horímetro.
- Migração opcional `migrations/20261121_diario_assinatura_tripapp.sql` acrescenta `assinado_pic_user_id` para auditoria separada. Como o deploy de GitHub não executa migrações D1 automaticamente, a consulta e assinatura possuem fallback compatível antes da migração: armazenam nome e ID do usuário autenticado no campo legado `assinado_pic`. Para auditoria estruturada, aplicar a migração remotamente antes do deploy.
- Lançamentos em rascunho já participam dos totais/célula do diário conforme o cálculo legado existente (soma de tempo_voo/tempo_total). A **assinatura/confirmado** permanece separada e precisa ser usada pelos relatórios que exigem apuração assinada.
- A edição do lançamento automático está bloqueada se `confirmado=1` ou `assinado_pic` preenchido. Retificações extraordinárias devem usar processo administrativo autenticado.
- Mês fechado não é reaberto automaticamente; apresenta pendência para o responsável.
- Não apagar aeronave, cliente, jornada ou assinatura para reexecutar sincronização.

## Verificação sugerida

- `pnpm type-check`
- `pnpm test` (incluindo `tests/diario-automatico-tripapp.test.mjs`)
- Tripulante PIC/SIC real: registrar AC, DEP, POU, COR em etapas → verificar **um** lançamento em rascunho, vinculado à aeronave, cliente e dia de AC, com horas e dados corretos.
- SIC complementa e salva; SIC recebe 403 ao assinar; PIC completa natureza, horas diurnas/noturnas e assina; registro fica imutável.
- Voo com mais de uma perna e segunda jornada gera lançamentos distintos e idempotentes.
- Verificar competência aberta automaticamente, fechamento de mês e desempenho de cálculo de célula; migrar assinatura separada quando conveniente.
- Sem teste autenticado em produção ou deploy realizado nesta branch.
