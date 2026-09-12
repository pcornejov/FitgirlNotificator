# FitGirl Notificator

Cloudflare Worker que revisa cada 15 minutos el feed RSS oficial de
[FitGirl Repacks](https://fitgirl-repacks.site/feed/), detecta releases nuevos y
envía una alerta con el título del juego y el enlace directo.

Soporta dos canales, seleccionables con la variable `NOTIFIER`. Puedes usar uno
o los dos a la vez (`NOTIFIER = "telegram,callmebot"`):

| `NOTIFIER` | Canal | Notas |
| --- | --- | --- |
| `telegram` (default) | [Telegram Bot API](https://core.telegram.org/bots/api) | Gratis, sin lista de espera, API oficial. |
| `callmebot` | WhatsApp vía [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/) | Gratis, pero sujeto a que el bot tenga cupos libres. |

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
                           →  isGameRelease()          src/feed.ts      (descarta posts que no son juegos)
                           →  filterUnseen(KV)        src/store.ts     (descarta ya notificados)
                           →  slice(MAX_NOTIFICATIONS_PER_RUN)
                           →  notifier.send()          src/notifier.ts  (Telegram o CallMeBot)
                           →  markSeen(KV, TTL)       src/store.ts     (solo tras envío OK)
```

| Archivo | Rol |
| --- | --- |
| `src/feed.ts` | Descarga y parseo del RSS. Limpia CDATA y entidades HTML. Lanza `FeedError` en 4xx/5xx o fallo de red. |
| `src/store.ts` | `filterUnseen` / `markSeen` sobre `SEEN_RELEASES`. Clave por versión del post, para que un repack actualizado vuelva a notificar. |
| `src/notify.ts` | Transporte común: 1 reintento con backoff de 2 s ante 5xx/408/429/timeout, sin reintento ante 4xx, `NotificationError` tipado. |
| `src/telegram.ts` | Envío por Bot API. Manda la portada con `sendPhoto` vía proxy de imágenes y cae a `sendMessage` si falla. |
| `src/whatsapp.ts` | Envío por CallMeBot. |
| `src/upcoming.ts` | Lee la lista de "Upcoming Repacks" del feed y calcula las altas respecto a la corrida anterior. |
| `src/notifier.ts` | Interfaz `Notifier` y selección de canal según `NOTIFIER`. |
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

Node.js 18+ y una cuenta de Cloudflare (el free tier alcanza de sobra), más las
credenciales del canal que vayas a usar.

### Opción A — Telegram (recomendada)

1. En Telegram, escribe a [@BotFather](https://t.me/BotFather) y envía `/newbot`.
2. Elige un nombre y un username terminado en `bot`. BotFather responde con el
   **token** (formato `123456789:AAH...`): ese es `TELEGRAM_BOT_TOKEN`.
3. Abre una conversación con **tu propio bot** y envíale cualquier mensaje
   (ej. `hola`). Sin ese primer mensaje, Telegram no permite que el bot te
   escriba.
4. Obtén tu `TELEGRAM_CHAT_ID`:

   ```bash
   curl -s "https://api.telegram.org/bot<TU_TOKEN>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'
   ```

   Devuelve algo como `"chat":{"id":987654321`. Ese número es tu chat id (si es
   un grupo, viene en negativo: incluye el signo `-`).

5. Verifica de punta a punta antes de tocar Cloudflare:

   ```bash
   curl -s "https://api.telegram.org/bot<TU_TOKEN>/sendMessage?chat_id=<TU_CHAT_ID>&text=prueba%20fitgirl"
   ```

   Si te llega "prueba fitgirl" por Telegram, las credenciales están bien.

### Opción B — WhatsApp vía CallMeBot

Requiere que el bot tenga cupos libres; cuando está lleno, su página oculta el
número y hay que esperar. Desde el teléfono que recibirá las alertas:

1. Agrega a tus contactos de WhatsApp el número del bot publicado en la
   [página oficial de CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/)
   (el número puede cambiar, siempre tómalo desde ahí).
2. Envíale el mensaje: `I allow callmebot to send me messages`
3. El bot responde con tu **API key** personal: es el valor de `CALLMEBOT_API_KEY`.
   Si no llega en 2 minutos, hay que reintentar 24 h después.
4. Tu número con código de país y **sin el `+`** (ej. `56900000000`) es el valor
   de `CALLMEBOT_PHONE`. El `+` se interpreta como espacio en una query string;
   guardarlo solo con dígitos evita cualquier ambigüedad.
5. Recuerda poner `NOTIFIER = "callmebot"` en `wrangler.toml`.

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
# 4. Cargar los secrets del canal activo (NUNCA van en wrangler.toml ni en el código)

# Si NOTIFIER = "telegram"
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID

# Si NOTIFIER = "callmebot"
npx wrangler secret put CALLMEBOT_PHONE
npx wrangler secret put CALLMEBOT_API_KEY
```

Solo hacen falta los secrets de los canales activos: el Worker no valida las
credenciales de un canal que no está en uso. Si `NOTIFIER` lista dos canales y
a uno le faltan credenciales, la corrida aborta antes de escribir en KV, en vez
de descartar ese canal en silencio.

---

## Configuración

Variables públicas (`[vars]` en `wrangler.toml`):

| Variable | Default | Descripción |
| --- | --- | --- |
| `NOTIFIER` | `telegram` | Canales activos: `telegram`, `callmebot`, o ambos separados por coma (`telegram,callmebot`). |
| `FEED_URL` | `https://fitgirl-repacks.site/feed/` | Feed RSS a consultar. |
| `REQUIRE_CATEGORY` | `Lossless Repack` | Solo se notifican posts en esta categoría. `""` desactiva el filtro. |
| `NOTIFY_UPCOMING` | `true` | Avisa cuando un juego entra a la lista de "Upcoming Repacks". `"false"` lo desactiva. |
| `MAX_NOTIFICATIONS_PER_RUN` | `5` | Tope de mensajes por ejecución del cron. |
| `SEEN_TTL_DAYS` | `30` | Días que un release permanece marcado como visto en KV. |
| `USER_AGENT` | UA de Chrome | Opcional; sobreescribe el User-Agent de navegador usado contra el WAF. |

Secrets (vía `wrangler secret put`, **nunca** versionados):

| Secret | Canal | Descripción |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | `telegram` | Token que entrega @BotFather. |
| `TELEGRAM_CHAT_ID` | `telegram` | Id del chat destino (negativo si es un grupo). |
| `CALLMEBOT_PHONE` | `callmebot` | Teléfono destino, con código de país y sin `+`. |
| `CALLMEBOT_API_KEY` | `callmebot` | API key entregada por el bot de CallMeBot. |

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
TELEGRAM_BOT_TOKEN=123456789:your-bot-token
TELEGRAM_CHAT_ID=000000000
```

### Dry-run

Con `npm run dev` corriendo:

```bash
curl http://localhost:8787/test
```

Devuelve un JSON con los releases que **se habrían** notificado, sin llamar a
la API del canal ni escribir en KV (funciona incluso antes de cargar los
secrets):

```json
{
  "dryRun": true,
  "channel": "telegram",
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
- El feed incluye posts que no son releases ("Upcoming Repacks", "Updates
  Digest"). Se filtran por categoría: los repacks reales llevan
  `Lossless Repack`, esos otros no.
- FitGirl actualiza un repack editando el post existente y subiéndole la fecha
  de publicación, con lo que reaparece arriba en el feed con el mismo `guid`.
  Por eso la clave de KV es `guid@timestamp`: una actualización vuelve a
  notificar, marcada como "🔄 Repack actualizado", mientras que releer el
  mismo post sin cambios no genera nada.
- La portada de cada release viene en el propio feed (primer `<img>` de
  `content:encoded`), alojada en un host que ni Telegram ni el Worker en una
  ejecución de cron logran alcanzar. Por eso la URL se reescribe a través de
  `i0.wp.com` y es Telegram quien la descarga: el Worker no baja ni sube la
  imagen.
- Cambiar de canal, o activar los dos, es cambiar `NOTIFIER` en `wrangler.toml`,
  cargar los secrets correspondientes y volver a desplegar. No hay cambios de
  código.
- Con varios canales activos, un release se marca como visto en cuanto **al
  menos uno** entrega. Retenerlo hasta que todos lo logren haría que un canal
  averiado provocara reenvíos cada 15 minutos en los que sí funcionan. Si
  fallan todos, no se marca y se reintenta en la corrida siguiente.
- CallMeBot solo envía texto: las portadas llegan únicamente por Telegram.
- El post "Upcoming Repacks" se edita constantemente, así que no se anuncia en
  cada cambio: se guarda la lista en KV y solo se avisa cuando aparece un
  título nuevo. El mensaje lleva las altas marcadas con 🆕 y debajo la lista
  completa, como recordatorio de todo lo que viene. La primera corrida
  registra la lista sin notificar, para no dispararla entera de golpe.
- La primera ejecución notificará todos los releases presentes en el feed (hasta
  `MAX_NOTIFICATIONS_PER_RUN`). Para partir en silencio, ejecuta primero el
  dry-run y precarga las claves con
  `npx wrangler kv key put --binding SEEN_RELEASES "<id-del-release>" "seen"`.
- CallMeBot es un servicio gratuito de terceros pensado para uso personal;
  aplica límites de tasa razonables. Si su bot está lleno, usa Telegram.
