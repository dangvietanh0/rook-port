"""Start the server, then read a welcome with the scene and GUI and a snapshot.

Run from the repository root with the server binary as the first argument:

    python apps/rook-web-server/tests/smoke.py target/release/rook-web-server

The place is generated here rather than committed: the repository never
tracks Roblox files, and this one only needs a floor, a spawn and a script
that builds a ScreenGui.
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import msgpack
import websockets

PORT = int(os.environ.get("ROOK_SMOKE_PORT", "8080"))
BASE = f"http://127.0.0.1:{PORT}"

PLACE = """<roblox version="4">
  <Item class="Workspace" referent="ws">
    <Properties><string name="Name">Workspace</string></Properties>
    <Item class="Part" referent="floor">
      <Properties>
        <string name="Name">Baseplate</string>
        <bool name="Anchored">true</bool>
        <Vector3 name="size"><X>128</X><Y>2</Y><Z>128</Z></Vector3>
        <CoordinateFrame name="CFrame"><X>0</X><Y>-1</Y><Z>0</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame>
        <Color3 name="Color3"><R>0.4</R><G>0.62</G><B>0.4</B></Color3>
        <token name="Material">1280</token>
      </Properties>
    </Item>
    <Item class="SpawnLocation" referent="spawn">
      <Properties>
        <string name="Name">SpawnLocation</string>
        <bool name="Anchored">true</bool>
        <bool name="Neutral">true</bool>
        <Vector3 name="size"><X>12</X><Y>1</Y><Z>12</Z></Vector3>
        <CoordinateFrame name="CFrame"><X>0</X><Y>0</Y><Z>0</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame>
        <Color3 name="Color3"><R>0.3</R><G>0.7</G><B>1</B></Color3>
      </Properties>
    </Item>
  </Item>
  <Item class="Players" referent="players">
    <Properties><string name="Name">Players</string></Properties>
  </Item>
  <Item class="ServerScriptService" referent="sss">
    <Properties><string name="Name">ServerScriptService</string></Properties>
    <Item class="Script" referent="script">
      <Properties>
        <string name="Name">SmokeScript</string>
        <ProtectedString name="Source"><![CDATA[
local Players = game:GetService("Players")

local function decorate(player)
    local playerGui = player:WaitForChild("PlayerGui")
    if playerGui:FindFirstChild("SmokeHud") then return end

    local screen = Instance.new("ScreenGui")
    screen.Name = "SmokeHud"
    screen.Parent = playerGui

    local label = Instance.new("TextLabel")
    label.Name = "Greeting"
    label.Size = UDim2.new(0, 240, 0, 60)
    label.Position = UDim2.new(0, 24, 0, 24)
    label.Text = "Rook smoke test"
    label.Parent = screen

    local part = Instance.new("Part")
    part.Name = "MadeBySmokeScript"
    part.Anchored = true
    part.Size = Vector3.new(2, 2, 2)
    part.Position = Vector3.new(0, 6, 0)
    part.Parent = workspace
end

for _, player in Players:GetPlayers() do
    decorate(player)
end
Players.PlayerAdded:Connect(decorate)
]]></ProtectedString>
      </Properties>
    </Item>
  </Item>
</roblox>
"""


def start_server(binary: Path, place: Path, log: Path) -> subprocess.Popen:
    output = log.open("w")
    return subprocess.Popen(
        [str(binary), str(place), "--offline", "--addr", f"127.0.0.1:{PORT}"],
        stdout=output,
        stderr=subprocess.STDOUT,
        text=True,
    )


def wait_for_health(server: subprocess.Popen, log: Path) -> dict:
    for _ in range(60):
        if server.poll() is not None:
            raise SystemExit(f"the server exited before it bound:\n{log.read_text()}")
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=1) as response:
                return json.load(response)
        except OSError:
            time.sleep(1)
    raise SystemExit(f"the server didn't answer /api/health:\n{log.read_text()}")


def apply_snapshot(positions: dict[int, list[float]], snapshot: dict) -> None:
    for part in snapshot.get("created", []):
        positions[part["id"]] = part["position"]
    for part in snapshot.get("updatedProps", []):
        positions[part["id"]] = part["position"]
    for update in snapshot.get("updatedTransforms", []):
        positions[update["id"]] = update["position"]


async def read_messages() -> None:
    async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws") as socket:
        welcome = msgpack.unpackb(await asyncio.wait_for(socket.recv(), 30), raw=False)
        assert welcome["kind"] == "welcome", welcome["kind"]
        scene = welcome["welcome"]
        assert scene["parts"], "the welcome has no parts"
        assert scene["gui"], "the welcome has no ScreenGui"
        assert scene["play"] is True, "the smoke place should run in Play mode"
        assert scene["controller"] is True, "the web controller should be active"
        print(
            "welcome",
            scene["place"],
            len(scene["parts"]),
            "parts,",
            len(scene["gui"]),
            "gui roots",
        )

        positions: dict[int, list[float]] = {part["id"]: part["position"] for part in scene["parts"]}
        snapshot = msgpack.unpackb(await asyncio.wait_for(socket.recv(), 30), raw=False)
        assert snapshot["kind"] == "snapshot", snapshot["kind"]
        print("snapshot", snapshot["snapshot"]["tick"])
        apply_snapshot(positions, snapshot["snapshot"])

        # The character can spawn a frame after the welcome; keep reading
        # until its root has a net id.
        deadline = time.monotonic() + 20
        player = scene.get("player")
        while player is None and time.monotonic() < deadline:
            snapshot = msgpack.unpackb(await asyncio.wait_for(socket.recv(), 30), raw=False)
            apply_snapshot(positions, snapshot["snapshot"])
            player = snapshot["snapshot"].get("player")
        assert player is not None, "the character never appeared"
        root = player["root"]
        assert root is not None, "the character has no HumanoidRootPart"
        assert root in positions, "the root part was never sent"
        start = positions[root]
        print("player root", root, "at", start)

        # Hold a world-space direction. The browser sends this at 30 Hz;
        # the session's watchdog expects the stream.
        for _ in range(20):
            await socket.send(msgpack.packb({"kind": "move", "x": 1.0, "z": 0.0}))
            await asyncio.sleep(0.05)
        for _ in range(20):
            snapshot = msgpack.unpackb(await asyncio.wait_for(socket.recv(), 30), raw=False)
            apply_snapshot(positions, snapshot["snapshot"])
        moved = positions[root]
        distance = sum((moved[i] - start[i]) ** 2 for i in range(3)) ** 0.5
        assert distance > 0.25, f"the character barely moved: {distance}"
        print("moved", round(distance, 2), "studs")

        # Zero stops it.
        await socket.send(msgpack.packb({"kind": "move", "x": 0.0, "z": 0.0}))
        for _ in range(12):
            snapshot = msgpack.unpackb(await asyncio.wait_for(socket.recv(), 30), raw=False)
            apply_snapshot(positions, snapshot["snapshot"])
        stopped = positions[root]
        drift = sum((stopped[i] - moved[i]) ** 2 for i in range(3)) ** 0.5
        assert drift < 1.0, f"the character kept walking: {drift}"
        print("stopped", round(drift, 2), "studs after zero")


def main() -> None:
    binary = Path(sys.argv[1] if len(sys.argv) > 1 else "target/release/rook-web-server")
    with tempfile.TemporaryDirectory(prefix="rook-smoke-") as directory:
        place = Path(directory) / "smoke.rbxlx"
        log = Path(directory) / "server.log"
        place.write_text(PLACE)
        server = start_server(binary, place, log)
        try:
            health = wait_for_health(server, log)
            print("health", health)
            asyncio.run(read_messages())
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()


if __name__ == "__main__":
    main()
