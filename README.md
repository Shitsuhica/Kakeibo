# 家計簿 Kakeibo — Guía de despliegue completo

PWA de control de ingresos y gastos con IA, base de datos en la nube y exportación.
Soporta: ES · EN · 日本語 | Monedas: ¥ JPY · S/ PEN · MX$ MXN

---

## Estructura del proyecto

```
kakeibo/
├── kakeibo-app/              ← Frontend PWA
│   ├── index.html
│   ├── manifest.json
│   ├── sw.js
│   └── icon-*.png
└── kakeibo-backend/          ← Backend Node.js
    ├── server.js
    ├── package.json
    ├── supabase-schema.sql   ← Ejecuta esto en Supabase
    ├── .env.example
    └── .gitignore
```

---

## PASO 1 — Crear base de datos en Supabase (gratis)

1. Ve a https://supabase.com → New project
2. Elige un nombre y región (Tokyo para Japón, São Paulo para LATAM)
3. Dashboard → SQL Editor → New query
4. Pega el contenido de `supabase-schema.sql` → Run
5. Ve a Settings → API y copia:
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** → `SUPABASE_SERVICE_ROLE_KEY`

---

## PASO 2 — Obtener API Key de Anthropic

1. https://console.anthropic.com → API Keys → Create Key
2. Copia la key (empieza con `sk-ant-...`)

---

## PASO 3 — Desplegar en Render (gratis, recomendado)

1. Crea un repo en GitHub y sube TODOS los archivos
2. Ve a https://render.com → New → Web Service
3. Conecta tu repo de GitHub
4. Configura:
   - **Root Directory:** `kakeibo-backend`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. En Environment → Add las siguientes variables:

```
ANTHROPIC_API_KEY   = sk-ant-XXXXXXXXXX
SUPABASE_URL        = https://XXXX.supabase.co
SUPABASE_SERVICE_ROLE_KEY = eyJ...
ALLOWED_ORIGIN      = https://tu-app.onrender.com
PORT                = 3000
```

6. Deploy → en 2-3 minutos tendrás una URL pública

---

## PASO 4 — Instalar en el celular

### iPhone (Safari)
1. Abre tu URL en **Safari** (no Chrome)
2. Toca el botón **Compartir** (⬆)
3. Selecciona **"Agregar a pantalla de inicio"**
4. Toca **"Agregar"**

### Android (Chrome)
1. Abre tu URL en **Chrome**
2. Aparece un banner verde "Instalar Kakeibo"
3. Toca **"Instalar"**

---

## Desarrollo local

```bash
cd kakeibo-backend
npm install
cp .env.example .env
# Edita .env con tus keys reales
npm start
# → http://localhost:3000
```

---

## Alternativas de despliegue

| Plataforma | Plan gratuito | Notas |
|-----------|---------------|-------|
| **Render** | ✓ 750h/mes | Recomendado, se duerme tras 15min inactivo |
| **Railway** | ✓ $5 crédito | Más rápido, no se duerme |
| **Fly.io** | ✓ Limitado | Buena opción para Asia |
| **VPS propio** | — | Control total |

---

## Funcionalidades completas

- ✅ Ingresos: frecuencia diaria/semanal/quincenal/mensual, múltiples fuentes
- ✅ 10 categorías de gastos (fijos y variables)
- ✅ Pago de tarjeta de crédito como gasto fijo
- ✅ Gastos bancarios: servicios debitados, comisiones, tarjetas
- ✅ Escaneo de recibos con IA (japonés/español/inglés)
- ✅ Análisis ítem por ítem con categoría sugerida por IA
- ✅ Dashboard: balance ingreso vs gasto, gráfico 6 meses
- ✅ Presupuesto por categoría con alertas visuales
- ✅ Exportación a Excel (4 hojas) y PDF (multi-página)
- ✅ Base de datos Supabase — datos sincronizados entre dispositivos
- ✅ Funciona offline con sincronización automática al reconectar
- ✅ Instalable en iPhone y Android como app nativa
- ✅ 3 idiomas: ES / EN / 日本語
- ✅ 3 monedas: ¥ JPY · S/ PEN · MX$ MXN
