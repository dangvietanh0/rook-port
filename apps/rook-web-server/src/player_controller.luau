-- The web client's character controller.
--
-- The browser owns the camera and sends a world-space walk direction; the
-- session stores it on the local player as `RookMove`. This reads that
-- attribute on every Heartbeat and drives the Humanoid. A place that ships
-- its own controller keeps it, and the welcome tells the browser to stay a
-- spectator.

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer
if not player then
	return
end

local playerScripts = player:FindFirstChild("PlayerScripts")
if playerScripts then
	for _, name in ipairs({ "PlayerModule", "ControlScript", "CameraScript" }) do
		if playerScripts:FindFirstChild(name) then
			return
		end
	end
end

local humanoid = nil

local function bind(character)
	humanoid = character:WaitForChild("Humanoid")
end

if player.Character then
	bind(player.Character)
end
player.CharacterAdded:Connect(bind)

local ZERO = Vector3.new(0, 0, 0)

RunService.Heartbeat:Connect(function()
	local current = humanoid
	if not current or current.Health <= 0 then
		return
	end
	if UserInputService:GetFocusedTextBox() then
		current:Move(ZERO, false)
		return
	end
	local move = player:GetAttribute("RookMove")
	if typeof(move) == "Vector3" then
		current:Move(move, false)
	else
		current:Move(ZERO, false)
	end
end)

UserInputService.InputBegan:Connect(function(input, processed)
	if processed then
		return
	end
	if input.KeyCode ~= Enum.KeyCode.Space then
		return
	end
	if not humanoid or humanoid.Health <= 0 then
		return
	end
	if UserInputService:GetFocusedTextBox() then
		return
	end
	humanoid.Jump = true
end)
