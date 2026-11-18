# Preparação compartilhada do voo

Implementação conjunta em `backend-share`, `Share-Brasil-Financeiro` e `app-mobile`.

## Comportamento

- Aeronave mantém os 37 itens existentes, com os seis itens de coordenação na aba Tripulação e a documentação da aeronave na aba Aeronave. Peso e balanceamento continua no fluxo existente.
- Tripulação organiza roteiro, fuso por trecho, pernoite e serviços por visita ao aeroporto: combustível previsto, hotel, hangar/pátio, GPU, ar-condicionado, transfer, balizamento, plano de voo, meteorologia/NOTAM.
- Estados: PENDENTE, EM_ANDAMENTO, CONCLUIDO, NAO_REALIZADO e NAO_APLICAVEL. Concluir não exige resolver itens nem preencher justificativas. O briefing identifica pendências e escreve “Motivo não informado” quando necessário. Essa conclusão administrativa não certifica a aeronave nem substitui os registros operacionais.
- Datas/horários planejados não criam jornadas ou lançamentos de diário. Alterar aeroporto, data, hora, fuso ou pernoite de uma escala exige reconfirmar serviços antes confirmados.
- Cadastros são copiados para o voo. Atualizar o cadastro geral depois não altera silenciosamente um briefing emitido. A ação “Atualizar dados do cadastro” importa os valores deliberadamente.
- Café da manhã: INCLUIDO, A_PARTE (preço opcional), NAO_OFERECE ou A_CONFIRMAR. `SIM` antigo indica oferta, com inclusão ainda a confirmar; `NAO`/`NÃO` indica ausência; valor numérico indica cobrança à parte. Hotel confirmado com condição de café desconhecida ainda apresenta essa pendência.
- Solicitação de reserva usa Resend e as tabelas de hotel existentes; mantém SOLICITADA até confirmação manual no serviço. Repetições de uma mesma solicitação, inclusive por pessoas diferentes, usam uma operação persistida e a mesma chave de idempotência. Não existe envio automático ao salvar ou concluir.
- Reservas vinculadas ao voo aparecem para a tripulação escalada, mesmo quando enviadas pela coordenação. Reservas de outros voos/usuários não entram nessa consulta. A autorização existente de `meus-voos/:id` permanece antes da consulta.
- Cotação/planejamento não gera despesa. “Registrar abastecimento realizado” cria o registro financeiro existente, uma vez por escala, e notifica o financeiro. O vínculo opcional ao último trecho do diário usa o pagador daquele lançamento; sem ele usa o pagador do agendamento. Abastecimentos antigos permanecem visíveis. Comprovante opcional aceita PDF/JPG/PNG/WEBP.
- Todos os anexos exigem autenticação e vínculo ao voo. Sem URLs públicas de comprovantes.
- Salvamento usa versão otimista e histórico imutável por gravação. A interface combina campos distintos; conflitos no mesmo campo exigem escolha. Rascunho local e cache ficam separados por usuário e voo na sessão. Consulta offline é somente leitura; reconectar carrega a versão atual.
- PDF fixa dados, nomes, responsáveis, motivos, reservas, anexos e abastecimentos da versão. Histórico lista as últimas 100 versões; PDFs de versões mais antigas continuam acessíveis pelo número.

## Implantação

1. Instalar as dependências do backend (`pdf-lib` e `esbuild` adicionado apenas para testes).
2. Aplicar **somente** `migrations/20261118_preparacao_voo.sql` ao D1 correto antes de publicar o backend:

   ```sh
   pnpm exec wrangler d1 execute bd_sharebrasil --remote --file migrations/20261118_preparacao_voo.sql
   ```

   Confirmar o nome do banco no `wrangler.toml` usado no ambiente. A migração cria cinco tabelas e índices com `IF NOT EXISTS`; não recria tabelas, não remove dados e não importa o `schema.sql` completo.
3. O cadastro de fornecedores deve possuir `codigo_icao`, conforme o esquema de produção informado. Em uma instalação antiga, verificar com `PRAGMA table_info(agenda_contatos_fornecedores)` e adicionar a coluna apenas se ausente. O `schema.sql` atualizado já a contém para bancos novos.
4. Publicar o backend; conferir GET de preparação e catálogo com uma sessão de teste.
5. Publicar o sistema interno e o app da tripulação. Ambos precisam desta API antes da liberação da nova tela.
6. Em homologação, verificar reserva com destinatário de teste, anexo privado, cotação sem gasto, abastecimento realizado e PDF histórico.

Nenhuma migração ou publicação de produção foi executada durante o desenvolvimento. Para reverter a interface, restaurar a versão anterior dos clientes/backend e preservar as novas tabelas. Não excluir histórico para reverter uma publicação.

## Validação

- Backend: `node --test tests/preparacao-voo.test.mjs`. Usa SQLite real em memória, os handlers da API, transporte de e-mail simulado e armazenamento simulado; não testa Cloudflare/Resend reais nem o roteamento HTTP do Hono. Testa migração repetível, conclusão com pendências, versões, conflitos, snapshots, reservas idempotentes, café legado, abastecimento financeiro, anexos privados, consulta de hotéis por voo e PDF real.
- Clientes: `node --test tests/preparacao-voo.test.mjs`. Testa mescla concorrente por identificador, exclusão concorrente e interpretação do café.
- Foram executadas também 41 verificações de interação em DOM simulado, nos temas claro/escuro, além de compilação Vite isolada da tela. PDF renderizado para inspeção. Não houve validação visual em navegador/dispositivo real nem teste de envio de e-mail em produção.
- O componente `src/components/preparacao/{PreparacaoVoo.tsx,mesclar.ts,preparacao.css}` é idêntico nos dois clientes; manter as cópias sincronizadas até existir um pacote compartilhado.
- O app original tem três testes já falhando (seletor de aeronave do diário, menus de plano de voo e logout do perfil) e erros de tipos preexistentes em App, InformacoesAerodromoMobile, useUserProfile, rascunhoDespesasViagem, DiarioBordo e DespesasViagem. Foram reproduzidos na base original, usando as mesmas dependências locais. Esta entrega não modifica esses módulos.
