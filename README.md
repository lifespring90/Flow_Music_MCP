**English** | [Español](README.es.md)

# Flow Music MCP (`flow-music-mcp`)

A local **Model Context Protocol (MCP)** server that gives AI agents (**Antigravity**, **Claude Code**, **OpenAI Codex**, **Claude Desktop**, etc.) direct control over **[Google Flow Music](https://www.flowmusic.app/)** using a dedicated, persistent Google Chrome profile.

Built for **automated batch music production**: let your agent read a video script, generate 8 custom soundtrack variations in the background, enforce credit budget caps, and download ready-to-edit **MP3 / WAV / M4A / stems** straight into your video project's folder without manual clicking.

---

## Key Features

- **One-shot or batch background pipeline**:
  - `flow_music_create`: generate, wait, and download a track in a single call.
  - `flow_music_generate`: queue up to **50 prompts/variations** sequentially with human-like pacing.
- **Direct project output**: save tracks straight into any local folder (`output_dir`) — such as your Remotion, Premiere, or CapCut project audio folder — or under `~/flow-music-mcp-out/<project>`.
- **Built-in credit protection**:
  - Reads your live credit balance before each run.
  - Supports `max_credits_per_prompt` and `max_total_credits` batch caps to automatically cancel remaining queued tracks before exceeding your budget.
  - Single-owner port lock (`127.0.0.1:8788`) prevents multiple AI clients from driving Chrome simultaneously and double-spending credits.
- **Full Compose controls**: instrumental toggle, custom lyrics, sound description, optional title, BPM, length, seed, and model selection (`Lyria 3.5` / `Lyria 3 Pro`).
- **Free library downloads**: list your Flow Music library (`flow_music_tracks`) and download existing tracks as **MP3, WAV, M4A, Stems (auto-extracted ZIP), or Video** at zero credit cost.
- **Isolated from `flow-mcp` (video)**: uses a separate Chrome CDP port (`9334`) and separate browser profile (`~/.flow-music-mcp/chrome-profile`) so you can run video and music MCPs side by side without conflicts.

---

## Requirements

- **Node.js 20+**
- **Google Chrome** installed on macOS, Windows, or Linux
- A Google account with access to [flowmusic.app](https://www.flowmusic.app/)

---

## Quick Start (3 Steps)

### 1. Clone and build

```bash
git clone https://github.com/lifespring90/Flow_Music_MCP.git
cd Flow_Music_MCP
npm install
npm run build
```

### 2. Sign in once

Launch the dedicated Chrome profile and sign in with your Google account:

```bash
npm run login
```

Once `https://www.flowmusic.app/` loads with your account signed in, your session stays saved in `~/.flow-music-mcp/chrome-profile`. You can keep that Chrome window open or let the MCP server reopen it automatically whenever needed.

### 3. Add to your AI client

Replace `/ABSOLUTE/PATH/TO/flow-music-mcp/dist/index.js` with your actual path (for example `/Users/you/flow-music-mcp/dist/index.js`).

#### Antigravity
Add to `~/.gemini/antigravity/mcp_config.json` (or via **Manage MCP Servers** in the Antigravity UI):

```json
{
  "mcpServers": {
    "flow-music": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/flow-music-mcp/dist/index.js"]
    }
  }
}
```

#### Claude Code

```bash
claude mcp add flow-music -- node /ABSOLUTE/PATH/TO/flow-music-mcp/dist/index.js
```

Or in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "flow-music": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/flow-music-mcp/dist/index.js"]
    }
  }
}
```

#### OpenAI Codex
Add to `~/.codex/config.toml`:

```toml
[mcp_servers.flow-music]
command = "node"
args = ["/ABSOLUTE/PATH/TO/flow-music-mcp/dist/index.js"]
```

#### Claude Desktop
Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "flow-music": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/flow-music-mcp/dist/index.js"]
    }
  }
}
```

---

## Available MCP Tools

| Tool | Description |
| :--- | :--- |
| `flow_music_status` | Checks Chrome connection, login state, username, plan, credits remaining, and queue status. |
| `flow_music_create` | All-in-one: generates a track in Compose, waits for completion, measures credits spent, and downloads it locally. |
| `flow_music_generate` | Queues 1–50 prompts/variations in the background with pacing, output directory, and credit budget limits (`max_total_credits`, `max_credits_per_prompt`). |
| `flow_music_wait` | Waits for queued jobs or a `task_id` (~40 s chunks to avoid client timeouts) and returns downloaded file paths and credits spent. |
| `flow_music_tracks` | Lists tracks in your Flow Music library (`id`, `title`, `duration`, `description`, `url`). |
| `flow_music_download` | Downloads existing library tracks by UUID or title in `mp3`, `wav`, `m4a`, `stems`, or `video` (0 credits). |
| `flow_music_cancel` | Cancels a queued job before it starts. |
| `flow_music_retry` | Re-queues failed or cancelled jobs. |
| `flow_music_outputs` | Lists saved folders and audio files in `~/flow-music-mcp-out`. |

---

## Example Agent Prompts

**Single track in one command:**
> "Check `flow_music_status`, then generate an upbeat 120 BPM tropical funk instrumental for a product ad and save it as WAV in `/path/to/my-video/audio`."

**Batch pipeline from a video script:**
> "Read `script.md` and use `flow_music_generate` to create 8 instrumental background music variations matching the mood of each scene. Save all MP3 files directly to `/path/to/my-video/music`, and set `max_total_credits` to 50."

---

## Environment Variables (Optional)

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `FLOW_MUSIC_MCP_CDP_PORT` | `9334` | Chrome remote debugging port (kept separate from `flow-mcp`'s `9333`). |
| `FLOW_MUSIC_MCP_PORT` | `8788` | Local coordinator lock port (kept separate from `flow-mcp`'s `8787`). |
| `FLOW_MUSIC_MCP_HOME` | `~/.flow-music-mcp` | Directory storing the Chrome profile, downloads cache, and lock token. |
| `FLOW_MUSIC_MCP_OUTPUT` | `~/flow-music-mcp-out` | Default output folder when using `project` instead of an absolute `output_dir`. |
| `FLOW_MUSIC_MCP_PAUSE_MIN_S` | `15` | Minimum seconds to pause between queued batch generations. |
| `FLOW_MUSIC_MCP_PAUSE_MAX_S` | `35` | Maximum seconds to pause between queued batch generations. |
| `FLOW_MUSIC_MCP_CHROME` | Auto-detected | Custom path to the Google Chrome executable. |

---

## Credits & Acknowledgments

Inspired by and adapted from the Chrome CDP + persistent-profile MCP architecture of **[GTAI-1/flow-mcp](https://github.com/GTAI-1/flow-mcp)** (video/image automation for Google Flow), redesigned cleanly from the ground up for **Google Flow Music** (`flowmusic.app`).

---

## License

[MIT](LICENSE)
