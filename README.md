# Jesús Díaz Automotores — WhatsApp Bot (Next.js + Supabase)

Webhook: `POST /api/whatsapp/webhook` y verificación `GET /api/whatsapp/webhook`.

## 1) Instalación
```bash
npm i
cp .env.example .env.local
npm run dev
```

## 2) Supabase (SQL)
Ejecutá en orden:
- `sql/001_init.sql`
- `sql/002_seed_agents.sql`

> Importante: el bot usa tu tabla real `public.vehicles` (según el dump que me pasaste) con columnas:
> `id, title, brand, model, year, price, currency, pictures, permalink, km/Km, status`.
> Por defecto filtra `status in ('available','active')`.
> Si querés filtrar por agencia/tenant, seteá `DEALERSHIP_ID` en `.env.local` y se filtra por `dealership_id`.

## 3) WhatsApp Cloud API
- Configurá el webhook en Meta apuntando a:
  - `https://TU-DOMINIO/api/whatsapp/webhook`
- Usá `META_VERIFY_TOKEN` para la verificación.
- (Recomendado) completá `META_APP_SECRET` para validar `X-Hub-Signature-256`.

## 4) Derivación (round-robin)
Cuando el bot decide derivar:
- asigna el lead a un agente (tabla `agents`)
- guarda el resumen en `bot_runs` (decision `notify_agent_outbox`)

El vendedor, por ahora, le escribe al cliente desde su WhatsApp personal usando el link `wa.me`.

---

Si querés que el bot *también* le mande el resumen al vendedor por WhatsApp, vas a necesitar:
- que el vendedor haya dado opt-in al número del bot, y
- respetar ventana 24h o usar Message Templates.
