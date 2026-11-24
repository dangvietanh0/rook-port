"""The server binds, sends a welcome with the scene and GUI, then a snapshot.

Run against a server already listening on 127.0.0.1:8080, as the CI smoke
test does with `tests/demo.rbxlx`.
"""

import asyncio
import json
import urllib.request

import msgpack
import websockets

BASE = "http://127.0.0.1:8080"


async def main() -> None:
    for _ in range(60):
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=1) as response:
                health = json.load(response)
            break
        except OSError:
            await asyncio.sleep(1)
    else:
        raise SystemExit("the server didn't answer /api/health")
    print("health", health)

    async with websockets.connect("ws://127.0.0.1:8080/ws") as socket:
        welcome = msgpack.unpackb(
            await asyncio.wait_for(socket.recv(), 30), raw=False
        )
        assert welcome["kind"] == "welcome", welcome["kind"]
        scene = welcome["welcome"]
        assert scene["parts"], "the welcome has no parts"
        assert scene["gui"], "the welcome has no ScreenGui"
        print(
            "welcome",
            scene["place"],
            len(scene["parts"]),
            "parts,",
            len(scene["gui"]),
            "gui roots",
        )

        snapshot = msgpack.unpackb(
            await asyncio.wait_for(socket.recv(), 30), raw=False
        )
        assert snapshot["kind"] == "snapshot", snapshot["kind"]
        print("snapshot", snapshot["snapshot"]["tick"])


asyncio.run(main())
