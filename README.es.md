[English](README.md) | **Español**

# Flow Music MCP (`flow-music-mcp`)

Servidor **MCP (Model Context Protocol)** local que permite a tus agentes de IA (**Antigravity**, **Claude Code**, **OpenAI Codex**, **Claude Desktop**, etc.) controlar **[Google Flow Music](https://www.flowmusic.app/)** de forma automática usando un perfil dedicado y persistente de Google Chrome.

Diseñado para **producción musical automatizada en lote**: deja que tu agente lea el guion de un video, genere 8 variaciones musicales en segundo plano, controle el gasto de créditos y descargue los audios listos en **MP3 / WAV / M4A / stems** directamente dentro de la carpeta de tu proyecto sin hacer clic manualmente.

---

## Funciones Principales

- **Modo en una sola orden o en lote en segundo plano**:
  - `flow_music_create`: genera, espera y descarga una pista en una sola orden.
  - `flow_music_generate`: encola hasta **50 prompts o variaciones** en segundo plano con pausas naturales entre cada una.
- **Descarga directa a la carpeta de tu proyecto**: guarda los audios directamente en la carpeta de tu video (`output_dir`) — ideal para flujos con Remotion, Premiere o CapCut — o en `~/flow-music-mcp-out/<proyecto>`.
- **Control real de gasto de créditos**:
  - Lee tu saldo real de créditos antes de cada generación.
  - Permite definir `max_credits_per_prompt` y un presupuesto total por lote (`max_total_credits`) para detener automáticamente las pistas restantes antes de pasarse del límite.
  - Bloqueo por puerto único (`127.0.0.1:8788`) para evitar que dos clientes de IA usen Chrome al mismo tiempo o gasten créditos por duplicado.
- **Controles reales del panel Compose**: modo instrumental, letra personalizada, descripción de sonido, título opcional, BPM, duración, semilla (`seed`) y selector de modelo (`Lyria 3.5` / `Lyria 3 Pro`).
- **Descargas gratuitas de tu biblioteca**: lista tus canciones en Flow Music (`flow_music_tracks`) y descarga pistas ya creadas en **MP3, WAV, M4A, Stems (ZIP extraído automáticamente) o Video** sin gastar créditos.
- **Totalmente aislado de `flow-mcp` (video)**: usa su propio puerto de Chrome (`9334`) y su propio perfil (`~/.flow-music-mcp/chrome-profile`) para convivir sin conflictos junto al MCP de video.

---

## Requisitos

- **Node.js 20 o superior**
- **Google Chrome** instalado (macOS, Windows o Linux)
- Una cuenta de Google con acceso a [flowmusic.app](https://www.flowmusic.app/)

---

## Instalación Rápida (3 Pasos)

### 1. Clonar y compilar

```bash
git clone https://github.com/lifespring90/Flow_Music_MCP.git
cd Flow_Music_MCP
npm install
npm run build
```

### 2. Iniciar sesión una sola vez

Abre la ventana de Chrome dedicada e inicia sesión con tu cuenta de Google:

```bash
npm run login
```

Una vez cargue `https://www.flowmusic.app/` con tu cuenta iniciada, la sesión quedará guardada en `~/.flow-music-mcp/chrome-profile`. Puedes dejar esa ventana abierta o cerrarla cuando termines (el servidor MCP la abrirá automáticamente cuando la necesite).

### 3. Conectar a tu agente de IA

Reemplaza `/RUTA/ABSOLUTA/A/flow-music-mcp/dist/index.js` por la ruta real en tu computadora (por ejemplo `/Users/tu-usuario/flow-music-mcp/dist/index.js`).

#### Antigravity
Agrégalo en `~/.gemini/antigravity/mcp_config.json` (o desde **Manage MCP Servers** en la interfaz de Antigravity):

```json
{
  "mcpServers": {
    "flow-music": {
      "command": "node",
      "args": ["/RUTA/ABSOLUTA/A/flow-music-mcp/dist/index.js"]
    }
  }
}
```

#### Claude Code

```bash
claude mcp add flow-music -- node /RUTA/ABSOLUTA/A/flow-music-mcp/dist/index.js
```

O en el archivo `.mcp.json` de tu proyecto:

```json
{
  "mcpServers": {
    "flow-music": {
      "command": "node",
      "args": ["/RUTA/ABSOLUTA/A/flow-music-mcp/dist/index.js"]
    }
  }
}
```

#### OpenAI Codex
Agrégalo en `~/.codex/config.toml`:

```toml
[mcp_servers.flow-music]
command = "node"
args = ["/RUTA/ABSOLUTA/A/flow-music-mcp/dist/index.js"]
```

#### Claude Desktop
Agrégalo en `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "flow-music": {
      "command": "node",
      "args": ["/RUTA/ABSOLUTA/A/flow-music-mcp/dist/index.js"]
    }
  }
}
```

---

## Herramientas Disponibles

| Herramienta | Qué hace |
| :--- | :--- |
| `flow_music_status` | Verifica la conexión con Chrome, si hay sesión iniciada, usuario, plan, créditos restantes y estado de la cola. |
| `flow_music_create` | Todo en uno: genera una pista en Compose, espera a que termine, mide los créditos gastados y descarga el audio. |
| `flow_music_generate` | Encola de 1 a 50 prompts o variaciones en segundo plano con pausas humanas, carpeta de destino y tope de créditos (`max_total_credits`, `max_credits_per_prompt`). |
| `flow_music_wait` | Espera trabajos en cola o un `task_id` (en bloques de ~40 s para evitar timeouts) y devuelve las rutas de descarga y créditos gastados. |
| `flow_music_tracks` | Lista las canciones de tu biblioteca en Flow Music (`id`, `title`, `duration`, `description`, `url`). |
| `flow_music_download` | Descarga canciones existentes por UUID o título en `mp3`, `wav`, `m4a`, `stems` o `video` (0 créditos). |
| `flow_music_cancel` | Cancela un trabajo en cola que aún no ha comenzado. |
| `flow_music_retry` | Reintenta trabajos fallidos o cancelados. |
| `flow_music_outputs` | Lista las carpetas y archivos descargados en `~/flow-music-mcp-out`. |

---

## Ejemplos de Prompts para tu Agente

**Generar una pista en una sola orden:**
> "Revisa `flow_music_status`, genera una pista instrumental funk tropical a 120 BPM para un anuncio y guárdala en formato WAV dentro de `/ruta/a/mi-video/audio`."

**Pipeline en lote leyendo un guion:**
> "Lee `guion.md` y usa `flow_music_generate` para crear 8 variaciones instrumentales distintas que encajen con cada escena del video. Descarga todos los MP3 directamente en `/ruta/a/mi-video/musica` con un presupuesto máximo `max_total_credits` de 50."

---

## Variables de Entorno (Opcionales)

| Variable | Valor por defecto | Uso |
| :--- | :--- | :--- |
| `FLOW_MUSIC_MCP_CDP_PORT` | `9334` | Puerto de depuración de Chrome (separado del `9333` de `flow-mcp`). |
| `FLOW_MUSIC_MCP_PORT` | `8788` | Puerto del coordinador local (separado del `8787` de `flow-mcp`). |
| `FLOW_MUSIC_MCP_HOME` | `~/.flow-music-mcp` | Carpeta donde se guarda el perfil de Chrome, caché de descargas y token. |
| `FLOW_MUSIC_MCP_OUTPUT` | `~/flow-music-mcp-out` | Carpeta de salida por defecto cuando usas `project` en lugar de `output_dir`. |
| `FLOW_MUSIC_MCP_PAUSE_MIN_S` | `15` | Pausa mínima en segundos entre generaciones de un lote. |
| `FLOW_MUSIC_MCP_PAUSE_MAX_S` | `35` | Pausa máxima en segundos entre generaciones de un lote. |
| `FLOW_MUSIC_MCP_CHROME` | Detección automática | Ruta personalizada al ejecutable de Google Chrome. |

---

## Créditos y Agradecimientos

Inspirado y adaptado a partir de la arquitectura Chrome CDP + perfil persistente de **[GTAI-1/flow-mcp](https://github.com/GTAI-1/flow-mcp)** (automatización de video e imagen para Google Flow), reconstruido desde cero de forma independiente para **Google Flow Music** (`flowmusic.app`).

---

## Licencia

[MIT](LICENSE)
