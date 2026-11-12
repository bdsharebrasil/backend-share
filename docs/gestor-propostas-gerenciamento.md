# Persistência de propostas de gerenciamento

As rotas `/api/gestor/contratos` continuam restritas a administradores e gestores master. As propostas comerciais usam `contratos.tipo=PRESTACAO_SERVICO` e `dados_adicionais.modelo=PROPOSTA_GERENCIAMENTO`, com o formulário em `proposta_gerenciamento`. Não é necessária uma migração; as tabelas fornecidas de contratos, partes e anexos são suficientes. `contratos_trabalho` é somente consultada pelas opções do editor anterior.

POST cria a proposta e as partes em batch, aceita dados parciais em RASCUNHO e atribui um número PROP-ano-identificador quando não informado. PUT recebe `revisao_esperada`; uma versão atrasada retorna 409. Mesmo os clientes antigos sem esse campo têm proteção contra corrida entre leitura e batch. A troca de partes é condicionada ao token da gravação aceita, evitando que uma atualização rejeitada modifique dados filhos.

O servidor valida composição do preço, centavos, quantidade, datas e conteúdo. O valor é pacote OU soma dos serviços selecionados, multiplicado pela quantidade somente na cobrança por cotista. A aeronave vinculada deve existir. O histórico de criação e mudanças de status é gerado pelo servidor com usuário e data; conteúdo enviado pelo cliente não sobrescreve esse histórico.

POST `/:id/anexos` continua recebendo anexos normais. Para PDF gerado, enviar `tipo=PROPOSTA_GERADA`, `revisao` e `arquivo` PDF. A revisão deve corresponder ao documento salvo. O batch atualiza `documento_url`, adiciona a versão e registra DOCUMENTO_GERADO sem alterar o status. Em conflito após upload, o objeto R2 órfão é excluído. O download usa a rota autenticada existente; o storage não é exposto na listagem. O vínculo legado de anexos de cotistas é preservado para os outros modelos e sua tabela é opcional.

Publicar este backend antes do frontend correspondente.

Validação: `node --import tsx --test tests/gestor-propostas-gerenciamento.test.mjs tests/gestorContratosRoutes.test.mjs`. Os testes executam as rotas reais com SQLite, adaptador D1, armazenamento R2 em memória e autenticação HTTP simulada. Cobrem rascunho, retomada, cálculo, datas, auditoria, concorrência de partes/PDF, limpeza de arquivo órfão, autorização e compatibilidade com contratos anteriores.
