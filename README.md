# DXL Gaming Zone Manager

**By DXL Solutions.** Software for running a gaming zone: time management, billing and remote control of every PC from one front desk.

## What it does

| Area | Features |
| --- | --- |
| **Front desk floor** | Live map of every PC and console, grouped by zone. Shows who is playing, time left or time played, and which PCs are ending soon, paused or offline. |
| **Sessions** | Four session types: **Prepaid** (fixed minutes, paid upfront), **Open** (pay per minute at the end), **Member** (runs on the member's balance) and **Staff** (free maintenance unlock). Staff can add time, pause, resume and end sessions. |
| **Zones and pricing** | Any number of zones (for example Standard, VIP, Console), each with its own hourly rate. Billing is per started minute. |
| **Members** | Member accounts with a username, PIN and prepaid balance. Members sign in on any PC's lock screen and play until their balance runs out. A top up during a session adds time straight away. |
| **PC control** | Each PC runs the DXL agent. It stays locked until a session starts, unlocks automatically, warns at 5 and 1 minutes left, and locks again when time is up. Staff can send messages, restart and shut down PCs remotely. |
| **Reports** | Cash in by cash or card, member top ups, session revenue, sessions, hours played, revenue by zone, a transaction log with the staff member who took each payment, and CSV export. |
| **Staff accounts** | Owner account at first run, plus extra staff logins. |

## How it fits together

```
 Front desk browser ──HTTP + WebSocket──┐
                                        │
                              ┌─────────▼─────────┐
                              │   DXL server      │  Node.js, SQLite file database
                              │   (one per venue) │  serves the dashboard on :8080
                              └─────────▲─────────┘
                                        │ WebSocket (live)
          ┌─────────────────┬───────────┴─────┬─────────────────┐
     PC 01 agent       PC 02 agent       VIP 01 agent        ...
     lock screen       lock screen       lock screen
```

* **`server/`** holds all business rules and the database. It ends sessions on time and pushes changes live to every dashboard and PC.
* **`server/public/`** is the staff dashboard. It's plain HTML, CSS and JavaScript with no build step.
* **`agent/`** runs on each gaming PC. On Windows it shows the lock screen as a full screen Microsoft Edge kiosk window. If the network drops, it still locks the PC when a timed session runs out.
* Consoles are added as **timer only** stations: staff start and end sessions on the dashboard and billing works the same, without an agent.

## Quick start

Needs **Node.js 22.13 or newer**.

```bash
npm install
npm run server          # dashboard at http://localhost:8080
```

1. Open the dashboard and create the owner account.
2. **Stations & zones**: add zones with hourly rates, then add stations.
3. On each gaming PC, install the agent with the station's pairing token. See [docs/agent-setup.md](docs/agent-setup.md).

To try it without a real PC, run a simulated agent on the same machine. It prints lock and unlock events, and you can open the lock screen at http://127.0.0.1:47800:

```bash
DXL_SERVER_URL=ws://localhost:8080/ws DXL_STATION_TOKEN=<token> npm run agent
```

### Server settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Dashboard and agent port |
| `HOST` | `0.0.0.0` | Listen address |
| `DB_FILE` | `data/dxl-gaming-zone.db` | SQLite database file. Back this file up. |

## Tests

```bash
npm test
```

The tests cover billing, every session type, pause and resume, expiry, member balance and PIN lockout, the guards, reports, and a full server and agent round trip over a real WebSocket.

## Current limits and next steps

This is version 0.1. What still needs doing before a real venue goes live:

* **Lock screen hardening on Windows.** The Edge kiosk lock reopens itself if closed, but a determined player could still use Ctrl+Alt+Del or Task Manager. Next: run players under a restricted Windows account with Task Manager blocked by Group Policy, plus a native always on top shell.
* **Agent installer.** Package the agent as a Windows installer with auto start and auto update.
* **Food and drinks point of sale**, with orders from the PC.
* **Online booking** and a member mobile view.
* **Hardware console controller** to switch consoles on and off automatically.
* **HTTPS** when the dashboard is used outside the venue network.
