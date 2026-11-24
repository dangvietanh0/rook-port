//! The headless session: one `Game`, stepped at Rook's 60 Hz, its scene
//! read into the browser's snapshots, and the browser's input fed back in.
//!
//! The session owns every Rook type (they are not `Send`); the web server
//! talks to it through a command channel and a broadcast of already
//! serialized frames, so the async side never touches a `DataModel`.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use glam::Vec3;
use rook_client::{Game, Setup};
use rook_content::Resolver;
use rook_engine::{CameraView, InputEvent};
use rook_render::DrawShape;
use rook_scene::SceneCache;
use rustc_hash::{FxHashMap, FxHashSet};
use tokio::sync::broadcast;

use crate::assets::{self, ImageStore, MeshStore};
use crate::protocol::{
    CameraSnapshot, GuiNode, PartSnapshot, ServerMessage, SessionStats, Snapshot, Welcome,
};
use crate::snapshot;

/// Rook's simulation step, 60 Hz as Roblox's scheduler runs.
pub(crate) const STEP: Duration = Duration::from_nanos(16_666_667);
/// How often the browser is sent a snapshot. Transforms are interpolated
/// there, so 20 Hz looks smooth and costs a third of 60 Hz.
pub(crate) const SNAPSHOT: Duration = Duration::from_millis(50);

/// What the async side asks the session to do.
#[derive(Debug)]
pub(crate) enum Command {
    Input(InputEvent),
    Resize {
        width: u32,
        height: u32,
    },
    /// Where the browser's own camera is, while no script drives the
    /// camera: terrain and content load around it.
    Camera {
        position: [f32; 3],
    },
    /// A browser joined: flush the pending delta and hand back the whole
    /// scene as it is now. A welcome serialized at startup would be stale
    /// for a player who joins later.
    Welcome(tokio::sync::oneshot::Sender<anyhow::Result<Vec<u8>>>),
}

/// What the HTTP handlers and the WebSocket handshake read. The session
/// thread owns the writes; the lock is only held while inserting a newly
/// loaded asset or reading the welcome.
#[derive(Debug, Default)]
pub(crate) struct Shared {
    /// The welcome frame, already serialized: a new connection sends it
    /// without building or copying the whole scene.
    pub(crate) welcome: Option<Arc<[u8]>>,
    pub(crate) meshes: MeshStore,
    pub(crate) images: ImageStore,
}

/// A stable key for one drawn entry: an instance and its layer (0 the
/// part, then its Decals and Textures), or a scene part that belongs to no
/// instance (terrain and grass chunks).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum EntryKey {
    Instance {
        id: u64,
        layer: u32,
    },
    /// The scene index. Terrain chunks get new meshes as the player moves,
    /// so their identities don't need to outlive the entries.
    Part(usize),
}

/// The browser's id for an entry. JavaScript numbers hold 53 bits exactly,
/// which an `InstanceId`'s raw 64 don't, so the wire ids are assigned
/// every 1, 2, 3… and mapped back here.
#[derive(Debug, Default)]
struct NetIds {
    next: u64,
    by_key: FxHashMap<EntryKey, u64>,
    by_id: FxHashMap<u64, EntryKey>,
}

impl NetIds {
    fn id(&mut self, key: EntryKey) -> u64 {
        if let Some(&id) = self.by_key.get(&key) {
            return id;
        }
        self.next += 1;
        let id = self.next;
        self.by_key.insert(key, id);
        self.by_id.insert(id, key);
        id
    }

    fn remove(&mut self, key: EntryKey) -> Option<u64> {
        let id = self.by_key.remove(&key)?;
        self.by_id.remove(&id);
        Some(id)
    }

    fn key(&self, id: u64) -> Option<EntryKey> {
        self.by_id.get(&id).copied()
    }
}

/// A scene entry as the session reads it out of the cache.
#[derive(Debug, Clone, Copy)]
struct Entry {
    key: EntryKey,
    layer: u32,
    parent: Option<EntryKey>,
    part: rook_render::PartInstance,
}

/// Start the session thread and hand back once the place has loaded and
/// the first welcome is ready. The `ready` channel receives the error if
/// anything fails, so the server can exit with it rather than hang.
pub(crate) fn spawn(
    place: PathBuf,
    play: bool,
    content: Arc<Resolver>,
    shared: Arc<Mutex<Shared>>,
    frames: broadcast::Sender<Vec<u8>>,
    commands: Receiver<Command>,
    ready: Sender<anyhow::Result<()>>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("rook-session".to_owned())
        .spawn(move || {
            let result = run(&place, play, &content, &shared, &frames, &commands, &ready);
            if let Err(error) = &result {
                let message = format!("{error:#}");
                eprintln!("session failed: {message}");
                let mut shared = shared.lock().expect("session shared");
                shared.welcome = None;
            }
        })
        .expect("spawn the session thread")
}

fn run(
    place: &Path,
    play: bool,
    content: &Arc<Resolver>,
    shared: &Arc<Mutex<Shared>>,
    frames: &broadcast::Sender<Vec<u8>>,
    commands: &Receiver<Command>,
    ready: &Sender<anyhow::Result<()>>,
) -> anyhow::Result<()> {
    let setup = Setup {
        play,
        content: content.clone(),
        script: None,
        client_script: None,
        wait_for_sounds: false,
        core_scripts: None,
        user_settings: None,
    };
    let mut game = match Game::load(place, &setup) {
        Ok(game) => game,
        Err(error) => {
            let _ = ready.send(Err(error));
            return Ok(());
        }
    };
    // The server thread paces itself at 60 Hz, as Play mode does in the
    // window; `advance` then only drains what it sent.
    game.free_run();
    game.set_viewport(1280, 720);
    let saved_camera = game.saved_camera();

    let mut session = Session::new(game, saved_camera, content, shared, frames);
    if let Err(error) = session.prime() {
        let _ = ready.send(Err(error));
        return Ok(());
    }
    // The HTTP server waits for this before it binds, so the first browser
    // already has the whole scene.
    let _ = ready.send(Ok(()));
    session.run(commands)
}

struct Session<'a> {
    game: Game,
    cache: SceneCache,
    saved_camera: rook_render::Camera,
    /// Where the browser's free camera is, for loading the nearest content
    /// first.
    client_camera: Vec3,
    shared: &'a Arc<Mutex<Shared>>,
    frames: &'a broadcast::Sender<Vec<u8>>,

    net_ids: NetIds,
    /// The last snapshot sent for each drawn entry, to make the next one a
    /// delta.
    previous: FxHashMap<EntryKey, PartSnapshot>,
    tick: u64,
    /// Assets loaded since the last snapshot, for the browser to fetch.
    new_meshes: Vec<String>,
    new_images: Vec<String>,
    /// Hashes in `Shared` already: `scene.meshes` may hold hundreds, and
    /// only new ones need the lock.
    mesh_seen: FxHashSet<[u8; 32]>,
    image_seen: FxHashSet<[u8; 32]>,
    /// The GUI generation last sent, so an unchanged screen costs nothing.
    gui_generation: Option<u64>,
}

impl<'a> Session<'a> {
    fn new(
        mut game: Game,
        saved_camera: rook_render::Camera,
        content: &Arc<Resolver>,
        shared: &'a Arc<Mutex<Shared>>,
        frames: &'a broadcast::Sender<Vec<u8>>,
    ) -> Self {
        let focus = saved_camera.position;
        let cache = SceneCache::for_data_model(game.view_mut(), content, focus);
        Self {
            game,
            cache,
            saved_camera,
            client_camera: focus,
            shared,
            frames,
            net_ids: NetIds::default(),
            previous: FxHashMap::default(),
            tick: 0,
            new_meshes: Vec::new(),
            new_images: Vec::new(),
            mesh_seen: FxHashSet::default(),
            image_seen: FxHashSet::default(),
            gui_generation: None,
        }
    }

    /// The scene as it is now, then the welcome: every part and every
    /// asset loaded so far, so the browser can draw the place without
    /// waiting for a delta.
    fn prime(&mut self) -> anyhow::Result<()> {
        let focus = self.client_camera;
        let mut to_render = self.cache.update(self.game.view_mut(), focus);
        self.take_images(&mut to_render);
        self.sync_meshes();
        let welcome = self.welcome();
        let bytes = rmp_serde::to_vec_named(&ServerMessage::Welcome { welcome })?;
        let mut shared = self.shared.lock().expect("session shared");
        shared.welcome = Some(Arc::from(bytes));
        Ok(())
    }

    fn run(mut self, commands: &Receiver<Command>) -> anyhow::Result<()> {
        let mut last = Instant::now();
        let mut next_snapshot = Instant::now() + SNAPSHOT;
        loop {
            let frame_start = Instant::now();
            // Commands first: input reaches the client before the step
            // that reads it.
            loop {
                match commands.try_recv() {
                    Ok(command) => self.command(command),
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => return Ok(()),
                }
            }

            let dt = (frame_start - last).as_secs_f64().min(0.1);
            last = frame_start;
            self.game.advance(dt);
            self.step_scene();

            if frame_start >= next_snapshot {
                self.send_snapshot();
                next_snapshot = frame_start + SNAPSHOT;
            }

            let elapsed = frame_start.elapsed();
            if elapsed < STEP {
                let wait = STEP - elapsed;
                match commands.recv_timeout(wait) {
                    Ok(command) => self.command(command),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return Ok(()),
                }
            }
        }
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Input(event) => self.game.input(event),
            Command::Resize { width, height } => self.game.set_viewport(width, height),
            Command::Camera { position } => {
                self.client_camera = Vec3::from_array(position);
            }
            Command::Welcome(reply) => {
                // First bring every other browser up to date, so replacing
                // the delta baseline below loses nothing.
                self.send_snapshot();
                let _ = reply.send(self.welcome_bytes());
            }
        }
    }

    /// Bring the scene up to date with the step and the files that arrived
    /// since the last frame.
    fn step_scene(&mut self) {
        let focus = self
            .scripted_camera()
            .map_or(self.client_camera, |v| v.cframe.position);
        let mut to_render = self.cache.update(self.game.view_mut(), focus);
        self.take_images(&mut to_render);
        for hash in to_render.take_dropped_meshes() {
            let shared = Arc::clone(self.shared);
            shared
                .lock()
                .expect("session shared")
                .meshes
                .remove(&hash.0);
            self.mesh_seen.remove(&hash.0);
        }
        self.sync_meshes();
    }

    /// Keep the shared store in step with the meshes the scene holds. Only
    /// new hashes take the lock; the common frame only scans.
    fn sync_meshes(&mut self) {
        let mut fresh = Vec::new();
        for (hash, mesh) in &self.cache.scene.meshes {
            if self.mesh_seen.insert(hash.0) {
                fresh.push((hash.0, mesh.clone()));
            }
        }
        if fresh.is_empty() {
            return;
        }
        {
            let mut shared = self.shared.lock().expect("session shared");
            for (hash, mesh) in &fresh {
                shared.meshes.insert(*hash, mesh.clone());
            }
        }
        for (hash, _) in fresh {
            let name = assets::hex(&hash);
            self.new_meshes.push(name);
        }
    }

    /// Take the images that finished loading this frame, encode them once
    /// for the browser, and remember the hashes the next snapshot
    /// announces.
    fn take_images(&mut self, to_render: &mut rook_scene::ToRender) {
        let images = to_render.take_images();
        if images.is_empty() {
            return;
        }
        let mut fresh = Vec::new();
        {
            let shared = Arc::clone(self.shared);
            let mut shared = shared.lock().expect("session shared");
            for (hash, image) in images {
                let png = match assets::image_png(&image) {
                    Ok(png) => Arc::<[u8]>::from(png),
                    Err(error) => {
                        eprintln!("couldn't encode image {}: {error}", assets::hex(&hash.0));
                        continue;
                    }
                };
                shared.images.insert(hash.0, image);
                shared.images.put_png(hash.0, png);
                fresh.push((hash.0, assets::hex(&hash.0)));
            }
        }
        for (hash, name) in fresh {
            self.image_seen.insert(hash);
            self.new_images.push(name);
        }
    }

    fn scripted_camera(&self) -> Option<CameraView> {
        self.game.view().scripted_camera()
    }

    /// The local player's ScreenGuis as HTML nodes, and the generation they
    /// are at.
    fn gui_tree(&self) -> (u64, Vec<GuiNode>) {
        let mut world = self.game.view().runtime().world_mut();
        let world = &mut *world;
        let nodes = crate::gui::tree(&mut world.dom, &mut world.gui);
        (world.gui.generation(), nodes)
    }

    /// The GUI tree when it changed since the last snapshot.
    fn gui_if_changed(&mut self) -> Option<Vec<GuiNode>> {
        let generation = self.game.view().runtime().world().gui.generation();
        if self.gui_generation == Some(generation) {
            return None;
        }
        let (generation, tree) = self.gui_tree();
        self.gui_generation = Some(generation);
        Some(tree)
    }

    fn camera_snapshot(&self) -> CameraSnapshot {
        match self.scripted_camera() {
            Some(view) => snapshot::camera_view_snapshot(&view),
            None => snapshot::camera_snapshot(&self.saved_camera, false),
        }
    }

    /// The whole scene, for the startup welcome, which also becomes the
    /// delta baseline.
    fn welcome(&mut self) -> Welcome {
        let welcome = self.welcome_contents();
        for part in &welcome.parts {
            if let Some(key) = self.net_ids.key(part.id) {
                self.previous.insert(key, part.clone());
            }
        }
        welcome
    }

    /// The whole scene, without touching the delta baseline.
    fn welcome_contents(&mut self) -> Welcome {
        let mut parts = Vec::new();
        for entry in self.entries() {
            parts.push(self.snapshot_of(entry));
        }
        let part_count = parts.len();
        let (generation, gui) = self.gui_tree();
        self.gui_generation = Some(generation);
        let (mesh_count, image_count) = {
            let shared = self.shared.lock().expect("session shared");
            (shared.meshes.count(), shared.images.count())
        };
        Welcome {
            place: self.game.name().to_owned(),
            tick: self.tick,
            parts,
            meshes: self.all_hashes_meshes(),
            images: self.all_hashes_images(),
            lighting: snapshot::lighting_snapshot(&self.cache.scene.lighting),
            camera: self.camera_snapshot(),
            gui,
            stats: SessionStats {
                parts: part_count,
                meshes: mesh_count,
                images: image_count,
                server_tick: self.tick,
                simulated_seconds: self.game.view().now(),
            },
        }
    }

    /// A fresh welcome for one browser, serialized. The baseline moves to
    /// this scene so the next delta is exactly the changes since it.
    fn welcome_bytes(&mut self) -> anyhow::Result<Vec<u8>> {
        let welcome = self.welcome_contents();
        self.previous.clear();
        for part in &welcome.parts {
            if let Some(key) = self.net_ids.key(part.id) {
                self.previous.insert(key, part.clone());
            }
        }
        let bytes = rmp_serde::to_vec_named(&ServerMessage::Welcome { welcome })?;
        Ok(bytes)
    }

    fn all_hashes_meshes(&self) -> Vec<String> {
        let shared = self.shared.lock().expect("session shared");
        shared.meshes.hashes()
    }

    fn all_hashes_images(&self) -> Vec<String> {
        let shared = self.shared.lock().expect("session shared");
        shared.images.hashes()
    }

    /// Every drawn entry, including terrain parts that belong to no
    /// instance. Entries whose mesh file hasn't arrived are left out: the
    /// next snapshot adds them with their mesh, so the browser never tries
    /// to draw a part it has no geometry for.
    fn entries(&self) -> Vec<Entry> {
        let parts = &self.cache.scene.parts;
        let mut owned = FxHashSet::default();
        let mut entries = Vec::new();
        for drawn in self.cache.drawn_entries() {
            owned.insert(drawn.index);
            if matches!(drawn.part.shape, DrawShape::Adorn(_)) {
                continue;
            }
            if let DrawShape::File(hash) = drawn.part.shape
                && !self.mesh_seen.contains(&hash.0)
            {
                continue;
            }
            let base = EntryKey::Instance {
                id: drawn.id.to_ref().0,
                layer: 0,
            };
            let key = EntryKey::Instance {
                id: drawn.id.to_ref().0,
                layer: drawn.layer,
            };
            entries.push(Entry {
                key,
                layer: drawn.layer,
                parent: (drawn.layer > 0).then_some(base),
                part: *drawn.part,
            });
        }
        // Terrain and grass: scene parts no instance owns. Released slots
        // are transparent and stay out.
        for (index, part) in parts.iter().enumerate() {
            if owned.contains(&index) || part.transparency >= 1.0 {
                continue;
            }
            if let DrawShape::File(hash) = part.shape
                && !self.mesh_seen.contains(&hash.0)
            {
                continue;
            }
            entries.push(Entry {
                key: EntryKey::Part(index),
                layer: 0,
                parent: None,
                part: *part,
            });
        }
        entries
    }

    fn snapshot_of(&mut self, entry: Entry) -> PartSnapshot {
        let id = self.net_ids.id(entry.key);
        let parent = entry.parent.map(|parent| self.net_ids.id(parent));
        snapshot::part_snapshot(id, parent, entry.layer, &entry.part)
    }

    fn send_snapshot(&mut self) {
        let entries = self.entries();
        let current: FxHashSet<EntryKey> = entries.iter().map(|e| e.key).collect();
        let mut destroyed = Vec::new();
        let stale: Vec<EntryKey> = self
            .previous
            .keys()
            .copied()
            .filter(|key| !current.contains(key))
            .collect();
        for key in stale {
            self.previous.remove(&key);
            if let Some(id) = self.net_ids.remove(key) {
                destroyed.push(id);
            }
        }

        let mut created = Vec::new();
        let mut updated_props = Vec::new();
        let mut updated_transforms = Vec::new();
        for entry in entries {
            let snap = self.snapshot_of(entry);
            match self.previous.get(&entry.key) {
                None => created.push(snap.clone()),
                Some(old) if *old != snap => {
                    if let Some(transform) = transform_only(old, &snap) {
                        updated_transforms.push(transform);
                    } else {
                        updated_props.push(snap.clone());
                    }
                }
                Some(_) => {}
            }
            self.previous.insert(entry.key, snap);
        }

        let (mesh_count, image_count) = {
            let shared = self.shared.lock().expect("session shared");
            (shared.meshes.count(), shared.images.count())
        };
        let stats = SessionStats {
            parts: self.previous.len(),
            meshes: mesh_count,
            images: image_count,
            server_tick: self.tick,
            simulated_seconds: self.game.view().now(),
        };
        let gui = self.gui_if_changed();
        let snapshot = Snapshot {
            tick: self.tick,
            time: self.game.view().now(),
            created,
            updated_props,
            updated_transforms,
            destroyed,
            meshes: std::mem::take(&mut self.new_meshes),
            images: std::mem::take(&mut self.new_images),
            lighting: Some(snapshot::lighting_snapshot(&self.cache.scene.lighting)),
            camera: Some(self.camera_snapshot()),
            gui,
            stats,
        };
        self.tick += 1;
        match rmp_serde::to_vec_named(&ServerMessage::Snapshot { snapshot }) {
            Ok(bytes) => {
                let _ = self.frames.send(bytes);
            }
            Err(error) => eprintln!("couldn't encode a snapshot: {error}"),
        }
    }
}

/// Whether two looks differ only in where the part is, so the next
/// snapshot can send three numbers and a quaternion instead of the whole
/// part.
fn transform_only(
    old: &PartSnapshot,
    new: &PartSnapshot,
) -> Option<crate::protocol::TransformUpdate> {
    let same = old.shape == new.shape
        && old.mesh == new.mesh
        && old.color == new.color
        && old.transparency == new.transparency
        && old.material == new.material
        && old.reflectance == new.reflectance
        && old.cast_shadow == new.cast_shadow
        && old.double_sided == new.double_sided
        && old.vertex_colors == new.vertex_colors
        && old.light == new.light
        && old.on_top == new.on_top
        && old.over == new.over
        && old.texture == new.texture
        && old.maps == new.maps
        && old.image == new.image
        && old.surfaces == new.surfaces
        && old.parent == new.parent
        && old.layer == new.layer;
    if !same {
        return None;
    }
    if old.position == new.position && old.rotation == new.rotation && old.size == new.size {
        return None;
    }
    Some(crate::protocol::TransformUpdate {
        id: new.id,
        position: new.position,
        rotation: new.rotation,
        size: (old.size != new.size).then_some(new.size),
    })
}
