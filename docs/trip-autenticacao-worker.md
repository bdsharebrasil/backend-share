# Autenticação do Trip Share pelo Worker

O aplicativo usa apenas o domínio da API. O serviço de identidade existente continua configurado exclusivamente no Worker, sem SDK ou chaves no aplicativo. Dados de negócio/perfis ficam no D1; arquivos ficam no R2.

| Método | Rota | Corpo |
| --- | --- | --- |
| POST | `/api/trip/auth/login` | `usuario`, `senha` |
| POST | `/api/trip/auth/refresh` | `refresh_token` |
| POST | `/api/trip/auth/logout` | Sem campos; Bearer da sessão corrente |

Login e renovação retornam somente `access_token`, `refresh_token`, `expires_at` e `user.id`. Não retornam metadados do provedor ou suas chaves. O usuário deve ter um perfil ativo no D1. O login conserva o domínio de conta `share-brasil.com`.

As rotas usam limite de 20 solicitações por minuto/IP via RATE_LIMITER, corpo máximo de 4 KiB e respostas `no-store`. Falha no limitador ou no provedor retorna 503; credenciais recusadas retornam 401; perfil inexistente/bloqueado retorna 403. As credenciais e os tokens não são registrados em logs.

Configuração: manter `SUPABASE_URL` e `SUPABASE_ANON_KEY` (ou a chave pública já configurada em `VITE_SUPABASE_PUBLISHABLE_KEY`) no Worker. `SHARE_DB` e `RATE_LIMITER` já pertencem à infraestrutura da API. Nenhuma dessas chaves deve voltar ao aplicativo.

O logout revoga o token de renovação da sessão corrente no provedor. Como no fluxo anterior, o access token é um JWT e segue as regras de validade do provedor; a aplicação remove sua cópia e bloqueia a navegação imediatamente, inclusive sem rede. Não há nova tabela de senhas ou sessões.

## Avatars legados

`GET /api/colaborador/foto` não redireciona o aplicativo para serviços externos. Quando o cadastro ainda contém uma URL do Storage do provedor configurado, o Worker importa essa foto para R2 e atualiza o D1. A origem HTTPS precisa corresponder exatamente à configuração, o caminho deve ser de objeto público/assinado e a imagem tem limite de 10 MiB. Redirecionamentos são recusados. URLs de outras origens exigem atualização da foto pelo fluxo normal.

Publique este backend antes da atualização do Trip Share. Não exige migração de banco. A nova versão do app usa outro formato de sessão e exige login novamente.
