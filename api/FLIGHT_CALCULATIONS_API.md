# Flight Calculations API

Documentação das rotas para cálculos de diário de bordo.

## Endpoints

### GET /api/aerodromes

Busca lista de todos os aeródromos com coordenadas (formato DMS).

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "designativo": "SBGR",
      "name": "São Paulo/Guarulhos",
      "coordenadas": "23°30'15.5\"S,45°15'30.2\"W"
    }
  ],
  "timestamp": "2024-01-15T10:30:00.000Z",
  "cached": true
}
```

---

### GET /api/aerodromes/details

Busca lista completa de aeródromos com todos os dados (coordenadas e metadados).

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "designativo": "SBGR",
      "name": "São Paulo/Guarulhos",
      "coordenadas": "23°30'15.5\"S,45°15'30.2\"W",
      "latitude": -23.5043,
      "longitude": -45.2592,
      "altitude_ft": 2461,
      ...outros campos
    }
  ],
  "timestamp": "2024-01-15T10:30:00.000Z",
  "cached": true
}
```

---

### GET /api/aerodromes/:icao

Busca um aeródromo específico pelo código ICAO.

**Parameters:**
- `icao` (string): Código ICAO do aeródromo (ex: SBGR)

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "designativo": "SBGR",
    "name": "São Paulo/Guarulhos",
    "coordenadas": "23°30'15.5\"S,45°15'30.2\"W",
    ...
  },
  "timestamp": "2024-01-15T10:30:00.000Z",
  "cached": true
}
```

---

### POST /api/flight-calculations

Processa os cálculos finais do trecho de voo, incluindo:
- **Distância** entre aeródromos (Haversine em NM e km)
- **Tempo noturno** (baseado em horas de sol - regra ANAC)
- **Horários solares** (sunrise, sunset, dawn, dusk)
- **Verificação** se o pouso foi noturno

**Request Body:**
```json
{
  "departureIcao": "SBGR",
  "arrivalIcao": "SBBR",
  "flightDate": "2024-01-15",
  "landingTime": "14:30"
}
```

**OU com coordenadas manuais:**
```json
{
  "departureIcao": "SBGR",
  "arrivalManual": {
    "lat": -15.7894,
    "lng": -48.0272,
    "nome": "Destino Manual"
  },
  "flightDate": "2024-01-15",
  "landingTime": "14:30"
}
```

**Response:**
```json
{
  "data": {
    "distance": {
      "nm": 645.2,
      "km": 1194.5
    },
    "nightTime": {
      "hours": 1,
      "minutes": 23,
      "decimal": 1.38
    },
    "solarTimes": {
      "sunrise": {
        "time": "06:15",
        "minutes": 375
      },
      "sunset": {
        "time": "17:45",
        "minutes": 1065
      },
      "dawn": {
        "time": "05:45",
        "minutes": 345
      },
      "dusk": {
        "time": "18:15",
        "minutes": 1095
      }
    },
    "flight": {
      "departure": {
        "icao": "SBGR",
        "name": "São Paulo/Guarulhos"
      },
      "arrival": {
        "icao": "SBBR",
        "name": "Brasília"
      },
      "date": "2024-01-15",
      "landingTime": "14:30",
      "isNightFlightAtLanding": false
    }
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

---

## Formatos de Dados

### Coordenadas DMS (Degree, Minute, Second)

As coordenadas no banco estão em formato DMS e são automaticamente convertidas para decimal:

```
Formato: "23°30'15.5\"S,45°15'30.2\"W"
Decimal: { lat: -23.5043, lng: -45.2592 }
```

### Data e Hora

- **Data:** `YYYY-MM-DD` (ex: 2024-01-15)
- **Hora:** `HH:MM` (formato UTC, ex: 14:30)

---

## Cálculos Implementados

### 1. Distância (Haversine)

Utiliza a fórmula de Haversine para calcular a distância entre dois pontos na superfície terrestre:

```
R = 3440.065 NM (raio da Terra em milhas náuticas)
```

### 2. Tempo Noturno (ANAC)

Baseado na regra ANAC: o tempo noturno é contabilizado entre o final do crepúsculo civil (dusk) e o início (dawn).

- **Dusk:** Sol a -6° abaixo do horizonte
- **Dawn:** Sol a -6° acima do horizonte

Se o pouso ocorrer após o dusk, o tempo noturno é calculado como a diferença entre a hora de pouso e o horário de dusk.

### 3. Horários Solares

Utiliza a biblioteca **SunCalc** para calcular:
- **Sunrise:** Nascer do sol
- **Sunset:** Pôr do sol
- **Dawn:** Início do crepúsculo civil
- **Dusk:** Final do crepúsculo civil

---

## Erros Comuns

### 400 - Bad Request

```json
{
  "error": "Missing required fields: departureIcao, flightDate, landingTime"
}
```

**Solução:** Envie todos os campos obrigatórios.

### 404 - Not Found

```json
{
  "error": "Departure aerodrome not found: INVALID"
}
```

**Solução:** Use um código ICAO válido (ex: SBGR, SBBR, SBSP).

### 500 - Internal Server Error

```json
{
  "error": "Failed to calculate flight metrics",
  "details": "Invalid coordinates format"
}
```

**Solução:** Verifique se as coordenadas estão em formato válido.

---

## Integração no Frontend

Exemplo com o hook `useFlightCalculations`:

```typescript
import { useFlightCalculations } from '@/hooks/useFlightCalculations';

function MyComponent() {
  const { calculating, result, calculateFlightMetrics } = useFlightCalculations();

  const handleCalculate = async () => {
    const result = await calculateFlightMetrics(
      'SBGR',      // departureIcao
      'SBBR',      // arrivalIcao
      null,        // arrivalManual
      '2024-01-15',// flightDate
      '14:30'      // landingTime
    );

    if (result) {
      console.log(`Distância: ${result.distance.nm} NM`);
      console.log(`Tempo noturno: ${result.nightTime.decimal} horas`);
    }
  };

  return (
    <button onClick={handleCalculate} disabled={calculating}>
      {calculating ? 'Calculando...' : 'Calcular'}
    </button>
  );
}
```

---

## Cache

- **GET /api/aerodromes:** 24 horas
- **GET /api/aerodromes/details:** 24 horas
- **GET /api/aerodromes/:icao:** 24 horas
- **POST /api/flight-calculations:** Sem cache (real-time)

---

## Dependências

- `express`: Server HTTP
- `suncalc`: Cálculos de horários solares
- `@supabase/supabase-js`: Acesso ao banco de dados

---

## Desenvolvido para

Integração com o formulário de diário de bordo (`DynamicLogbookForm.tsx`) e hook (`useLogbookForm.ts`).
