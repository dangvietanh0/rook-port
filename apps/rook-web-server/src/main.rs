//! `rook-web-server`: run a Roblox place headlessly and stream it to a
//! browser.
//!
//! The place runs in a Rook play session on its own thread, at Rook's
//! 60 Hz, with the browser's input fed back in. A WebSocket carries the
//! scene as MessagePack snapshots (a welcome with everything, then deltas);
//! meshes and images are fetched over HTTP by content hash and cached by
//! the browser. The same server serves the built web client.
//!
//! ```text
//! rook-web-server place.rbxl --addr 127.0.0.1:8080 --web-root web-client/dist
//! ```

mod assets;
mod avatar;
mod gui;
mod protocol;
mod session;
mod snapshot;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use rook_content::Resolver;
use rook_engine::InputEvent;
use rook_engine::settings;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::protocol::{AvatarModelInfo, AvatarStatus, ClientMessage, ServerMessage};
use crate::session::{Command, Shared};

#[derive(Debug, Parser)]
#[command(
    name = "rook-web-server",
    version,
    about = "Stream a Rook place to a browser"
)]
struct Args {
    /// Place file (.rbxl, .rbxlx, .rbxm or .rbxmx).
    place: PathBuf,
    /// Address the HTTP server listens on.
    #[arg(long, default_value = "127.0.0.1:8080")]
    addr: SocketAddr,
    /// The built web client to serve.
    #[arg(long, default_value = "web-client/dist")]
    web_root: PathBuf,
    /// Load the place without a player (Studio's Run mode).
    #[arg(long)]
    run: bool,
    /// Don't fetch assets from Roblox's delivery service; use only the
    /// local cache and folders.
    #[arg(long)]
    offline: bool,
}

#[derive(Clone)]
struct AppState {
    shared: Arc<Mutex<Shared>>,
    frames: broadcast::Sender<Vec<u8>>,
    commands: std::sync::mpsc::Sender<Command>,
    /// The newest avatar request: an older lookup that finishes late must
    /// not replace a newer choice.
    avatar_generation: Arc<AtomicU64>,
    /// The 3D avatar meshes already fetched, served to the browser.
    models: Arc<avatar::ModelCache>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let content = Arc::new(Resolver::new(settings::content_config(!args.offline)));

    let shared = Arc::new(Mutex::new(Shared::default()));
    let (frames, _) = broadcast::channel(64);
    let (commands, command_rx) = std::sync::mpsc::channel();
    let (ready, ready_rx) = std::sync::mpsc::channel();

    let web_root = std::fs::canonicalize(&args.web_root).unwrap_or_else(|_| args.web_root.clone());
    let _session = session::spawn(
        args.place.clone(),
        !args.run,
        content,
        shared.clone(),
        frames.clone(),
        command_rx,
        ready,
    );

    // Wait for the place to load before accepting connections: the first
    // message a browser gets is the whole scene.
    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(error),
        Err(_) => anyhow::bail!("the session thread stopped before the place loaded"),
    }

    let state = AppState {
        shared,
        frames,
        commands,
        avatar_generation: Arc::new(AtomicU64::new(0)),
        models: Arc::new(avatar::ModelCache::default()),
    };

    let index = web_root.join("index.html");
    let files = ServeDir::new(&web_root).fallback(ServeFile::new(index));
    let app = Router::new()
        .route("/api/mesh/{hash}", get(mesh))
        .route("/api/image/{hash}", get(image))
        .route("/api/avatar-model/{user_id}/{file}", get(avatar_model))
        .route("/api/animations", get(animations))
        .route("/api/health", get(health))
        .route("/ws", get(websocket))
        .fallback_service(files)
        .layer(CorsLayer::permissive())
        .with_state(state);

    println!(
        "rook-web-server: {} on http://{}",
        args.place.display(),
        args.addr
    );
    let listener = tokio::net::TcpListener::bind(args.addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn parse_hash(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

async fn mesh(State(state): State<AppState>, Path(hash): Path<String>) -> Response {
    let Some(hash) = parse_hash(&hash) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let mesh = {
        let shared = state.shared.lock().expect("session shared");
        shared.meshes.get(&hash)
    };
    let Some(mesh) = mesh else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let blob = assets::mesh_blob(&mesh);
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        blob,
    )
        .into_response()
}

async fn image(State(state): State<AppState>, Path(hash): Path<String>) -> Response {
    let Some(hash) = parse_hash(&hash) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let png = {
        let shared = state.shared.lock().expect("session shared");
        shared.images.png(&hash)
    };
    let Some(png) = png else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        png.to_vec(),
    )
        .into_response()
}

/// Roblox's own 3D avatar mesh: the OBJ, its MTL and the PNGs the MTL
/// names. The browser binds the groups to the R6 joints.
async fn avatar_model(
    State(state): State<AppState>,
    Path((user_id, file)): Path<(i64, String)>,
) -> Response {
    let model = {
        let models = state.models.lock().expect("avatar models");
        models.get(&user_id).cloned()
    };
    let Some(model) = model else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (content_type, body) = if file == "obj" {
        ("text/plain; charset=utf-8", model.obj.as_bytes().to_vec())
    } else if file == "mtl" {
        ("text/plain; charset=utf-8", model.mtl.as_bytes().to_vec())
    } else if let Some((_, png)) = model.textures.iter().find(|(name, _)| name == &file) {
        ("image/png", png.to_vec())
    } else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        body,
    )
        .into_response()
}

async fn animations() -> Response {
    let clips = tokio::task::spawn_blocking(avatar::animations)
        .await
        .unwrap_or_else(|_| Arc::new(Vec::new()));
    match serde_json::to_vec(&*clips) {
        Ok(body) => (
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, "public, max-age=3600"),
            ],
            body,
        )
            .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn health(State(state): State<AppState>) -> Response {
    let (ready, meshes, images) = {
        let shared = state.shared.lock().expect("session shared");
        (
            shared.welcome.is_some(),
            shared.meshes.count(),
            shared.images.count(),
        )
    };
    let body = serde_json::json!({
        "ready": ready,
        "meshes": meshes,
        "images": images,
        "subscribers": state.frames.receiver_count(),
    });
    (
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

async fn websocket(State(state): State<AppState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| client(socket, state))
}

async fn client(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let ready = {
        let shared = state.shared.lock().expect("session shared");
        shared.welcome.is_some()
    };
    if !ready {
        let error = ServerMessage::Error {
            message: "the place is no longer loaded".to_owned(),
        };
        if let Ok(bytes) = rmp_serde::to_vec_named(&error) {
            let _ = sink.send(Message::Binary(bytes.into())).await;
        }
        return;
    }
    // Subscribe before asking for the whole scene, so this connection sees
    // every delta from that scene on; frames sent while the welcome is
    // built are older than it and the browser drops them by tick.
    let mut frames = state.frames.subscribe();
    let (reply, welcome) = tokio::sync::oneshot::channel();
    if state.commands.send(Command::Welcome(reply)).is_err() {
        let error = ServerMessage::Error {
            message: "the session has stopped".to_owned(),
        };
        if let Ok(bytes) = rmp_serde::to_vec_named(&error) {
            let _ = sink.send(Message::Binary(bytes.into())).await;
        }
        return;
    }
    let welcome = match welcome.await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => {
            eprintln!("couldn't build a welcome: {error:#}");
            return;
        }
        Err(_) => return,
    };
    if sink.send(Message::Binary(welcome.into())).await.is_err() {
        return;
    }
    // Avatar lookups run on blocking workers and answer here, so a slow
    // network never stalls this connection's snapshots.
    let (status, mut statuses) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    loop {
        tokio::select! {
            frame = frames.recv() => match frame {
                Ok(bytes) => {
                    if sink.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            bytes = statuses.recv() => {
                if let Some(bytes) = bytes
                    && sink.send(Message::Binary(bytes.into())).await.is_err()
                {
                    break;
                }
            }
            message = stream.next() => match message {
                Some(Ok(Message::Binary(bytes))) => match rmp_serde::from_slice::<ClientMessage>(&bytes) {
                    Ok(ClientMessage::Ping { t }) => {
                        let pong = ServerMessage::Pong { t };
                        if let Ok(bytes) = rmp_serde::to_vec_named(&pong)
                            && sink.send(Message::Binary(bytes.into())).await.is_err()
                        {
                            break;
                        }
                    }
                    Ok(ClientMessage::Avatar { username }) => {
                        let loading = ServerMessage::Avatar { avatar: AvatarStatus {
                            state: "loading".to_owned(),
                            username: username.clone(),
                            name: None,
                            message: None,
                            animations: None,
                        } };
                        if let Ok(bytes) = rmp_serde::to_vec_named(&loading)
                            && sink.send(Message::Binary(bytes.into())).await.is_err()
                        {
                            break;
                        }
                        request_avatar(username, &state, status.clone());
                    }
                    Ok(message) => handle(message, &state),
                    Err(error) => eprintln!("bad client message: {error}"),
                },
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(ClientMessage::Avatar { username }) => {
                        let loading = ServerMessage::Avatar { avatar: AvatarStatus {
                            state: "loading".to_owned(),
                            username: username.clone(),
                            name: None,
                            message: None,
                            animations: None,
                        } };
                        if let Ok(bytes) = rmp_serde::to_vec_named(&loading)
                            && sink.send(Message::Binary(bytes.into())).await.is_err()
                        {
                            break;
                        }
                        request_avatar(username, &state, status.clone());
                    }
                    Ok(message) => handle(message, &state),
                    Err(error) => eprintln!("bad client message: {error}"),
                },
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
}

/// Resolve a username on a blocking worker, ask the session to apply it,
/// and send the panel the final state.
fn request_avatar(
    username: String,
    state: &AppState,
    status: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
) {
    let generation = state.avatar_generation.fetch_add(1, Ordering::Relaxed) + 1;
    let commands = state.commands.clone();
    let models = Arc::clone(&state.models);
    tokio::task::spawn_blocking(move || {
        let mut avatar_status = AvatarStatus {
            state: "error".to_owned(),
            username,
            name: None,
            message: None,
            animations: None,
        };
        match avatar::resolve(&avatar_status.username, &models) {
            Ok(resolved) => {
                let model = resolved.model.as_ref().map(|model| AvatarModelInfo {
                    obj: format!(
                        "/api/avatar-model/{}/obj?v={}",
                        resolved.user_id, model.version
                    ),
                    mtl: format!(
                        "/api/avatar-model/{}/mtl?v={}",
                        resolved.user_id, model.version
                    ),
                });
                let (reply, reply_rx) = std::sync::mpsc::channel();
                let sent = commands.send(Command::Avatar {
                    generation,
                    name: resolved.name.clone(),
                    user_id: resolved.user_id,
                    rig: resolved.rig.clone(),
                    avatar: Box::new(resolved.avatar),
                    shirt: resolved.shirt,
                    pants: resolved.pants,
                    model,
                    animations: Arc::clone(&resolved.animations),
                    reply,
                });
                if sent.is_err() {
                    avatar_status.message = Some("The session has stopped.".to_owned());
                } else {
                    match reply_rx.recv_timeout(Duration::from_secs(10)) {
                        Ok(Ok(())) => {
                            avatar_status.state = "ready".to_owned();
                            avatar_status.name = Some(resolved.name);
                            avatar_status.animations = Some(resolved.animations.as_ref().clone());
                        }
                        Ok(Err(message)) => avatar_status.message = Some(message),
                        Err(_) => {
                            avatar_status.message =
                                Some("The new character didn't appear.".to_owned());
                        }
                    }
                }
            }
            Err(message) => avatar_status.message = Some(message),
        }
        let message = ServerMessage::Avatar {
            avatar: avatar_status,
        };
        if let Ok(bytes) = rmp_serde::to_vec_named(&message) {
            let _ = status.send(bytes);
        }
    });
}

fn handle(message: ClientMessage, state: &AppState) {
    let command = match message {
        ClientMessage::Key { code, down } => Command::Input(InputEvent::Key { code, down }),
        ClientMessage::Text { text } => Command::Input(InputEvent::Text { text }),
        ClientMessage::MouseMove { x, y } => Command::Input(InputEvent::MouseMove { x, y }),
        ClientMessage::MouseMotion { dx, dy } => Command::Input(InputEvent::MouseMotion { dx, dy }),
        ClientMessage::MouseButton { button, down } => {
            Command::Input(InputEvent::MouseButton { button, down })
        }
        ClientMessage::Wheel { delta } => Command::Input(InputEvent::Wheel { delta }),
        ClientMessage::Focus { focused } => Command::Input(InputEvent::Focus { focused }),
        ClientMessage::Resize { width, height } => Command::Resize { width, height },
        ClientMessage::Camera { position } => Command::Camera { position },
        ClientMessage::Move { x, z } => Command::Move { x, z },
        ClientMessage::Avatar { .. } | ClientMessage::Ping { .. } => return,
    };
    let _ = state.commands.send(command);
}
