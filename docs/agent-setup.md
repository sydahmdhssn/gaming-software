# Setting up a gaming PC (Windows)

The agent connects one PC to the DXL server. It keeps the PC locked until the front desk, or a member at the lock screen, starts a session.

## 1. Add the station on the dashboard

**Stations & zones**, then **Add station** (type **PC**). Click **Show** under *Pairing token* and copy the config it shows.

## 2. Install on the PC

1. Install **Node.js 22 LTS** from nodejs.org.
2. Copy the project folder to the PC, for example `C:\DXL\gaming-software`, and run `npm install --omit=dev` inside it.
3. Save the config from step 1 as `C:\DXL\gaming-software\agent\config.json`:

   ```json
   {
     "serverUrl": "ws://192.168.1.10:8080/ws",
     "token": "the station's pairing token",
     "localPort": 47800
   }
   ```

   `192.168.1.10` is the LAN IP of the server PC. The server prints it when it starts.
4. Test it with `npm run agent`. The lock screen should open full screen, and the station should show **Online** on the dashboard.

## 3. Start automatically on login

The agent must run in the player's Windows session (not as a Windows service), so it can show the lock screen.

Create `C:\DXL\start-agent.cmd`:

```bat
@echo off
cd /d C:\DXL\gaming-software
node agent\src\index.js >> C:\DXL\agent.log 2>&1
```

Press `Win + R`, type `shell:startup`, and put a shortcut to `start-agent.cmd` in that folder. Set the shortcut to run **Minimized**.

## 4. Recommended hardening

These steps close the obvious ways around the lock screen until the native shell ships:

* Players use a **standard (non admin) Windows account** that logs in automatically.
* Group Policy: *User Configuration › Administrative Templates › System › Ctrl+Alt+Del Options*. Enable **Remove Task Manager**, **Remove Lock Computer**, **Remove Change Password** and **Remove Logoff**.
* Disable the Edge **swipe and edge gestures** on touch screens.
* Give the server PC a **fixed LAN IP** so agents can always find it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Lock screen says *Connecting* | Check the server is running, the IP in `serverUrl` is right, and Windows Firewall on the server allows port 8080. |
| *Server rejected this PC* | The pairing token is wrong or was regenerated. Copy it again from the dashboard. |
| *Microsoft Edge was not found* | Set the `DXL_EDGE_PATH` environment variable to the full path of `msedge.exe`. |
