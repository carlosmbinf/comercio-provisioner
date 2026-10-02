# Aprovisionador de comercio VIDKAR

Worker Node independiente de `react-download`. Consume tareas por DDP sobre `wss://www.vidkar.com/websocket`; no abre conexiones directas a Mongo ni acepta comandos arbitrarios del navegador.

## Flujo

1. El propietario habilitado acepta los términos en la web y solicita `slug.vidkar.com`.
2. VIDKAR guarda la solicitud como `PENDIENTE_DNS`. El worker todavía no clona ni ejecuta nada.
3. El administrador crea manualmente en Squarespace un registro DNS **A** para el host `slug`, con la IPv4 pública reportada por este worker y TTL predeterminado.
4. En VIDKAR, el administrador principal pulsa **Verificar DNS**. El backend consulta los A records y solo libera el trabajo si todos resuelven al VPS esperado.
5. El worker vuelve a verificar el DNS y, si sigue correcto, clona `comercio-web`, instala dependencias incluyendo Vite, crea el `.env` por tienda y arranca el servidor Vite con PM2 sin generar `dist`; luego configura Nginx, solicita el certificado y comprueba HTTPS.
6. Al fallar una etapa, deshace en orden inverso los recursos creados por esa solicitud y reporta `FALLIDA` o `ROLLBACK_FALLIDO`. Si el proceso se reinicia, el lease vencido inicia recuperación desde el journal local.

La documentación pública de Squarespace no ofrece una API de DNS. Sus Commerce APIs administran datos de tiendas Squarespace y el portal de desarrolladores marca las Reseller APIs de sitios/dominios como “Coming soon”. Referencias: `https://developers.squarespace.com/` y `https://support.squarespace.com/hc/en-us/articles/31119879125645-DNS-records-for-web-hosting`.

## Configuración

La configuración del worker está centralizada en el `.env` local de este proyecto. No se debe versionar ni copiar a registros, mensajes de error o tareas. Este repositorio incluye un `.env` local con marcadores para completar fuera de Git; configura sus valores antes de arrancar.

Variables necesarias:

- `METEOR_DDP_ENDPOINT`: WSS de Meteor; debe terminar en `/websocket`.
- `PROVISIONER_ID`, `PROVISIONER_TOKEN`, `PROVISIONER_HELPER_HMAC_SECRET` y `PROVISIONER_PUBLIC_IPV4`: identidad, dos secretos aleatorios distintos y la IPv4 del VPS.
- `COMERCIO_REPOSITORY_URL` y `COMERCIO_REPOSITORY_REF`: repositorio autorizado y rama; autentica Git con una deploy key del VPS, nunca con un token incrustado en la URL.
- `PROVISIONER_DEPLOY_ROOT`, `PROVISIONER_STATE_DIR`, `PROVISIONER_NGINX_SITES_AVAILABLE`, `PROVISIONER_NGINX_SITES_ENABLED` y `PROVISIONER_ACME_WEBROOT`: rutas locales del VPS.
- `PROVISIONER_CERTBOT_EMAIL`, `PROVISIONER_PORT_START` y `PROVISIONER_PORT_END`.
- `COMERCIO_VITE_METEOR_DDP_URL`, `COMERCIO_VITE_METEOR_HTTP_URL` y opcionalmente `COMERCIO_VITE_GOOGLE_MAPS_API_KEY`: valores públicos del cliente Vite.
- Intervalos y timeouts `PROVISIONER_*_MS`.

En `react-download/settings.json`, configura solo el SHA-256 del token en `private.comercioProvisioner.workerTokenSha256`; el bearer en texto claro se guarda únicamente en el `.env` del worker. El hash actual está vacío a propósito, por lo que la autenticación permanece deshabilitada hasta configurarlo. Usa un token aleatorio de al menos 32 bytes.

Las descargas de VIDKAR se leen de `Meteor.settings.public.empresaAppLinks`; el worker no configura esos enlaces.

## Requisitos del VPS

- Node.js 20 o posterior, Git, PM2, Nginx, Certbot y Python 3 (stdlib).
- DNS A del subdominio resolviendo a `PROVISIONER_PUBLIC_IPV4` antes de que el trabajo salga de `PENDIENTE_DNS`.
- Crea una cuenta de worker `vidkar-provisioner` y un grupo `vidkar-commerce`; el helper crea una cuenta Linux aislada por subdominio.
- El checkout Git temporal queda en `PROVISIONER_STATE_DIR/checkouts/<requestId>`, privado para el worker. El helper root valida y materializa solo el código (sin `.git`) en la carpeta de la tienda, propiedad de su cuenta aislada. Git no ejecuta lifecycle scripts; `npm install -f --include=dev` y PM2 corren como esa cuenta, sin token ni clave HMAC del worker. Vite transforma módulos bajo demanda y no se ejecuta `npm run build`.
- Si el repo es privado, instala una deploy key de solo lectura en el home de `vidkar-provisioner` (`~/.ssh`); Git clona a staging con la configuración global y del sistema deshabilitada.
- Instala el helper root-owned en `/usr/local/sbin/vidkar-commerce-helper`. Su key HMAC root-only valida un conjunto cerrado de acciones y valores.
- `PROVISIONER_STATE_DIR` debe ser privado (modo `0700`); el worker escribe journals y el helper crea los `.env` por tienda con modo `0600`.

En la preparación manual del VPS, instala el helper desde este repositorio como `root:root` con permisos `0755`. Crea el usuario dedicado del worker y el grupo `vidkar-commerce`; mediante `visudo`, permite al worker ejecutar **solo** el helper root firmado. Git solo clona al staging como el worker; `npm install -f --include=dev` y PM2 siempre se ejecutan bajo la cuenta aislada de la tienda, sin sudo directo para esos binarios ni para ejecutar el worker como root.

Ejemplo de preparación única (el helper y la clave deben permanecer root-owned):

```sh
sudo install -o root -g root -m 0755 scripts/vidkar-commerce-helper /usr/local/sbin/vidkar-commerce-helper
sudo groupadd --system vidkar-commerce
sudo useradd --system --create-home --home-dir /var/lib/vidkar-provisioner --shell /usr/sbin/nologin vidkar-provisioner
sudo install -d -o root -g root -m 0755 /etc/vidkar
sudo install -o root -g root -m 0600 /dev/null /etc/vidkar/commerce-helper.key
sudo visudo -f /etc/sudoers.d/vidkar-commerce-provisioner
```

En el archivo `sudoers`, añade únicamente esta regla; el worker no debe tener sudo genérico ni sudo directo para Git/npm/PM2:

```text
vidkar-provisioner ALL=(root) NOPASSWD: /usr/local/sbin/vidkar-commerce-helper
```

El helper crea una unidad systemd de PM2 por comercio; no se requiere configurar `pm2 startup` manualmente por tienda. Los nombres/binarios de Git/npm/PM2 deben estar en rutas root-owned ejecutables dentro de `/usr/bin` o `/usr/local/bin`.

Genera `PROVISIONER_TOKEN` con un generador criptográfico local (mínimo 32 bytes) y calcula su SHA-256. El token en claro va solo en el `.env` del worker; el hash va en `Meteor.settings.private.comercioProvisioner.workerTokenSha256`. No guardes el token en Git, en la configuración pública ni en el chat. El hash placeholder vacío bloquea las llamadas del worker hasta que se complete esta configuración.

Genera aparte `PROVISIONER_HELPER_HMAC_SECRET` (otro secreto aleatorio distinto) y colócalo también en `/etc/vidkar/commerce-helper.key`, propiedad `root:root`, modo `0600`. La clave del helper nunca va a Meteor ni se hereda a Git/npm/PM2; cada operación privilegiada lleva una firma HMAC específica de acción y argumentos.

El usuario del worker no debe pertenecer al grupo `vidkar-commerce`. Cada tienda tiene un usuario y home propios con permisos `0700`; su `.env` contiene solo configuración pública de Vite y queda con propietario de esa tienda y modo `0600`.

## Ejecución

Instala dependencias en este directorio y ejecuta `npm run check` y `npm test`. Para producción, configura el `.env`, valida el SHA-256 correspondiente en `react-download/settings.json` y arranca `ecosystem.config.cjs` con PM2. No ejecutes el worker contra producción hasta completar DNS, permisos y una prueba en un subdominio de staging.

El worker solo acepta `*.vidkar.com`; no modifica ni solicita acceso a la cuenta de Squarespace. Los registros A se crean manualmente en el panel DNS. Antes de desplegar, el worker rechaza un checkout de `comercio-web` que tenga `.env` versionado: el `.gitignore` evita que se agreguen nuevos, pero no saca automáticamente del índice los que ya estén tracked.

## Rollback y certificados

El journal registra el directorio, puerto, nombre PM2, enlace/configuración Nginx y respaldos creados. Nunca escribe el token, una contraseña Git ni el contenido completo de logs en Mongo. Un certificado que Certbot ya haya emitido no se revoca automáticamente durante el rollback; se retira el sitio y su configuración local sin afectar certificados de otras tiendas.
