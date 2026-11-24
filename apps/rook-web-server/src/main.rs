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
mod gui;
mod protocol;
mod session;
mod snapshot;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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

use crate::protocol::{ClientMessage, ServerMessage};
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
    };

    let index = web_root.join("index.html");
    let files = ServeDir::new(&web_root).fallback(ServeFile::new(index));
    let app = Router::new()
        .route("/api/mesh/{hash}", get(mesh))
        .route("/api/image/{hash}", get(image))
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
                    Ok(message) => handle(message, &state),
                    Err(error) => eprintln!("bad client message: {error}"),
                },
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(message) => handle(message, &state),
                    Err(error) => eprintln!("bad client message: {error}"),
                },
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
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
        ClientMessage::Ping { .. } => return,
    };
    let _ = state.commands.send(command);
}
