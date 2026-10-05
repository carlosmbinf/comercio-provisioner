# Aprovisionador de comercio VIDKAR

Worker Node independiente de `react-download`. Consume tareas por DDP sobre `wss://www.vidkar.com/websocket`; no abre conexiones directas a Mongo ni acepta comandos arbitrarios del navegador.

## Flujo

1. El propietario habilitado acepta los términos en la web y solicita una o varias páginas, cada una con su propio `slug.vidkar.com`.
2. VIDKAR guarda la solicitud como `PENDIENTE_DNS`. El worker todavía no clona ni ejecuta nada. El propietario puede cancelarla mientras siga pendiente; queda registrada como `CANCELADA` y libera el subdominio, pero no elimina un registro DNS que ya se haya creado en Squarespace.
3. El administrador crea manualmente en Squarespace un registro DNS **A** para el host `slug`, con la IPv4 pública reportada por este worker y TTL predeterminado.
4. El backend de VIDKAR comprueba automáticamente cada 60 segundos las solicitudes `PENDIENTE_DNS` y solo las libera cuando todos los A records resuelven a la IPv4 válida más reciente reportada por el worker. El administrador principal conserva el botón **Verificar DNS** para iniciar la misma comprobación manualmente.
5. El worker vuelve a verificar el DNS y, si sigue correcto, clona `comercio-web`, instala dependencias incluyendo Vite, crea el `.env` por tienda y arranca el servidor Vite con PM2 sin generar `dist`; luego configura Nginx, solicita un lineage Certbot exclusivo de la solicitud y comprueba HTTPS.
6. Al fallar una etapa, deshace en orden inverso los recursos creados por esa solicitud y reporta `FALLIDA` o `ROLLBACK_FALLIDO`. Si el proceso se reinicia, el lease vencido inicia recuperación desde el journal local.
7. Para cerrar una web completada, el propietario o el administrador principal solicita el cierre. El worker reclama una tarea con lease, valida el journal, detiene PM2 y systemd, termina cualquier proceso residual de la cuenta exclusiva de esa tienda (primero `TERM`, luego `KILL` acotado si sigue activo) y retira Nginx, el certificado exclusivo verificable, los archivos y la cuenta. Si no puede confirmar que los procesos terminaron, conserva la cuenta y reintenta el cierre. Cuando queda en espera de un reintento operativo, el propietario puede adelantarlo desde Empresa y el administrador principal desde la cola; se conservan los pasos completados y no se evitan bloqueos de seguridad o propiedad.

La documentación pública de Squarespace no ofrece una API de DNS. Sus Commerce APIs administran datos de tiendas Squarespace y el portal de desarrolladores marca las Reseller APIs de sitios/dominios como “Coming soon”. Referencias: `https://developers.squarespace.com/` y `https://support.squarespace.com/hc/en-us/articles/31119879125645-DNS-records-for-web-hosting`.

## Configuración

La configuración del worker está centralizada en el `.env` local de este proyecto. No se debe versionar ni copiar a registros, mensajes de error o tareas. Este repositorio incluye un `.env` local con marcadores para completar fuera de Git; configura sus valores antes de arrancar.

Variables necesarias:

- `METEOR_DDP_ENDPOINT`: WSS de Meteor; debe terminar en `/websocket`.
- `PROVISIONER_ID`, `PROVISIONER_TOKEN`, `PROVISIONER_HELPER_HMAC_SECRET` y `PROVISIONER_PUBLIC_IPV4`: identidad estable y única de esta instalación, dos secretos aleatorios distintos y la IPv4 del VPS. Mantén `PROVISIONER_ID` sin cambios entre reinicios; el worker crea aparte un ID de sesión efímero para el fencing.
- `COMERCIO_REPOSITORY_URL` y `COMERCIO_REPOSITORY_REF`: repositorio autorizado y rama; autentica Git con una deploy key del VPS, nunca con un token incrustado en la URL.
- `PROVISIONER_DEPLOY_ROOT`, `PROVISIONER_STATE_DIR`, `PROVISIONER_NGINX_SITES_AVAILABLE`, `PROVISIONER_NGINX_SITES_ENABLED` y `PROVISIONER_ACME_WEBROOT`: rutas locales del VPS.
- `PROVISIONER_CERTBOT_EMAIL`, `PROVISIONER_PORT_START` y `PROVISIONER_PORT_END`.
- `COMERCIO_VITE_METEOR_DDP_URL`, `COMERCIO_VITE_METEOR_HTTP_URL` y opcionalmente `COMERCIO_VITE_GOOGLE_MAPS_API_KEY`: valores públicos del cliente Vite.
- Intervalos y timeouts `PROVISIONER_*_MS`.

En `react-download/settings.json`, configura solo el SHA-256 del token en `private.comercioProvisioner.workerTokenSha256`; el bearer en texto claro se guarda únicamente en el `.env` del worker. El hash actual está vacío a propósito, por lo que la autenticación permanece deshabilitada hasta configurarlo. Usa un token aleatorio de al menos 32 bytes.

Las descargas de VIDKAR se leen de `Meteor.settings.public.empresaAppLinks`; el worker no configura esos enlaces.

## Requisitos del VPS

- Node.js 20 o posterior, Git, PM2, Nginx, Certbot, Python 3 (stdlib) y `procps` (`ps`).
- DNS A del subdominio resolviendo a `PROVISIONER_PUBLIC_IPV4` antes de que el trabajo salga de `PENDIENTE_DNS`.
- Crea el grupo `vidkar-commerce`; el helper crea una cuenta Linux aislada y un home por solicitud (`requestId`), no por subdominio. El proceso Node/PM2 del provisioner se ejecuta como `root`.
- El checkout Git temporal queda en `PROVISIONER_STATE_DIR/checkouts/<requestId>`, privado y propiedad de `root`. El helper valida y materializa solo el código (sin `.git`) en `/opt/vidkar/comercios/<slug>--<requestId>`, propiedad de la cuenta exclusiva de esa solicitud. Git no ejecuta lifecycle scripts; `npm install -f --include=dev` y el PM2 de cada sitio siguen corriendo como esa cuenta, sin token ni clave HMAC del worker. Vite transforma módulos bajo demanda y no se ejecuta `npm run build`. El helper también admite staging del usuario legacy `vidkar-provisioner` durante la migración.
- Si el repo es privado, instala una deploy key de solo lectura en `/root/.ssh`; Git clona a staging con la configuración global y del sistema deshabilitada.
- Instala el helper root-owned en `/usr/local/sbin/vidkar-commerce-helper`. Su key HMAC root-only valida un conjunto cerrado de acciones y valores.
- `PROVISIONER_STATE_DIR` debe ser root-owned y privado (modo `0700`); root escribe journals/locks y el helper crea los `.env` por tienda con modo `0600`.
- Instala el código, `node_modules` y `ecosystem.config.cjs` en una ruta root-owned no modificable por usuarios sin privilegios (preferiblemente fuera de `/home/cloud`); el `.env` debe ser `root:root` con modo `0600`. El proceso root carga código, dependencias, token DDP y clave HMAC, por lo que no debe poder modificarlos otro usuario.
- `/opt`, `/opt/vidkar`, `/opt/vidkar/comercios`, `/var/lib/vidkar-commerce` y las carpetas de Nginx administradas deben ser directorios reales root-owned y no escribibles por grupo/otros. El helper se niega a borrar si encuentra symlinks, ownership o permisos inesperados.

En la preparación manual del VPS, instala el helper desde este repositorio como `root:root` con permisos `0755` y crea el grupo `vidkar-commerce`. El usuario legacy `vidkar-provisioner` puede conservarse para permitir la limpieza de staging antiguo; el worker actual no depende de él ni requiere una regla sudoers propia. El helper sigue validando firmas HMAC y ejecutando las operaciones de cada tienda bajo su cuenta aislada.

Ejemplo de preparación única (el helper y la clave deben permanecer root-owned):

```sh
sudo install -o root -g root -m 0755 scripts/vidkar-commerce-helper /usr/local/sbin/vidkar-commerce-helper
sudo groupadd --system vidkar-commerce
sudo install -d -o root -g root -m 0755 /etc/vidkar
sudo install -o root -g root -m 0600 /dev/null /etc/vidkar/commerce-helper.key
```

El helper crea una unidad systemd de PM2 por comercio; no se requiere configurar `pm2 startup` manualmente por tienda. Los nombres/binarios de Git/npm/PM2 deben estar en rutas root-owned ejecutables dentro de `/usr/bin` o `/usr/local/bin`.

Genera `PROVISIONER_TOKEN` con un generador criptográfico local (mínimo 32 bytes) y calcula su SHA-256. El token en claro va solo en el `.env` del worker; el hash va en `Meteor.settings.private.comercioProvisioner.workerTokenSha256`. No guardes el token en Git, en la configuración pública ni en el chat. El hash placeholder vacío bloquea las llamadas del worker hasta que se complete esta configuración.

Genera aparte `PROVISIONER_HELPER_HMAC_SECRET` (otro secreto aleatorio distinto) y colócalo también en `/etc/vidkar/commerce-helper.key`, propiedad `root:root`, modo `0600`. La clave del helper nunca va a Meteor ni se hereda a Git/npm/PM2; cada operación privilegiada lleva una firma HMAC específica de acción y argumentos.

El usuario root del provisioner no se usa para ejecutar el código de las tiendas. Cada flujo tiene un usuario `vcomreq-<hash>` y home propios con permisos `0700`; el `.env` contiene solo configuración pública de Vite y queda con propietario de ese flujo y modo `0600`. Al reutilizar el mismo slug después de un cierre completo, el nuevo `requestId` obtiene una ruta, usuario, home, PM2 y unidad systemd nuevos. Los journals legacy sin `resourceVersion: 2` siguen resolviendo al path y usuario antiguos por slug para poder cerrarlos.

## Ejecución

Instala dependencias en una ubicación root-owned y ejecuta `npm run check` y `npm test`. Para producción, configura el `.env`, valida el SHA-256 correspondiente en `react-download/settings.json` y arranca `pm2 start ecosystem.config.cjs` como `root`. Despliega primero el backend Meteor con `worker.unregister` y takeover cercado por `PROVISIONER_ID`/IP; workers antiguos no conocen este protocolo y se deben detener antes del corte. El PM2 de root es independiente del PM2 que pudiera tener `vidkar-provisioner`: no mantengas ambos activos. El worker nuevo se desregistra en SIGINT/SIGTERM; si una caída abrupta impide el cierre, la siguiente instancia de la misma instalación y misma IP toma el registro y deja las tareas interrumpidas para recuperación. Tras arrancar, guarda el proceso con `pm2 save` y configura el inicio del daemon de root con `pm2 startup systemd -u root --hp /root` (aplica el comando que PM2 imprima). No ejecutes el worker contra producción hasta completar la migración de permisos y una prueba en un subdominio de staging.

### Migración del worker a root y recursos por requestId

Hazla una sola vez y con el worker de `vidkar-provisioner` detenido. El `stateDir` y el directorio de locks deben pertenecer al mismo UID que ejecuta el worker; el código rechaza un cambio de propietario implícito para no pisar locks activos. Migra el padre y su estado a `root:root`, manteniendo modo privado en el estado:

```sh
sudo chown root:root /var/lib/vidkar-provisioner
sudo chmod 0755 /var/lib/vidkar-provisioner
sudo chown -R root:root /var/lib/vidkar-provisioner/state
sudo chmod 0700 /var/lib/vidkar-provisioner/state
```

Conserva la deploy key privada del repositorio en `/root/.ssh` con permisos restrictivos. No arranques simultáneamente el daemon de PM2 del usuario legacy y el daemon root.

Los despliegues nuevos usan `/opt/vidkar/comercios/<slug>--<requestId>`, home/usuario derivados del `requestId` y una unidad systemd por flujo. No renombres recursos legacy a mano: el helper conserva su layout al leer journals antiguos y solo usa el layout por solicitud cuando `resourceVersion` vale `2`.

El worker solo acepta `*.vidkar.com`; no modifica ni solicita acceso a la cuenta de Squarespace. Los registros A se crean manualmente en el panel DNS. Antes de desplegar, el worker rechaza un checkout de `comercio-web` que tenga `.env` versionado: el `.gitignore` evita que se agreguen nuevos, pero no saca automáticamente del índice los que ya estén tracked.

## Rollback y certificados

El journal registra directorio, puerto, nombre PM2, certificado, enlace/configuración Nginx y los pasos completados. Nunca escribe el token, una contraseña Git ni el contenido completo de logs en Mongo. La limpieza local nunca revoca certificados ante la autoridad ACME.

## Cierre seguro de una tienda

- Solo se admite el cierre de una solicitud `COMPLETADA`; una instalación o un rollback en curso debe resolverse primero. El estado y el journal se conservan como auditoría y el puerto solo vuelve al pool cuando el cierre terminó.
- El worker valida que `requestId`, slug, host, usuario, nombre PM2, puerto y rutas del journal correspondan todos a la misma tienda. No acepta rutas ni comandos de cierre enviados desde el navegador. El helper root verifica además sus registros root-owned, marcadores de propiedad y los tipos/targets de los archivos antes de borrarlos.
- El orden es deliberado: detener el proceso PM2 de esa solicitud, cerrar también su daemon aislado y confirmar que liberó su puerto; retirar únicamente su unidad systemd y sus archivos/enlaces `sites-available`/`sites-enabled` marcados con ese `requestId`; reconciliar su certificado; y solo entonces borrar su carpeta de despliegue, home/usuario aislado y staging. El paso de eliminación de la cuenta vuelve a cerrar el daemon PM2 de forma idempotente y reintenta `userdel` tres veces para recuperarse de cierres anteriores en los que PM2 se retiró pero el daemon quedó activo.
- Los fallos operativos identificados se reintentan hasta tres veces por ejecución (esperas de 3 y 10 segundos). Si persisten, el backend programa otro intento automáticamente con espera exponencial (1, 2, 4 minutos y así sucesivamente, con un máximo de 30 minutos); los pasos `COMPLETADO` se conservan y se omiten. Los cierres históricos sin la versión de política actual se revalidan automáticamente una vez, incluso si un worker anterior dejó una marca genérica de bloqueo. El worker vuelve a verificar propiedad y seguridad; si el riesgo persiste, conserva los recursos y requiere revisión. No se pide una acción al propietario ni al administrador para errores operativos.
- Una validación de propiedad o seguridad (por ejemplo, journal ausente o inconsistente, ruta inesperada, symlink o ownership distinto) bloquea el cierre en `CIERRE_FALLIDO`. No se borran recursos dudosos; solo esos bloqueos requieren revisión manual. Si el lease expira con un paso `EN_PROGRESO`, ese paso se considera interrumpido y se vuelve a ejecutar idempotentemente.
- Si falta el registro root-owned de una solicitud pero existe un registro de dominio root-owned, regular y modo `0600` que vincula exactamente ese slug con el mismo `requestId`, el helper puede reconstruir el permiso y reintentar la limpieza. Si esa prueba falta, no coincide o tiene permisos inesperados, conserva los recursos y exige revisión manual; no se infiere propiedad solo por el nombre del usuario o la carpeta.
- Si también se perdieron ambos marcadores, el helper solo puede retirar una carpeta huérfana en la ruta exacta del slug cuando su UID no está asignado a ninguna cuenta, GID/modo coinciden con `vidkar-commerce`/`0700`, el `.env` es archivo regular privado del mismo UID/GID y su host y nombre PM2 coinciden con el slug y el prefijo del `requestId`; además deben faltar usuario, home, procesos, checkout, Nginx, systemd y marcador de certificado. En cualquier otro caso conserva la carpeta y requiere revisión. El escritor de `.env` usa un descriptor de directorio y creación exclusiva sin seguir symlinks, para no hacer `chown` root sobre una ruta sustituible.
- No se modifica `nginx.conf`, el sitio por defecto, otros archivos de Nginx, el webroot ACME compartido ni certificados de otros comercios. Nginx se valida con `nginx -t` antes de recargarlo.
- Los certificados nuevos usan un nombre derivado de slug y solicitud y un marcador root-owned. Al cerrar, Certbot elimina ese lineage marcado; para instalaciones antiguas sin marcador, también puede retirar el lineage cuyo nombre coincide exactamente con el hostname de la tienda. En ambos casos exige que el SAN DNS sea exactamente ese host y que no haya referencias desde Nginx, Apache, Caddy, HAProxy, Traefik, lighttpd ni unidades systemd (incluidas rutas `live` y `archive`). Se preservan certificados multi-dominio, referenciados por otro servicio o imposibles de verificar. `certbot delete` elimina el lineage local, no revoca el certificado emitido públicamente.
- El worker **no controla Squarespace**: el registro DNS A fue creado manualmente y no se borra al cerrar. Si el subdominio se reutilizará, incluso por otro propietario, conserva ese registro apuntando al VPS; solo si se retira permanentemente, administración debe quitar manualmente ese A. No se toca la zona DNS completa.
- Cerrar la web no elimina la empresa VIDKAR, sus tiendas del catálogo, productos, categorías, imágenes, ventas, pedidos, pagos ni datos Mongo. Las imágenes viven en el almacenamiento del backend Meteor, fuera del checkout de Vite.
- Las solicitudes cerradas quedan retenidas para auditoría, pero liberan el subdominio: el mismo u otro propietario habilitado puede solicitar de nuevo el mismo slug. Es una solicitud nueva, con otro `requestId` y `ownerId`; al desplegar, el worker genera el entorno con el nuevo `ownerId` y `displayName`. El cierre de la web no elimina los datos comerciales del propietario anterior en Mongo. Mientras la solicitud anterior conserve recursos o tenga un cierre/rollback pendiente, el subdominio sigue reservado y no puede asignarse a otro flujo.

### Despliegue de la capacidad de cierre

Despliega primero el backend Meteor actualizado para admitir la espera y reentrada automática; instala después este helper como `root:root` en `/usr/local/sbin/vidkar-commerce-helper` con modo `0755`; actualiza/reinicia el worker **como `root`** y finalmente publica la UI. El registro anuncia si el worker admite reintentos automáticos: workers anteriores no reclaman tareas diferidas ni recuperan cierres históricos. El helper anterior no reconoce `remove-certificate` ni la reconciliación del registro root-owned. Los cierres históricos sin la versión de política actual serán revalidados automáticamente una vez por el nuevo backend y worker. Prueba primero con una tienda de staging y comprueba que otro subdominio permanece disponible.
