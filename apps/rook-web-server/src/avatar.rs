//! Resolving the username the player types in the in-game avatar panel:
//! the Roblox user, its body colours, and its classic Shirt/Pants images.
//!
//! Everything here blocks on the network and is called from
//! `spawn_blocking`, never from the simulation thread.

use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use flate2::read::GzDecoder;
use glam::{Mat3, Quat, Vec3};
use rook_platform::network::{Network, Request, Response, Ureq};
use rustc_hash::FxHashMap;

use crate::protocol::{AnimationClip, AnimationKey};

/// A user's look, ready to hand to the session thread.
#[derive(Debug)]
pub(crate) struct Resolved {
    pub(crate) name: String,
    pub(crate) user_id: i64,
    /// `R6` or `R15`: which joints the 3D model uses.
    pub(crate) rig: String,
    pub(crate) avatar: rook_lua::Avatar,
    /// The classic 585×559 shirt template, as PNG.
    pub(crate) shirt: Option<Arc<[u8]>>,
    /// The classic 585×559 pants template, as PNG.
    pub(crate) pants: Option<Arc<[u8]>>,
    /// The official R6 clips, sampled by the browser.
    pub(crate) animations: Arc<Vec<AnimationClip>>,
    /// Roblox's own rendered avatar mesh, so body packages and accessories
    /// look right instead of being rebuilt from boxes.
    pub(crate) model: Option<Arc<AvatarModel>>,
}

/// Roblox's 3D avatar thumbnail: the OBJ, its materials and textures. The
/// browser attaches its groups to the R6 joints, so the shape and clothing
/// are Roblox's rather than six hand-built boxes.
#[derive(Debug)]
pub(crate) struct AvatarModel {
    pub(crate) obj: Arc<str>,
    pub(crate) mtl: Arc<str>,
    /// Texture name in the MTL and its PNG bytes.
    pub(crate) textures: Vec<(String, Arc<[u8]>)>,
    /// Changes when the mesh does, so the browser doesn't reuse an old one.
    pub(crate) version: String,
}

/// The 3D models already fetched, by Roblox user id.
pub(crate) type ModelCache = Mutex<FxHashMap<i64, Arc<AvatarModel>>>;

/// Look `username` up on Roblox. `Err` is a message for the panel.
pub(crate) fn resolve(username: &str, models: &ModelCache) -> Result<Resolved, String> {
    let name = clean(username)?;
    let net = Ureq::new();
    let body = serde_json::json!({
        "usernames": [name],
        "excludeBannedUsers": true,
    });
    let answer = request(
        &net,
        "POST",
        "https://users.roblox.com/v1/usernames/users",
        Some((
            "application/json",
            serde_json::to_vec(&body).map_err(|e| e.to_string())?,
        )),
    )?;
    let json: serde_json::Value = serde_json::from_slice(&answer.body)
        .map_err(|_| "Roblox sent an unreadable answer.".to_owned())?;
    let user = json["data"]
        .as_array()
        .and_then(|users| users.first())
        .ok_or_else(|| format!("There is no Roblox user named {name}."))?;
    let user_id = user["id"]
        .as_i64()
        .ok_or_else(|| format!("There is no Roblox user named {name}."))?;
    let name = user["name"].as_str().unwrap_or(&name).to_owned();

    let answer = request(
        &net,
        "GET",
        &format!("https://avatar.roblox.com/v1/users/{user_id}/avatar"),
        None,
    )?;
    let json: serde_json::Value = serde_json::from_slice(&answer.body)
        .map_err(|_| "Roblox sent an unreadable avatar.".to_owned())?;
    let avatar = rook_lua::Avatar::from_api_json(&json);

    // The mesh is the slow part; the garments and the mesh don't need
    // each other, so fetch them at once.
    let (shirt, pants, model) = std::thread::scope(|scope| {
        let shirt = scope.spawn(|| garment(&net, &json, "Shirt", "ShirtTemplate"));
        let pants = scope.spawn(|| garment(&net, &json, "Pants", "PantsTemplate"));
        let model = scope.spawn(|| model(&net, user_id, models));
        (
            shirt.join().unwrap_or(None),
            pants.join().unwrap_or(None),
            model.join().unwrap_or(None),
        )
    });
    let rig = match avatar.rig {
        rook_lua::RigType::R6 => "R6",
        rook_lua::RigType::R15 => "R15",
    }
    .to_owned();
    Ok(Resolved {
        name,
        user_id,
        rig,
        avatar,
        shirt,
        pants,
        animations: clips(&net),
        model,
    })
}

/// Roblox's 3D avatar mesh for `user_id`, cached for later requests. The
/// public thumbnail API wants the Open Cloud key; without one, the browser
/// falls back to the standard R6 boxes.
fn model(net: &dyn Network, user_id: i64, cache: &ModelCache) -> Option<Arc<AvatarModel>> {
    if let Ok(cache) = cache.lock()
        && let Some(model) = cache.get(&user_id)
    {
        return Some(Arc::clone(model));
    }
    let model = fetch_model(net, user_id)?;
    if let Ok(mut cache) = cache.lock() {
        // Keep only a handful: a mesh is several megabytes and the browser
        // only ever loads the avatar that is currently worn.
        const KEEP: usize = 8;
        if cache.len() >= KEEP
            && !cache.contains_key(&user_id)
            && let Some(oldest) = cache.keys().next().copied()
        {
            cache.remove(&oldest);
        }
        cache.insert(user_id, Arc::clone(&model));
    }
    Some(model)
}

fn fetch_model(net: &dyn Network, user_id: i64) -> Option<Arc<AvatarModel>> {
    let url = format!(
        "https://thumbnails.roblox.com/v1/users/avatar-3d?userId={user_id}&size=420x420&format=OBJ"
    );
    let mut image = None;
    for attempt in 0..10 {
        let answer = fetch(net, "GET", &url, None)?;
        let json: serde_json::Value = serde_json::from_slice(&answer.body).ok()?;
        match json["state"].as_str() {
            Some("Completed") => {
                image = json["imageUrl"].as_str().map(str::to_owned);
                break;
            }
            Some("Pending") if attempt < 9 => {
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            _ => return None,
        }
    }
    let manifest = fetch(net, "GET", &image?, None)?;
    let manifest: serde_json::Value = serde_json::from_slice(&gunzip(manifest.body)).ok()?;
    let mut names = vec![manifest["obj"].as_str()?, manifest["mtl"].as_str()?];
    let textures = manifest["textures"]
        .as_array()?
        .iter()
        .filter_map(|name| name.as_str())
        .collect::<Vec<_>>();
    names.extend_from_slice(&textures);

    let mut files = cdn_files(net, &names);
    let obj = String::from_utf8(files[0].take()?).ok()?;
    if !obj.contains("v ") || !obj.contains("f ") {
        return None;
    }
    let mtl = String::from_utf8(files[1].take()?).ok()?;
    if !mtl.contains("newmtl ") {
        return None;
    }
    let mut images = Vec::new();
    for (index, name) in textures.iter().enumerate() {
        let Some(png) = files[index + 2].take() else {
            continue;
        };
        if png.starts_with(b"\x89PNG\r\n\x1a\n") {
            images.push(((*name).to_owned(), Arc::from(png)));
        }
    }
    let mut hash = blake3::Hasher::new();
    hash.update(obj.as_bytes());
    hash.update(mtl.as_bytes());
    for (name, png) in &images {
        hash.update(name.as_bytes());
        hash.update(png);
    }
    let version = hash.finalize().to_hex()[..16].to_owned();
    Some(Arc::new(AvatarModel {
        obj: Arc::from(obj),
        mtl: Arc::from(mtl),
        textures: images,
        version,
    }))
}

/// Files from the 3D thumbnail's CDN. A manifest name is only served by one
/// of the eight shard hosts; the others answer 403, so the shards are tried
/// in parallel by a small pool rather than one after another.
fn cdn_files(net: &dyn Network, names: &[&str]) -> Vec<Option<Vec<u8>>> {
    const WORKERS: usize = 16;
    let jobs = (0..8)
        .flat_map(|shard| (0..names.len()).map(move |file| (file, shard)))
        .collect::<Vec<_>>();
    let next = AtomicUsize::new(0);
    let done = (0..names.len())
        .map(|_| AtomicBool::new(false))
        .collect::<Vec<_>>();
    let files = (0..names.len())
        .map(|_| Mutex::new(None))
        .collect::<Vec<Mutex<Option<Vec<u8>>>>>();
    std::thread::scope(|scope| {
        for _ in 0..WORKERS {
            scope.spawn(|| {
                loop {
                    let job = next.fetch_add(1, Ordering::Relaxed);
                    if job >= jobs.len() {
                        break;
                    }
                    let (file, shard) = jobs[job];
                    if done[file].load(Ordering::Relaxed) {
                        continue;
                    }
                    let url = format!("https://t{shard}.rbxcdn.com/{}", names[file]);
                    if let Some(answer) = fetch(net, "GET", &url, None)
                        && let Ok(mut slot) = files[file].lock()
                        && slot.is_none()
                    {
                        *slot = Some(gunzip(answer.body));
                        done[file].store(true, Ordering::Relaxed);
                    }
                }
            });
        }
    });
    files
        .into_iter()
        .map(|file| file.into_inner().unwrap_or_default())
        .collect()
}

fn gunzip(bytes: Vec<u8>) -> Vec<u8> {
    if !bytes.starts_with(&[0x1f, 0x8b]) {
        return bytes;
    }
    let mut out = Vec::new();
    match GzDecoder::new(&bytes[..]).read_to_end(&mut out) {
        Ok(_) => out,
        Err(_) => bytes,
    }
}

/// The avatar's Shirt or Pants template image: the asset's XML names the
/// image it draws, and that image is the 585×559 classic template.
fn garment(
    net: &dyn Network,
    avatar: &serde_json::Value,
    kind: &str,
    property: &str,
) -> Option<Arc<[u8]>> {
    let asset = avatar["assets"].as_array()?.iter().find(|asset| {
        asset["assetType"]["name"]
            .as_str()
            .is_some_and(|name| name == kind)
    })?;
    let asset_id = asset["id"].as_i64()?;
    let xml = asset_bytes(net, asset_id)?;
    let image = template_id(&xml, property)?;
    let png = asset_bytes(net, image)?;
    // Only a real PNG is worth sending: the browser decodes it as one.
    if png.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(Arc::from(png))
    } else {
        None
    }
}

/// An asset's bytes. Open Cloud's asset delivery is the path that still
/// serves newer shirts and pants (the legacy endpoint answers 401); the
/// legacy endpoint remains for old, public assets and offline setups.
fn asset_bytes(net: &dyn Network, id: i64) -> Option<Vec<u8>> {
    if std::env::var_os("ROBLOX_API_KEY").is_some()
        && let Some(answer) = fetch(
            net,
            "GET",
            &format!("https://apis.roblox.com/asset-delivery-api/v1/assetId/{id}"),
            None,
        )
        && let Ok(json) = serde_json::from_slice::<serde_json::Value>(&answer.body)
        && let Some(location) = json["location"].as_str()
        && let Some(file) = fetch(net, "GET", location, None)
    {
        return Some(gunzip(file.body));
    }
    let answer = fetch(
        net,
        "GET",
        &format!("https://assetdelivery.roblox.com/v1/asset/?id={id}"),
        None,
    )?;
    Some(gunzip(answer.body))
}

/// The official R6 clips and the animation asset each is.
const CLIPS: [(&str, i64); 5] = [
    ("idle", 180435571),
    ("walk", 180426354),
    ("jump", 125750702),
    ("fall", 180436148),
    ("climb", 180436334),
];

/// The parsed clips, fetched once and kept for every later avatar.
static CLIP_CACHE: Mutex<Option<Arc<Vec<AnimationClip>>>> = Mutex::new(None);

/// The official R6 clips, for the browser to play on the default body
/// before a username is chosen. The same cache the avatar panel fills.
pub(crate) fn animations() -> Arc<Vec<AnimationClip>> {
    clips(&Ureq::new())
}

/// The official R6 clips as the browser samples them. An empty answer
/// (offline, or an asset Roblox wouldn't serve) leaves the body in its
/// rest pose and is retried on the next choice.
fn clips(net: &dyn Network) -> Arc<Vec<AnimationClip>> {
    if let Ok(cache) = CLIP_CACHE.lock()
        && let Some(clips) = cache.as_ref()
    {
        return Arc::clone(clips);
    }
    let mut out = Vec::new();
    for (name, id) in CLIPS {
        let Some(bytes) = asset_bytes(net, id) else {
            continue;
        };
        let Ok(clip) = rook_formats::animation(&bytes) else {
            continue;
        };
        let keys = clip
            .keys
            .into_iter()
            .filter_map(|key| {
                let poses = key
                    .poses
                    .into_iter()
                    .filter_map(|(pose, cf)| {
                        let joint = joint_frame(&pose)?;
                        let rotation = joint * cf.rotation * joint.transpose();
                        let translation = joint * cf.position;
                        let q = Quat::from_mat3(&rotation).normalize();
                        Some((
                            pose,
                            [
                                translation.x,
                                translation.y,
                                translation.z,
                                q.x,
                                q.y,
                                q.z,
                                q.w,
                            ],
                        ))
                    })
                    .collect::<Vec<_>>();
                (!poses.is_empty()).then_some(AnimationKey {
                    time: key.time,
                    poses,
                })
            })
            .collect::<Vec<_>>();
        if keys.is_empty() {
            continue;
        }
        out.push(AnimationClip {
            name: name.to_owned(),
            length: clip.length,
            keys,
        });
    }
    let clips = Arc::new(out);
    if !clips.is_empty()
        && let Ok(mut cache) = CLIP_CACHE.lock()
    {
        *cache = Some(Arc::clone(&clips));
    }
    clips
}

/// The joint frame an R6 pose is authored in: the rotation its Motor6D's
/// C0 and C1 share (`rigs.rs`'s rows).
fn joint_frame(pose: &str) -> Option<Mat3> {
    const FACE_RIGHT: [[f32; 3]; 3] = [[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]];
    const FACE_LEFT: [[f32; 3]; 3] = [[0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]];
    const UPRIGHT: [[f32; 3]; 3] = [[-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]];
    let rows = match pose {
        "Torso" | "Head" => UPRIGHT,
        "Left Arm" | "Left Leg" => FACE_LEFT,
        "Right Arm" | "Right Leg" => FACE_RIGHT,
        _ => return None,
    };
    Some(Mat3::from_cols(
        Vec3::new(rows[0][0], rows[1][0], rows[2][0]),
        Vec3::new(rows[0][1], rows[1][1], rows[2][1]),
        Vec3::new(rows[0][2], rows[1][2], rows[2][2]),
    ))
}

/// The image id a garment asset's XML names, e.g. `<Content
/// name="ShirtTemplate"><url>http://www.roblox.com/asset/?id=607785311</url>`.
fn template_id(xml: &[u8], property: &str) -> Option<i64> {
    let text = std::str::from_utf8(xml).ok()?;
    let start = text.find(&format!("name=\"{property}\""))?;
    let rest = &text[start..];
    let id = rest.find("id=")?;
    let digits: String = rest[id + 3..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

fn request(
    net: &dyn Network,
    method: &str,
    url: &str,
    body: Option<(&str, Vec<u8>)>,
) -> Result<Response, String> {
    let answer = send(net, method, url, body).map_err(|e| format!("Couldn't reach Roblox: {e}"))?;
    if answer.status == 404 {
        return Err("That Roblox user has no avatar to copy.".to_owned());
    }
    if !(200..300).contains(&answer.status) {
        return Err(format!("Roblox answered with status {}.", answer.status));
    }
    Ok(answer)
}

/// A request whose failure the caller can ignore: the 3D mesh is optional.
fn fetch(
    net: &dyn Network,
    method: &str,
    url: &str,
    body: Option<(&str, Vec<u8>)>,
) -> Option<Response> {
    let answer = send(net, method, url, body).ok()?;
    (200..300).contains(&answer.status).then_some(answer)
}

fn send(
    net: &dyn Network,
    method: &str,
    url: &str,
    body: Option<(&str, Vec<u8>)>,
) -> Result<Response, String> {
    let (content_type, body) = match body {
        Some((kind, bytes)) => (kind, bytes),
        None => ("", Vec::new()),
    };
    let key = std::env::var("ROBLOX_API_KEY").ok();
    let use_key = key.as_deref().is_some_and(|_| needs_key(url));
    let mut headers: Vec<(&str, &str)> = Vec::new();
    if use_key && let Some(key) = key.as_deref() {
        headers.push(("x-api-key", key));
    }
    if !body.is_empty() {
        headers.push(("Content-Type", content_type));
    }
    net.send(&Request {
        method,
        url,
        headers: &headers,
        body: &body,
        max_bytes: 8 * 1024 * 1024,
    })
}

/// The hosts that take the Open Cloud key. Sending it to the public user
/// and avatar endpoints is unnecessary; the CDN files need it too.
fn needs_key(url: &str) -> bool {
    url.starts_with("https://apis.roblox.com/")
        || url.starts_with("https://thumbnails.roblox.com/")
        || url.contains(".rbxcdn.com/")
}

/// Trim a typed username to the form Roblox's lookup takes.
fn clean(username: &str) -> Result<String, String> {
    let trimmed = username.trim();
    let name = trimmed.strip_prefix('@').unwrap_or(trimmed);
    let len = name.chars().count();
    if !(3..=20).contains(&len) || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("Enter a Roblox username (3–20 letters, numbers or _).".to_owned());
    }
    Ok(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::template_id;

    #[test]
    fn reads_the_template_image() {
        let xml = br#"<roblox><Item class="Shirt"><Properties>
            <Content name="ShirtTemplate">
              <url>http://www.roblox.com/asset/?id=607785311</url>
            </Content>
          </Properties></Item></roblox>"#;
        assert_eq!(template_id(xml, "ShirtTemplate"), Some(607785311));
    }

    #[test]
    fn a_missing_template_is_none() {
        assert_eq!(template_id(b"<roblox/>", "ShirtTemplate"), None);
    }
}
