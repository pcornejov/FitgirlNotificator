# FitGirl Notificator

Cloudflare Worker que revisa cada 15 minutos el feed RSS oficial de
[FitGirl Repacks](https://fitgirl-repacks.site/feed/), detecta releases nuevos y
envía una alerta por WhatsApp con el título del juego y el enlace directo,
usando la API de [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/).

- Sin dependencias de runtime: `fetch` nativo del runtime de Workers y un parser
  RSS propio basado en expresiones regulares.
- Deduplicación persistente en Workers KV: un release se marca como visto
  **solo después** de que su mensaje de WhatsApp se entregó correctamente.
- Endpoint de *dry-run* (`GET /test`) para probar el flujo sin enviar mensajes
  ni escribir en KV.

---

## Arquitectura

```
cron */15  →  scheduled()  →  fetchLatestReleases()   src/feed.ts      (RSS → Release[])
                           →  filterUnseen(KV)        src/store.ts     (descarta ya notificados)
                           →  slice(MAX_NOTIFICATIONS_PER_RUN)
                           →  sendWhatsAppNotification() src/whatsapp.ts (CallMeBot + 1 reintento)
                           →  markSeen(KV, TTL)       src/store.ts     (solo tras envío OK)
```

| Archivo | Rol |
| --- | --- |
| `src/feed.ts` | Descarga y parseo del RSS. Limpia CDATA y entidades HTML. Lanza `FeedError` en 4xx/5xx o fallo de red. |
| `src/store.ts` | `filterUnseen` / `markSeen` sobre el namespace KV `SEEN_RELEASES`. |
| `src/whatsapp.ts` | `sendWhatsAppNotification` con `encodeURIComponent`, 1 reintento con backoff de 2 s ante 5xx/timeout, sin reintento ante 4xx. |
| `src/index.ts` | Handlers `scheduled` (cron) y `fetch` (dry-run `GET /test`). |

### Comportamiento a prueba de fallos

- Si falla la descarga del feed o la lectura de KV, la ejecución aborta **antes**
  de cualquier escritura: no se pierde ni se duplica ningún release.
- Si falla el envío de un release, ese release **no** se marca como visto y se
  reintenta en la corrida siguiente; los demás releases del lote siguen su curso.
- Si hay más releases nuevos que `MAX_NOTIFICATIONS_PER_RUN`, el excedente queda
  sin marcar y se envía en las corridas posteriores.

---

## Requisitos previos

1. Node.js 18+ y una cuenta de Cloudflare (el free tier alcanza de sobra).
2. **Activar el bot de CallMeBot** (paso obligatorio y por única vez, desde el
   teléfono que va a recibir las alertas):
   - Agrega a tus contactos de WhatsApp el número del bot publicado en la
     [página oficial de CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/)
     (el número puede cambiar, siempre tómalo desde ahí).
   - Envíale el mensaje: `I allow callmebot to send me messages`
   - El bot responde con tu **API key** personal. Guárdala: es el valor de
     `CALLMEBOT_API_KEY`.
   - Tu número en formato internacional y sin espacios (ej. `+<código-país><número>`) es
     el valor de `CALLMEBOT_PHONE`.

---

## Setup

```bash
# 1. Dependencias
npm install

# 2. Autenticarse en Cloudflare
npx wrangler login

# 3. Crear el namespace KV (producción y preview)
npx wrangler kv namespace create SEEN_RELEASES
npx wrangler kv namespace create SEEN_RELEASES --preview
```

El comando anterior imprime algo como:

```
[[kv_namespaces]]
binding = "SEEN_RELEASES"
id = "a1b2c3d4e5f6..."
```

Copia ese `id` (y el `preview_id` si creaste el preview) dentro de
`wrangler.toml`, reemplazando el placeholder
`<REPLACE_WITH_YOUR_KV_NAMESPACE_ID>`.

```bash
# 4. Cargar los secrets (NUNCA van en wrangler.toml ni en el código)
npx wrangler secret put CALLMEBOT_PHONE     # ej. +<código-país><número>
npx wrangler secret put CALLMEBOT_API_KEY   # la key que te dio el bot
```

---

## Configuración

Variables públicas (`[vars]` en `wrangler.toml`):

| Variable | Default | Descripción |
| --- | --- | --- |
| `FEED_URL` | `https://fitgirl-repacks.site/feed/` | Feed RSS a consultar. |
| `MAX_NOTIFICATIONS_PER_RUN` | `5` | Tope de mensajes por ejecución del cron. |
| `SEEN_TTL_DAYS` | `30` | Días que un release permanece marcado como visto en KV. |
| `USER_AGENT` | UA de Chrome | Opcional; sobreescribe el User-Agent de navegador usado contra el WAF. |

Secrets (vía `wrangler secret put`, **nunca** versionados):

| Secret | Descripción |
| --- | --- |
| `CALLMEBOT_PHONE` | Teléfono destino en formato internacional. |
| `CALLMEBOT_API_KEY` | API key entregada por el bot de CallMeBot. |

---

## Desarrollo y pruebas

```bash
npm test              # suite completa con Vitest
npm run typecheck     # tsc --noEmit (TypeScript estricto)
npm run dev           # wrangler dev en local
```

Para el desarrollo local, los secrets se cargan desde un archivo `.dev.vars`
(ignorado por git) con el mismo formato de un `.env`:

```
CALLMEBOT_PHONE=+00000000000
CALLMEBOT_API_KEY=your-callmebot-key
```

### Dry-run

Con `npm run dev` corriendo:

```bash
curl http://localhost:8787/test
```

Devuelve un JSON con los releases que **se habrían** notificado, sin llamar a
la API de WhatsApp ni escribir en KV:

```json
{
  "dryRun": true,
  "feedUrl": "https://fitgirl-repacks.site/feed/",
  "maxNotificationsPerRun": 5,
  "fetched": 10,
  "unseen": 2,
  "wouldNotify": [
    {
      "id": "https://fitgirl-repacks.site/?p=48211",
      "title": "Nombre del juego",
      "link": "https://fitgirl-repacks.site/nombre-del-juego/",
      "publishedAt": "Mon, 01 Sep 2025 08:30:00 +0000"
    }
  ],
  "skipped": 0
}
```

También puedes disparar el handler del cron en local:

```bash
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

---

## Deploy

```bash
npx wrangler deploy
```

Verificación posterior:

```bash
curl https://fitgirl-notificator.<tu-subdominio>.workers.dev/test   # dry-run en producción
npx wrangler tail                                                   # logs del cron en vivo
```

El Cron Trigger `*/15 * * * *` queda activo automáticamente tras el deploy.

---

## Notas

- El Worker solo consume el feed RSS oficial; no hace scraping de páginas HTML.
- La primera ejecución notificará todos los releases presentes en el feed (hasta
  `MAX_NOTIFICATIONS_PER_RUN`). Para partir en silencio, ejecuta primero el
  dry-run y precarga las claves con
  `npx wrangler kv key put --binding SEEN_RELEASES "<id-del-release>" "seen"`.
- CallMeBot es un servicio gratuito de terceros pensado para uso personal;
  aplica límites de tasa razonables.
