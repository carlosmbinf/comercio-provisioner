# Guía: configurar un VPS nuevo para el provisioner

Procedimiento para una instalación limpia de `comercio-provisioner` en Debian o Ubuntu con `systemd`. El worker administra sitios `*.vidkar.com`, crea recursos aislados y usa rutas estándar de Nginx/Certbot. No ejecutes estos pasos sin adaptar y revisar el sistema si la distribución no es Debian/Ubuntu. Los comandos usan `sudo`; si ya estás en una shell root, puedes omitir ese prefijo. Si `sudo` todavía no está instalado, instala los paquetes iniciales como root.

## 1. Preparar el VPS y la red

- Asigna una IPv4 pública estática y confirma que el VPS tiene salida TCP 443 hacia VIDKAR, Git y Let's Encrypt.
- Permite entrada TCP 80 y 443 en el firewall del proveedor y en el firewall del sistema; conserva SSH limitado a las IP administrativas. **No expongas** el rango de puertos de Vite `5200-5899`: las tiendas escuchan solo en `127.0.0.1` y Nginx actúa como proxy.
- El worker solo admite subdominios `*.vidkar.com`. Administración crea manualmente cada registro DNS **A** y debe apuntarlo a la IPv4 configurada en `PROVISIONER_PUBLIC_IPV4`.
- Si sustituyes otro VPS, detén y desregistra primero el worker antiguo siguiendo el protocolo del backend. No mantengas dos workers activos con la misma identidad ni copies sin revisar journals, cuentas, homes, certificados o recursos activos del VPS anterior.
- Si el VPS nuevo recibió configuraciones Nginx del montaje anterior, revisa que no quede otro bloque activo con el mismo `server_name`. Nginx también carga archivos sin extensión `.conf`; el provisioner solo administra los archivos `.conf` marcados con el `requestId` y no elimina bloques legacy no verificables.

Para revisar un hostname concreto antes de crear una solicitud, reemplaza el ejemplo por el subdominio solicitado:

```sh
sudo grep -RInF 'tienda.vidkar.com' /etc/nginx/sites-available /etc/nginx/sites-enabled
```

Si aparece una configuración de un despliegue anterior, confirma a quién pertenece y desactívala de forma controlada antes de provisionar. Conserva una copia de `sites-available`; no borres archivos Nginx de propiedad dudosa.

## 2. Instalar dependencias del sistema

Instala los paquetes base como administrador:

```sh
sudo apt-get update
sudo apt-get install -y sudo git nginx certbot python3 procps openssh-client ca-certificates openssl
```

Instala Node.js **20 o posterior** de forma system-wide desde una fuente de paquetes confiable. No continúes si la versión instalada es anterior a 20. Evita NVM para los binarios que usa el helper: `npm` y `pm2` deben resolverse desde `/usr/bin` o `/usr/local/bin`, rutas root-owned aprobadas por el helper.

```sh
node --version
npm --version
sudo npm install --global pm2
command -v npm
command -v pm2
sudo -n true
```

Verifica que Nginx use `sites-available` y `sites-enabled` y quede activo:

```sh
sudo systemctl enable --now nginx
sudo nginx -t
```

Certbot debe estar actualizado y disponible en el `PATH` del helper (`/usr/bin` o `/usr/local/bin`). La instalación de Debian/Ubuntu no siempre incluye la versión más reciente; verifica su origen y versión antes de emitir certificados. Let's Encrypt tiene límites de emisión: evita pruebas repetidas contra el mismo hostname.

## 3. Instalar el código y preparar rutas protegidas

Clona o despliega el repositorio autorizado en una ubicación administrada por `root`, por ejemplo `/opt/vidkar/comercio-provisioner`. Si el repositorio es privado, usa una deploy key de solo lectura; no incluyas tokens ni contraseñas en la URL. El checkout de `comercio-web` también necesita acceso Git de solo lectura desde `/root/.ssh`.

```sh
sudo install -d -o root -g root -m 0755 /opt/vidkar
sudo git clone <URL_SSH_AUTORIZADA_DEL_REPO> /opt/vidkar/comercio-provisioner
cd /opt/vidkar/comercio-provisioner
npm ci
npm run check
npm test
```

Reemplaza `<URL_SSH_AUTORIZADA_DEL_REPO>` por la URL del repositorio provisioner autorizada para esta instalación. No pegues una URL con credenciales. Conserva el código, `node_modules`, `ecosystem.config.cjs` y `.env` bajo ownership de `root`; no permitas que los usuarios de las tiendas puedan modificarlos.

Prepara las rutas base. Ejecuta cada línea como comando independiente y espera a que vuelva el prompt antes de continuar:

```sh
sudo install -d -o root -g root -m 0755 /opt/vidkar/comercios
```

```sh
sudo install -d -o root -g root -m 0755 /var/lib/vidkar-commerce /var/lib/vidkar-provisioner
```

```sh
sudo install -d -o root -g root -m 0700 /var/lib/vidkar-provisioner/state
```

El worker crea el subdirectorio de locks y el helper crea el directorio privado de ownership de solicitudes cuando se usa. Puedes prepararlo desde el inicio:

```sh
sudo install -d -o root -g root -m 0700 /var/lib/vidkar-commerce-helper
```

## 4. Crear y completar `.env`

Crea el archivo privado desde la plantilla y edítalo localmente en el VPS:

```sh
sudo install -o root -g root -m 0600 .env.example .env
sudoedit .env
```

Reemplaza todos los valores `REEMPLAZAR_...`. Genera dos valores independientes ejecutando `openssl rand -hex 32` dos veces: usa uno para `PROVISIONER_TOKEN` y el otro para `PROVISIONER_HELPER_HMAC_SECRET`. Copia las salidas directamente al `.env`; no las reutilices ni las compartas.

La configuración exige:

- `METEOR_DDP_ENDPOINT`: WSS de Meteor terminado en `/websocket`.
- `PROVISIONER_ID`: identificador único y estable de esta instalación; mantenlo igual entre reinicios.
- `PROVISIONER_TOKEN`: token aleatorio de al menos 32 caracteres.
- `PROVISIONER_HELPER_HMAC_SECRET`: secreto aleatorio diferente del token. Este mismo secreto se instalará en el archivo HMAC del helper.
- `PROVISIONER_PUBLIC_IPV4`: IPv4 pública estática de este VPS.
- `COMERCIO_REPOSITORY_URL` y `COMERCIO_REPOSITORY_REF`: repo autorizado y rama de `comercio-web`; no incluyas credenciales en la URL.
- `PROVISIONER_CERTBOT_EMAIL`: correo válido para ACME.
- `COMERCIO_VITE_METEOR_DDP_URL` y `COMERCIO_VITE_METEOR_HTTP_URL`: endpoints públicos WSS/HTTPS del backend.

Las rutas y el rango incluidos en `.env.example` deben conservarse: el helper valida las rutas de despliegue, estado, Nginx y Certbot. Los intervalos y timeouts son opcionales y usan los defaults de `src/config.js`. No copies el `.env` del VPS anterior sin revisar la IPv4, identidad y secretos.

El bearer `PROVISIONER_TOKEN` debe tener su SHA-256 configurado en `Meteor.settings.private.comercioProvisioner.workerTokenSha256` y desplegado en el backend **antes de iniciar el worker**. Para calcular el hash sin imprimir el token, ejecuta desde la raíz del repositorio:

```sh
node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const { parse } = require("dotenv");
const token = String(parse(fs.readFileSync(".env", "utf8")).PROVISIONER_TOKEN || "").trim();
if (token.length < 32 || /^(?:REEMPLAZAR|CHANGE_ME|<)/i.test(token)) {
  throw new Error("PROVISIONER_TOKEN falta, es un marcador o es demasiado corto.");
}
console.log(crypto.createHash("sha256").update(token).digest("hex"));
NODE
```

Guarda únicamente el hash en la configuración **privada** de Meteor. No publiques ni envíes el token o el hash en logs, repositorios públicos o conversaciones.

## 5. Instalar el helper root y su clave HMAC

El worker ejecuta el helper en `/usr/local/sbin/vidkar-commerce-helper` mediante `sudo -n`. Tener solo el código del helper dentro del repositorio no basta: debe instalarse en esa ruta exacta. Ejecuta cada comando por separado:

```sh
getent group vidkar-commerce >/dev/null || sudo groupadd --system vidkar-commerce
```

```sh
sudo install -o root -g root -m 0755 scripts/vidkar-commerce-helper /usr/local/sbin/vidkar-commerce-helper
```

```sh
sudo install -d -o root -g root -m 0755 /etc/vidkar
```

```sh
sudo install -d -o root -g root -m 0700 /var/lib/vidkar-commerce-helper
```

Con `.env` ya completado y `npm ci` ejecutado, crea `/etc/vidkar/commerce-helper.key` con el mismo valor de `PROVISIONER_HELPER_HMAC_SECRET`. El siguiente bloque debe ejecutarse como `root` desde la raíz del repositorio. No imprime el secreto y no sobrescribe un archivo existente:

```sh
node <<'NODE'
const fs = require("node:fs");
const { parse } = require("dotenv");

if (process.getuid() !== 0) throw new Error("Ejecuta como root.");
const values = parse(fs.readFileSync(".env", "utf8"));
const secret = String(values.PROVISIONER_HELPER_HMAC_SECRET || "").trim();
if (secret.length < 32 || /^(?:REEMPLAZAR|CHANGE_ME|<)/i.test(secret)) {
  throw new Error("PROVISIONER_HELPER_HMAC_SECRET falta, es un marcador o es demasiado corto.");
}

const keyFile = "/etc/vidkar/commerce-helper.key";
const fd = fs.openSync(keyFile, "wx", 0o600);
try {
  fs.writeFileSync(fd, `${secret}\n`);
  fs.fchownSync(fd, 0, 0);
  fs.fchmodSync(fd, 0o600);
} finally {
  fs.closeSync(fd);
}
console.log("Clave HMAC instalada desde .env; el valor no se mostró.");
NODE
```

Si el bloque indica que el archivo ya existe, no lo elimines ni lo sobrescribas a ciegas. Compara su valor con `.env` sin imprimirlo; si rotas el secreto, actualiza ambos lados de forma coordinada y reinicia el worker.

## 6. Preflight obligatorio antes del primer worker

Ejecuta estas comprobaciones desde `/opt/vidkar/comercio-provisioner`. No inician ni modifican una tienda:

```sh
node -e 'require("dotenv").config(); require("./src/config").loadConfig(); console.log("Configuración válida.")'
npm run check
npm test
sudo test -x /usr/local/sbin/vidkar-commerce-helper
sudo test -s /etc/vidkar/commerce-helper.key
sudo nginx -t
sudo -n true
getent group vidkar-commerce
```

Verifica los propietarios y modos esperados:

```sh
sudo stat -c '%U:%G %a %n' /usr/local/sbin/vidkar-commerce-helper /etc/vidkar/commerce-helper.key /var/lib/vidkar-commerce-helper /var/lib/vidkar-provisioner/state
```

Deben ser `root:root 755` para el helper y `root:root 600` para la clave; los directorios privados deben ser `root:root 700`. Comprueba además que el helper instalado incluye la versión actual:

```sh
sudo grep -q 'remove_orphaned_site_directory' /usr/local/sbin/vidkar-commerce-helper && echo "Helper actualizado."
```

Nginx puede devolver código 0 en `nginx -t` aunque emita `conflicting server name ... ignored`. Eso significa que otro bloque ya reclama el hostname y uno de los vhosts no será seleccionado. El helper actual rechaza esa advertencia durante la instalación y reporta el hostname en conflicto; reconcilia el bloque antiguo antes de reintentar.

Compara la clave instalada con `.env` sin mostrar ninguna de las dos:

```sh
node <<'NODE'
const fs = require("node:fs");
const { parse } = require("dotenv");
const expected = String(parse(fs.readFileSync(".env", "utf8")).PROVISIONER_HELPER_HMAC_SECRET || "").trim();
const installed = fs.readFileSync("/etc/vidkar/commerce-helper.key", "utf8").trim();
if (!expected || /^(?:REEMPLAZAR|CHANGE_ME|<)/i.test(expected) || expected !== installed) {
  console.error("La clave HMAC no coincide con .env.");
  process.exit(1);
}
console.log("La clave HMAC coincide; el valor no se mostró.");
NODE
```

No inicies el worker si falla cualquiera de estas comprobaciones. En particular:

- `sudo: /usr/local/sbin/vidkar-commerce-helper: command not found`: helper ausente o instalado en otra ruta.
- `Privileged helper key is not installed`: falta el archivo `/etc/vidkar/commerce-helper.key`.
- `Operation signature does not authorize these arguments`: el secreto del `.env` no coincide con la clave root, o el helper instalado está desactualizado.
- Si falta `vidkar-commerce`, créalo antes de procesar solicitudes.
- `Another NGINX server block already claims ...`: revisa los archivos activos en `sites-enabled` y resuelve el `server_name` duplicado. No elimines un bloque legacy si no confirmaste que está fuera de uso.

## 7. Iniciar el worker

Despliega primero el backend Meteor actualizado con el SHA-256 del token y el protocolo de registro/lease del worker. Confirma que el antiguo worker está detenido y que la identidad/IP permitidas corresponden a este VPS.

Desde la raíz del proyecto, como `root`:

```sh
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root
```

PM2 imprime un comando de systemd de configuración inicial: ejecútalo tal como lo muestra y luego vuelve a ejecutar `pm2 save`. Verifica `pm2 status`, los logs de este worker y que VIDKAR lo muestre en línea. No mantengas activo el daemon PM2 legacy de un usuario distinto junto al daemon root.

## 8. Primera prueba controlada

1. Confirma desde fuera del VPS que la IPv4 pública responde y que los puertos 80/443 están permitidos.
2. Crea manualmente en Squarespace un registro A para un subdominio de prueba permitido; espera a que resuelva solo a `PROVISIONER_PUBLIC_IPV4`.
3. Envía una sola solicitud desde VIDKAR y sigue sus etapas. El worker vuelve a validar DNS antes de clonar.
4. Comprueba que el sitio responde por HTTPS y que Nginx no modificó el sitio por defecto ni otra tienda.
5. Prueba el cierre desde VIDKAR y confirma que solo elimina los recursos de esa solicitud.

No repitas emisiones para depurar certificados: Let's Encrypt aplica límites. El VPS debe tener salida TCP 443 y el challenge HTTP-01 debe poder llegar por el puerto 80.

## Recuperar un `ROLLBACK_FALLIDO`

No ejecutes `rm`, `chown`, `userdel`, `systemctl stop` ni borres certificados manualmente. Primero instala/corrige el helper y la clave, conserva la salida de **Ver consola** y usa **Reintentar rollback** desde VIDKAR. El helper verifica ownership y evidencia antes de borrar; si no puede demostrar que los recursos pertenecen a la solicitud, los conserva para revisión manual.
