# Ponto e gestão de jornada

## Implantação

1. Aplicar `migrations/20261116_ponto_gestao.sql` no D1 existente. A migração é aditiva, preserva as tabelas fornecidas e importa os pedidos antigos sem apagar os originais. Pode ser executada no console SQL do D1 ou com `pnpm exec wrangler d1 execute bd_sharebrasil --remote --file=migrations/20261116_ponto_gestao.sql`.
2. Publicar o backend e, em seguida, o frontend. Nenhum banco de produção é alterado pela criação da PR.
3. Em **Gestão de Ponto → Escalas e regras**, o DP cadastra as escalas, vincula os colaboradores a um grupo, informa a data-base do ciclo, o fuso e o gestor responsável. As escalas se repetem entre meses e anos. Informar a data de comunicação da escala; exceções à antecedência exigem justificativa e anuência.
4. Administrador/RH podem configurar regras e fechar competências. Gestor master ou o gestor vinculado ao colaborador podem analisar pedidos e espelhos dentro do respectivo escopo. Departamento Financeiro, sozinho, não concede acesso ao ponto de terceiros. Não é permitida autoaprovação.

O aviso **DESEJA REGISTRAR A ENTRADA ?** é consumido no servidor por usuário e dia local. Apenas os departamentos Financeiro, Administrativo, Operações e CTM (incluindo o nome combinado Financeiro-Administrativo) recebem o aviso. IDs de departamentos são resolvidos em `departamentos_email`. A matrícula do primeiro ponto ou uma jornada ainda aberta impedem novo aviso. Dispensar o aviso também impede sua repetição no dia, mas não impede o registro manual na página de ponto.

O servidor define o instante UTC; o fuso vem do vínculo ou da preferência inicial identificada no dispositivo. A localização precisa de permissão do navegador. Negativa, indisponibilidade e ausência de posição ficam identificadas; nenhuma coordenada é inventada e o ponto não depende da concessão da localização. O JSON baixável é um registro operacional, não um comprovante REP assinado digitalmente.

## Base recebida e referência de 2026

Fonte: **CCT SINEATA × FENASCON 2025 assinada**, SHA-256 `415a7dd96ec95630a776fb258ae120283de9b81f28570fd7c8c282408c5b2834`.

O instrumento original tem vigência de **01/01/2025 a 31/12/2025**. Sua abrangência territorial (cláusula 2, página 1) não inclui MT. Esses dados foram preservados nos rascunhos de 2025.

Por orientação explícita do responsável pelo projeto, a migração também prepara duas **referências internas para 01/01/2026 a 31/12/2026**, administrativa e operacional, com os mesmos parâmetros de cálculo, identificadas como `REFERENCIA_INTERNA`. A referência interna não declara nova CCT assinada, não altera o documento original e não afirma prorrogação sindical ou ultratividade. As UFs do documento original não são apresentadas como sua abrangência jurídica em 2026: a referência é uma parametrização interna solicitada para a empresa. Não é criada uma validação fictícia por usuário de RH.

| Item | Parâmetro preparado | Fonte |
| --- | --- | --- |
| Período noturno | 22h–05h | Cláusula 8, p. 5 |
| Adicional noturno | 40% e DSR de 25% sobre o adicional, totalizando 50% | Cláusula 8, p. 5 |
| Hora noturna reduzida | 52min30s | Referência legal urbana, CLT art. 73; não atribuída ao texto da cláusula 8 |
| Extra em dia útil | 60% e DSR de 25% sobre a hora corrigida: fator total 2 | Cláusula 29, §2, item 1, p. 19 |
| Extra em domingo/feriado | 100% e DSR de 25%: fator total 2,5 | Cláusula 29, §2, item 2, p. 19 |
| Crédito de compensação | Fatores 2 e 2,5 conforme o dia trabalhado | Cláusula 29, §2, item 4, p. 19 |
| Prazo de compensação | Até o último dia do segundo mês subsequente | Cláusula 29, §2, item 7, p. 20 |
| Jornada administrativa | Limite semanal de 44h | Cláusula 25, p. 16 |
| Jornada operacional | Limite semanal de até 42h | Cláusula 25, p. 16 |
| Pausa da jornada reduzida | Pausa de 15min remunerada em jornada superior a 4h e inferior a 6h, sem exigir sua marcação | Cláusula 24, p. 16 |
| Comunicação de escala | Antecedência de 5 dias; exceção com justificativa e anuência | Cláusula 27, p. 17 |

O fator de sobreaviso **não foi encontrado na CCT anexada**. O motor separa sobreaviso e trabalho efetivo, disponibiliza o fator de referência 1/3 e exige que o DP valide a regra de sobreaviso antes de utilizá-la. Não o apresenta como cláusula da CCT. Prorrogação de adicional noturno também é parâmetro explícito, sem inferir automaticamente seu enquadramento em todos os regimes.

As versões são compartilhadas por grupo. Uma nova versão válida substitui a anterior na sua data de início, sem recadastrar cada colaborador. Depois do fim da última versão, o sistema sinaliza regra pendente; não volta silenciosamente a uma versão antiga. Feriados nacionais fixos vêm cadastrados; o DP mantém feriados locais e móveis pelo calendário do próprio sistema.

## Marcações e tratamento

As marcações originais, em `ponto_marcacoes`, não admitem UPDATE/DELETE. O lançamento antigo é a projeção compatível de entrada, início/retorno do intervalo e saída. Turnos que cruzam meia-noite permanecem vinculados à data da entrada. A saída pode ser registrada mesmo com intervalo incompleto; a inconsistência aparece no espelho para correção.

Correção, atestado, dispensa, hora extra e compensação são pedidos auditados. A aprovação altera a visão tratada, preservando os horários originais. Horas extras trabalhadas continuam visíveis enquanto aguardam conferência; não se bloqueia a marcação por falta de autorização prévia. O gestor acompanha atraso, pausa não registrada e extensão da jornada no painel atualizado a cada 30 segundos.

O banco oficial recebe créditos e débitos apenas no fechamento, por dia, sem duplicação. Os fatores de crédito respeitam a regra e o calendário; a compensação depende de pedido aprovado. A apuração consome créditos anteriores e separa saldo disponível de saldo vencido a liquidar. Liquidação financeira e aplicação de salários são atribuições do DP; não há geração automática de pagamento ou alteração dos lançamentos financeiros.

## Fechamento

O colaborador confere o espelho, outro gestor aprova e o DP fecha. No dia 1, o job do Worker prepara a competência anterior e fecha automaticamente os espelhos já conferidos/aprovados quando a regra permite. O job usa a frequência existente de 15 minutos. Pendências não são aprovadas pelo cron.

Mudanças em marcação, pedido, vínculo ou regra invalidam a conferência aberta. O fechamento verifica novamente o hash da fonte, preserva um snapshot do espelho e lança o banco de forma idempotente. Competência fechada bloqueia novos tratamentos. Pedidos legados sem duração e registros duplicados são apontados para conferência; não são apagados para fazer o mês fechar.

A exportação CSV mostra horários originais e tratados, totais e ocorrências. A auditoria específica é imutável e espelha ações humanas em `auditoria_rh`. Execuções automáticas mantêm seu ator `SISTEMA` na auditoria do ponto, sem forjar um colaborador.

## Limites e validação

Este módulo é gestão interna de jornada. Não afirma equivalência integral ao Pontotel nem certificação REP-P/REP-A. Não gera AFD/AEJ oficiais, assinatura ICP-Brasil, reconhecimento facial ou atestado técnico de conformidade. A referência da Portaria 373 no documento de 2025 não substitui a verificação das exigências atuais do Ministério do Trabalho para um registrador oficial.

Fontes legais consultadas: CLT (Câmara/Planalto), art. 73 e art. 614 §3; página do MTE sobre Registro Eletrônico de Ponto e perguntas/respostas da Portaria 671. A aplicação operacional em 2026 foi solicitada pelo usuário; não é conclusão jurídica de que o documento de 2025 permanece vigente.

Os testes cobrem consumo único do aviso, concorrência, horário do servidor, ausência de GPS, imutabilidade, intervalo, meia-noite, recorrência, referência 2026, versionamento, fatores da CCT, sobreaviso, banco FIFO, acesso por gestor, correção preservando original, fechamento completo e rotina do dia 1. Executar `node --import tsx --test tests/ponto-profissional.test.mjs` e `pnpm type-check`.
