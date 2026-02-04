# Share Brasil Backend API

Backend Express.js para cache e proxy de requisições ao Supabase, otimizado para economizar na quota gratuita.

## 🏗️ Arquitetura

### Cache Strategy
- **LRU Cache em Memória**: 500 entradas com TTL configurável
- **Real-time**: Flight schedules e dados que mudam frequentemente (sem cache)
- **Short Cache (2-10 min)**: Dados que mudam com certa frequência
- **Long Cache (15 min - 1 dia)**: Dados relativamente estáticos (usuários, clientes, aeronaves)

### Endpoints

#### Users
```bash
GET    /api/users              # Todos os usuários (cached 10 min)
GET    /api/users/:id          # Usuário específico (cached 10 min)
GET    /api/users/:id/profile  # Perfil com dados relacionados (cached 10 min)
```

#### Flights
```bash
GET    /api/flights            # Listar voos com filtros (real-time)
GET    /api/flights/:id        # Detalhes do voo (cached 2 min)
GET    /api/flights/active/now # Voos em andamento (real-time)
```

#### Clients
```bash
GET    /api/clients            # Todos os clientes (cached 15 min)
GET    /api/clients/:id        # Cliente com resumo financeiro (cached 15 min)
GET    /api/clients/:id/contracts # Contratos do cliente (cached 1 dia)
```

#### Aircraft
```bash
GET    /api/aircraft           # Todas as aeronaves (cached 20 min)
GET    /api/aircraft/:id       # Detalhes + manutenção + horas de voo (cached 10 min)
GET    /api/aircraft/:id/availability # Disponibilidade próximos 30 dias (cached 5 min)
```

#### Cache Management
```bash
GET    /api/cache/stats        # Estatísticas do cache
POST   /api/cache/clear        # Limpar cache específico (JSON body: {pattern: "string"})
```

## 🚀 Como Rodar

### Desenvolvimento

```bash
# Instalar dependências
npm install

# Rodar frontend e backend simultaneamente
npm run dev

# Ou rodar separadamente:
npm run dev:frontend   # Vite em localhost:5173
npm run dev:backend    # Express em localhost:3001
```

### Produção (Vercel)

1. Fazer push para o repositório
2. Vercel detectará `vercel.json` e fará deploy automático
3. Backend estará disponível em `https://your-domain/api/*`

## 📊 Cache TTLs

| Dados | TTL | Cache |
|-------|-----|-------|
| Usuários | 10 min | LRU |
| Clientes | 15 min | LRU |
| Aeronaves | 20 min | LRU |
| Contratos | 1 dia | LRU |
| Voos (list) | - | Real-time |
| Voos (details) | 2 min | LRU |
| Disponibilidade | 5 min | LRU |

## 🔍 Headers de Response

- `X-Cache`: `HIT` ou `MISS` - indica se veio do cache
- `timestamp`: Quando a resposta foi gerada
- `cached`: Boolean indicando se está cacheado

Exemplo:
```json
{
  "data": [...],
  "timestamp": "2024-01-15T10:30:45.000Z",
  "cached": true
}
```

## 🛡️ Segurança

- CORS habilitado apenas para domínios autorizados
- Em produção, adicionar autenticação JWT
- Validar requests no middleware
- Rate limiting recomendado

## 📈 Performance

### Benefícios da Cache Strategy

1. **Reduz requisições ao Supabase** em ~70% para dados estáticos
2. **Resposta instantânea** para cache hits
3. **Mantém real-time** para dados críticos
4. **Economiza quota** do plano gratuito
5. **Escalável** com LRU para memória limitada

### Exemplo de economia

```
Sem backend: 10.000 requisições/mês ao Supabase
Com backend: ~3.000 requisições/mês ao Supabase
Economia: 70% de redução
```

## 🔧 Variáveis de Ambiente

```env
VITE_SUPABASE_URL=           # URL do Supabase
VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY=  # Chave pública
NODE_ENV=                    # development|production
PORT=                        # 3001 por padrão
FRONTEND_URL=                # URL do frontend para CORS
```

## 📝 Estrutura de Pastas

```
api/
├── lib/
│   ├── cache.ts            # LRU Cache implementation
│   └── supabase.ts         # Supabase client
├── middleware/
│   └── cacheMiddleware.ts  # Cache middleware para Express
├── routes/
│   ├── users.ts
│   ├── flights.ts
│   ├── clients.ts
│   └── aircraft.ts
├── index.ts                 # Express app setup
├── server.ts               # Server entry point
└── README.md
```

## 🎯 Próximos Passos

1. [ ] Adicionar autenticação JWT
2. [ ] Implementar rate limiting
3. [ ] Adicionar Realtime Subscriptions para voos
4. [ ] Logging estruturado
5. [ ] Testes unitários
6. [ ] Documentação OpenAPI/Swagger
