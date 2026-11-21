# Horas do tripulante

## Rotas

- `GET /api/colaborador/minhas-horas`
- `GET /api/colaborador/minhas-horas/pdf`

Ambas exigem Bearer de colaborador. Parâmetros opcionais: `inicio` e `fim` em AAAA-MM-DD (limites inclusivos) e `aeronave_id`. Não é possível selecionar outro usuário: o vínculo PIC/SIC é resolvido pelo Worker a partir do perfil e da tripulação. CANAC legado não vinculado a outra conta é compatível; nomes e CANAC vazio não concedem acesso.

A resposta inclui filtros aplicados, resumo em minutos inteiros, aeronaves disponíveis, resumos por mês e aeronave e registros. Horas de voo usam `tempo_voo` (DEP–POU); totais usam `tempo_total` (AC–COR), sem substituir uma grandeza pela outra. Cada lançamento entra uma vez mesmo com identidade legada ou tripulante nos dois papéis. Rascunhos são incluídos e contabilizados separadamente para conferência.

O PDF usa a mesma consulta, identifica os rascunhos, inclui os lançamentos e pagina históricos extensos. JSON e PDF retornam `Cache-Control: private, no-store`. Nenhuma migração nova é necessária. Publicar o Worker antes do app que usa estas rotas.

## Validação

`node --import tsx --test tests/horas-tripulante.test.mjs tests/diario-automatico-tripapp.test.mjs tests/trip-share-flight-permissions.test.mjs`

Cobre vínculo PIC/SIC, acesso legado, isolamento, datas inclusivas, aeronave, vazio, PDF paginado e autenticação. A criação automática dos rascunhos continua no serviço `diarioAutomatico`, chamado pelas rotas de horários: primeiro AC cria; DEP/POU/COR atualizam; complementos e assinaturas são preservados.
