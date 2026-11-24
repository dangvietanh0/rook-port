# Kế hoạch Port `AsyncFinn/rook` sang Web (Phương án A: Headless Server + Three.js Client)

## Mục tiêu & Nguyên tắc Thiết kế

* **Tận dụng tối đa lõi của `AsyncFinn/rook`:** Không viết lại DataModel, Luau VM, Task Scheduler, Replication, Physics (Rapier 240Hz), Terrain hay Content Resolver. Giữ nguyên kiến trúc của `rook` và mở rộng thêm một app mới trong `apps/` để giữ khả năng đồng bộ/merge cập nhật từ upstream (`git pull`).
* **Kiến trúc Server-Authoritative Simulation + Thin Web Client:**
  * Backend chạy `rook-client` ở chế độ headless, mô phỏng toàn bộ gameplay, vật lý và tải/cache Asset bằng API Key.
  * Trình duyệt chạy Three.js + HTML/CSS Overlay nhận luồng Delta Snapshot qua WebSocket và gửi Input ngược về server.
* **Mục tiêu Đồ họa ("Roblox-Clean Balance"):**
  * Đạt chất lượng hình ảnh **vừa đủ giống Roblox**: ánh sáng hài hòa, bóng đổ sắc nét quanh nhân vật không răng cưa, chất liệu phân biệt rõ (`Plastic`, `Studs`, `Metal`, `Neon`, `Glass`...), có độ sâu không gian.
  * **Không** làm hệ thống cinematic nặng nề (không raytracing, không SSR/SSAO nặng, không post-processing lòe loẹt) để đảm bảo FPS ổn định trên trình duyệt.
* **Tuân thủ License (Apache-2.0):** Giữ nguyên `LICENSE`, cập nhật file `NOTICE` ghi nhận `Rook Contributors` / `AsyncFinn` và ghi chú thay đổi ở các tệp được chỉnh sửa.

---

## Kiến trúc Hệ thống

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Backend (Fork từ AsyncFinn/rook - Rust Native)                          │
│                                                                         │
│  [crates/* của rook]                                                    │
│   ├─ DataModel, Luau Server/Client VM, Replication, Rapier Physics      │
│   ├─ Content Resolver + Disk Cache (+ Patch gắn API Key tải Asset)      │
│   └─ Mesh Decoder & Terrain Chunk Builder                               │
│                                                                         │
│  [apps/rook-web-server] (Viết mới, bọc quanh rook-client)               │
│   ├─ Headless Frame Loop (thay thế vòng lặp cửa sổ winit/wgpu)          │
│   ├─ Snapshot Extractor & Dirty Tracker (State Diffing)                 │
│   ├─ Input Injector (nhận phím/chuột/UI event từ client)                │
│   └─ Axum Server: WebSocket (MessagePack) + HTTP (/assets/:id cache)    │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ WebSocket (Delta Snapshot / Input)
                                    │ HTTP (Textures, Pre-decoded Meshes, Audio)
┌───────────────────────────────────▼─────────────────────────────────────┐
│ Frontend (web-client - Vite + TypeScript + Three.js + HTML/CSS)         │
│                                                                         │
│  ├─ Network & State Interpolation (lerp/slerp giữa các gói snapshot)    │
│  ├─ Three.js Renderer (InstancedMesh, CSM Shadows, Material Presets)    │
│  ├─ Web Audio Engine (Audio / PositionalAudio từ asset proxy)           │
│  └─ HTML/CSS UI Overlay (ánh xạ ScreenGui / PlayerGui đè lên Canvas)    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Thiết kế Lớp Backend (`apps/rook-web-server` & Patch tối thiểu)

### Chạy `rook-client` không phụ thuộc cửa sổ/GPU (`Headless Bridge`)
* Tái sử dụng toàn bộ pipeline nạp `.rbxl`/`.rbxlx` và vòng lặp tick của `rook-client`.
* Tách bỏ phần khởi tạo cửa sổ `winit` và `wgpu` Surface trong luồng chạy của `rook-web-server` (chỉ giữ lại các dữ liệu hình học/tài nguyên đã được `rook` giải mã ở CPU).
* Quản lý vòng đời mỗi phiên preview: mở file `.rbxl` -> chạy game loop -> đóng phiên & giải phóng bộ nhớ khi client ngắt kết nối.

### Tích hợp API Key vào Content Resolver của `rook`
* Bổ sung header/query API Key của bạn vào HTTP client trong hệ thống tải Asset Delivery của `rook` khi resolve `rbxassetid://` / legacy URLs.
* Tận dụng cơ chế **Disk Cache** sẵn có của `rook`: asset chỉ tải 1 lần cho mọi phiên chạy sau.
* Mở HTTP endpoint `/api/assets/{asset_id}` trên Axum server:
  * Trả về ảnh (PNG/JPG/WebP/TGA convert sang PNG) và audio (OGG/MP3/WAV) trực tiếp từ disk cache (tránh CORS, ẩn hoàn toàn API Key).
  * Trả về **Mesh đã giải mã** dưới dạng binary buffer phẳng (`positions`, `normals`, `uvs`, `indices`) lấy thẳng từ bộ parser mesh của `rook`, giúp trình duyệt không phải tự giải mã định dạng `.mesh` hay CSG.

### Lớp trích xuất Snapshot & Dirty Tracking
* **Initial Scene Snapshot:** Khi client vừa kết nối WebSocket, quét toàn bộ `Workspace`, `Lighting`, `Players.LocalPlayer.PlayerGui` từ client DataModel của `rook` để gửi trạng thái ban đầu:
  * Danh sách `Part` / `MeshPart` / `SpecialMesh` (`InstanceId`, shape, `Size`, `CFrame`, `Color3`, `Transparency`, `Material`, `MeshId`, `TextureID`, `Decals`).
  * Các `Terrain` chunk mesh đã dựng sẵn ở backend (`vertices`, `normals`, `colors/materialWeights`, `indices`).
  * Cấu hình `Lighting` (`ClockTime`, `Ambient`, `OutdoorAmbient`, `Brightness`, `FogStart`, `FogEnd`, `FogColor`, `Skybox` IDs).
  * Cây `Sound` và `ScreenGui`.
* **Delta Snapshot (20Hz–30Hz):** Lưu bản ghi trạng thái ở tick trước (`HashMap<InstanceId, CachedState>`). Mỗi lần gửi snapshot, chỉ đóng gói qua `rmp-serde` (MessagePack):
  * `Created`: Các Instance mới sinh ra trong frame.
  * `UpdatedTransforms`: Danh sách `(InstanceId, Position, Quaternion)` của các Part có `CFrame` thay đổi (bỏ qua vật thể đứng yên/ngủ).
  * `UpdatedProps`: Các thay đổi về `Color`, `Transparency`, `Size`, `Material`, `Lighting`, `Terrain` chunk bị sửa, trạng thái `Sound` (`Playing`, `TimePosition`), thuộc tính UI.
  * `Destroyed`: Danh sách `InstanceId` đã bị xóa để client gỡ khỏi scene và giải phóng bộ nhớ GPU.
* **Input Injection:** Nhận gói tin từ client (`KeyDown`, `KeyUp`, `MouseMove`, `MouseDelta`, `MouseButton`, `CameraLook`, `UiClick`) và đẩy vào hàng đợi input/sự kiện của `rook-client`.

---

## Thiết kế Đồ họa Three.js ("Vừa đủ giống Roblox")

### Hệ màu & Ánh sáng (Khắc phục lỗi thô cứng và bóng đổ xấu)
* **Không gian màu chuẩn:**
  * Bật `renderer.outputColorSpace = THREE.SRGBColorSpace`.
  * Sử dụng `THREE.ACESFilmicToneMapping` (exposure ~ `1.0`) hoặc `AgXToneMapping` để vùng sáng (đặc biệt vật liệu Neon/trắng) không bị cháy bệt.
  * Chuyển mọi `Color3` nhận từ `rook` bằng `.setRGB(r, g, b, THREE.SRGBColorSpace)` để tránh lệch tông màu.
* **Ánh sáng 2 lớp (Mô phỏng chuẩn `Lighting` của Roblox):**
  * **Ánh sáng môi trường:** Kết hợp `THREE.HemisphereLight` (map từ `Lighting.OutdoorAmbient` cho bầu trời và `Lighting.Ambient` cho mặt đất) + Environment Map nhẹ tạo từ Skybox (`PMREMGenerator`) giúp mặt khuất sáng của khối không bị đen kịt thô cứng.
  * **Ánh sáng mặt trời & Bóng đổ bám Camera (`CSM`):**
    * Dùng `DirectionalLight` tính góc chiếu từ `ClockTime` & `GeographicLatitude`.
    * Sử dụng **`Cascaded Shadow Maps (CSM)`** (`three/examples/jsm/csm/CSM.js`, chia 3 tầng cascade, resolution `1024`–`2048`) hoặc shadow frustum di chuyển bám theo vị trí Camera/Nhân vật (`PCFSoftShadowMap`).
    * Tinh chỉnh `shadow.bias` và `shadow.normalBias` để bóng nhân vật và công trình ở gần sắc nét, không bị răng cưa thô và không bị sọc đen (shadow acne).
* **Không gian & Bầu trời:**
  * Map `Lighting.FogStart`, `FogEnd`, `FogColor` vào `THREE.Fog`.
  * Dùng Skybox 6 mặt (tải từ cache hoặc fallback sky dome gradient theo `ClockTime`) làm background scene.

### Vật liệu & Bề mặt (`Material` vừa đủ đẹp, không nặng)
* Dùng `THREE.MeshStandardMaterial` làm chuẩn chung (tránh `MeshBasicMaterial` phẳng lì).
* Tạo một bảng **Material Presets (~12–15 vật liệu phổ biến nhất)** với bộ texture tile nhẹ (`256x256` hoặc `512x512` diffuse + normal/roughness):
  * `SmoothPlastic`: `roughness: 0.45`, `metalness: 0.0`, không vân.
  * `Plastic` / `Studs`: vân nhựa nhẹ / họa tiết nút ghép đặc trưng Roblox.
  * `Wood` / `WoodPlanks`, `Concrete`, `Slate`, `Brick`, `Grass`, `Fabric`, `Sand`: dùng texture tile + normal map cường độ vừa phải.
  * `Metal` / `CorrodedMetal` / `Foil`: `metalness: 0.75–0.9`, `roughness: 0.25–0.45`.
  * `Glass`: `transparent: true`, `roughness: 0.1`, lấy nhẹ phản chiếu từ Environment Map Skybox.
  * `Neon`: `emissive` bằng màu Part, `emissiveIntensity` vừa phải, kết hợp `UnrealBloomPass` đặt `threshold` cao (`~0.85`) để chỉ `Neon` phát sáng nhẹ mà không làm nhòe toàn màn hình.
* **Box/Triplanar UV Scaling (Chống méo vân khi kéo giãn Part):** Với các Part dùng texture vật liệu Roblox (`Brick`, `Wood`, `Studs`...), scale UV tỷ lệ theo `Size` thực tế của Part để gạch/vân gỗ không bị kéo dài dị dạng.
* **`SurfaceAppearance`:** Nếu MeshPart có gắn PBR maps (`ColorMap`, `NormalMap`, `RoughnessMap`, `MetalnessMap`), tạo material riêng nạp các texture tương ứng từ `/api/assets/{id}`.
* **`Decal` & `Texture`:** Render bằng một quad mỏng bám sát mặt `NormalId` tương ứng, bật `polygonOffset` (`polygonOffsetFactor: -1`) để tránh nhấp nháy z-fighting.

### Tối ưu Render & Hiệu năng Trình duyệt
* **GPU Instancing (`THREE.InstancedMesh`):** Gom toàn bộ các Part có cùng `(Shape cơ bản, MaterialPreset)` vào chung `InstancedMesh` (hỗ trợ per-instance color và `CFrame` matrix), đảm bảo render hàng chục nghìn Part với rất ít Draw Calls.
* **Xử lý Part bán trong suốt (`Transparency > 0`):** Tách riêng sang nhóm render transparent để không phá vỡ depth-sorting của nhóm Part đục.
* **Nội suy chuyển động (Interpolation):** Client giữ buffer 2 snapshot gần nhất và `lerp`/`slerp` cho Part chuyển động + nhân vật để đạt 60–144 FPS mượt mà dù server stream ở 20–30Hz.
* **Dọn dẹp bộ nhớ GPU:** Tự động gọi `.dispose()` cho `BufferGeometry`, `Material`, `Texture` khi nhận sự kiện `Destroyed` từ server.

### Terrain & UI Overlay
* **Terrain:** Nhận trực tiếp lưới tam giác từng chunk từ `rook` (đã dựng sẵn từ `SmoothGrid`). Sử dụng `MeshStandardMaterial` với `vertexColors: true` (hoặc shader triplanar đơn giản pha 3 lớp màu/texture chính); phần nước (`Water`) dùng mặt phẳng bán trong suốt với normal map sóng cuộn UV nhẹ.
* **UI (`ScreenGui` -> HTML/CSS):**
  * Không vẽ chữ/UI bằng Three.js.
  * Tạo một `<div id="roblox-ui-root">` phủ trên Canvas (`pointer-events: none` ở root, `pointer-events: auto` ở các `TextButton`/`ImageButton`/`TextBox`).
  * Ánh xạ `Frame`, `TextLabel`, `TextButton`, `ImageLabel`, `ScrollingFrame`, `UICorner`, `UIStroke`, `UIListLayout` sang thẻ HTML + CSS Flexbox/Absolute (`UDim2` -> `calc(scale% + offsetpx)`).

---

## Lộ trình Triển khai theo Giai đoạn

### Giai đoạn 1: Khung Bridge Headless & Static Scene trên Three.js
* Tạo crate/app mới `apps/rook-web-server` trong workspace của `rook`.
* Patch Content Resolver của `rook` để dùng API Key tải asset và mở HTTP endpoint `/api/assets/{id}` phục vụ texture & mesh buffer đã giải mã.
* Viết bộ trích xuất **Initial Snapshot** cho `Part`, `MeshPart`, `Decal`, `Lighting`, `Terrain` chunks.
* Dựng `web-client` Three.js với `InstancedMesh`, ánh sáng 2 lớp (`HemisphereLight` + `DirectionalLight` CSM), Material Presets cơ bản và camera bay tự do kiểm tra độ chuẩn xác của map.

### Giai đoạn 2: Vòng lặp Runtime, Delta Snapshot & Điều khiển Nhân vật
* Bỏ phụ thuộc cửa sổ `winit`/`wgpu` trong `rook-web-server`, nối vòng lặp headless của `rook-client` với ticker Axum.
* Triển khai **Dirty Tracking** và giao thức WebSocket binary (MessagePack) cho `Created` / `UpdatedTransforms` / `UpdatedProps` / `Destroyed`.
* Triển khai Input Bridge (gửi `WASD`, `Space`, chuột, camera góc nhìn thứ 3 từ trình duyệt vào `rook-client`) và nội suy `lerp`/`slerp` phía Three.js.
* Kiểm thử chạy game thật (Obby / map có script di chuyển, `Touched`, respawn).

### Giai đoạn 3: Hoàn thiện Đồ họa Vừa đủ & Âm thanh
* Tinh chỉnh shader/material cho `Neon` (`UnrealBloomPass` ngưỡng cao), `Glass`, Skybox, `Fog`, `SurfaceAppearance` (PBR) và Box/Triplanar UV scaling cho vật liệu Roblox.
* Nối luồng đồng bộ `Sound` / `SoundService` sang Web Audio API (`PositionalAudio` cho âm thanh 3D).
* Hoàn thiện cơ chế `.dispose()` giải phóng bộ nhớ GPU khi object bị hủy.

### Giai đoạn 4: Hệ thống UI (`ScreenGui` -> HTML/CSS) & Tương tác
* Đọc cây `PlayerGui` / `StarterGui` từ `rook` (kết hợp tiến độ M8 GUI của `rook` hoặc đọc trực tiếp property DOM của `GuiObject`).
* Xây dựng bộ render HTML/CSS Overlay hỗ trợ `AnchorPoint`, `UDim2`, `ZIndex`, `UICorner`, `UIListLayout`, `TextLabel`, `TextButton`, `ImageLabel`.
* Nối luồng sự kiện UI từ trình duyệt (`MouseButton1Click`, `Hover`, `FocusLost`) ngược vào `rook-client` để kích hoạt các `LocalScript` & `RemoteEvent`.

### Giai đoạn 5: Tối ưu Băng thông & Đóng gói Sản phẩm
* Tối ưu kích thước gói Delta (quantization quaternion 16-bit/float32, gom batch thay đổi theo tick).
* Tích hợp màn hình Loading Asset (preload danh sách Mesh/Texture trước khi mở viewport) và HUD Debug (hiển thị FPS, Ping, số Draw Calls, log console `print`/`warn` từ Luau).
* Hỗ trợ quản lý nhiều phiên preview độc lập trên server (chọn file `.rbxl` -> khởi tạo session -> chơi trên trình duyệt).

---

## Tiêu chuẩn Nghiệm thu Đồ họa & Trải nghiệm

| Hạng mục | Tiêu chuẩn đạt |
| :--- | :--- |
| **Ánh sáng & Bóng đổ** | Bóng nhân vật và công trình gần camera sắc nét (không răng cưa nặng, không shadow acne); mặt khuất sáng vẫn giữ được màu vật thể rõ ràng nhờ ambient/hemisphere light. |
| **Chất liệu** | Phân biệt trực quan được các nhóm vật liệu chính (`SmoothPlastic`, `Studs`, `Wood`, `Metal`, `Glass`, `Neon` phát sáng nhẹ); texture không bị kéo méo khi Part dài/rộng khác nhau. |
| **Hiệu năng** | Map cỡ trung bình (20.000–50.000 Parts) duy trì mượt mà trên trình duyệt nhờ `InstancedMesh` và không bị rò rỉ VRAM khi script liên tục spawn/destroy Part. |
| **Gameplay & UI** | Chạy được script Server/Client từ `rook`, điều khiển nhân vật không giật khựng, âm thanh phát đúng vị trí và tương tác được với giao diện `ScreenGui`. |
