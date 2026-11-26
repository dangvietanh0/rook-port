//! Resolving the username the player types in the in-game avatar panel:
//! the Roblox user, its body colours, and its classic Shirt/Pants images.
//!
//! Everything here blocks on the network and is called from
//! `spawn_blocking`, never from the simulation thread.

use std::sync::{Arc, Mutex};

use glam::{Mat3, Quat, Vec3};
use rook_platform::network::{Network, Request, Response, Ureq};

use crate::protocol::{AnimationClip, AnimationKey};

/// A user's look, ready to hand to the session thread.
#[derive(Debug)]
pub(crate) struct Resolved {
    pub(crate) name: String,
    pub(crate) user_id: i64,
    pub(crate) avatar: rook_lua::Avatar,
    /// The classic 585×559 shirt template, as PNG.
    pub(crate) shirt: Option<Arc<[u8]>>,
    /// The classic 585×559 pants template, as PNG.
    pub(crate) pants: Option<Arc<[u8]>>,
    /// The official R6 clips, sampled by the browser.
    pub(crate) animations: Arc<Vec<AnimationClip>>,
}

/// Look `username` up on Roblox. `Err` is a message for the panel.
pub(crate) fn resolve(username: &str) -> Result<Resolved, String> {
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

    let shirt = garment(&net, &json, "Shirt", "ShirtTemplate");
    let pants = garment(&net, &json, "Pants", "PantsTemplate");
    Ok(Resolved {
        name,
        user_id,
        avatar,
        shirt,
        pants,
        animations: clips(&net),
    })
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
    let xml = request(
        net,
        "GET",
        &format!("https://assetdelivery.roblox.com/v1/asset/?id={asset_id}"),
        None,
    )
    .ok()?;
    let image = template_id(&xml.body, property)?;
    let png = request(
        net,
        "GET",
        &format!("https://assetdelivery.roblox.com/v1/asset/?id={image}"),
        None,
    )
    .ok()?;
    // Only a real PNG is worth sending: the browser decodes it as one.
    if png.body.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(Arc::from(png.body))
    } else {
        None
    }
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
        let Ok(answer) = request(
            net,
            "GET",
            &format!("https://assetdelivery.roblox.com/v1/asset/?id={id}"),
            None,
        ) else {
            continue;
        };
        let Ok(clip) = rook_formats::animation(&answer.body) else {
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
    let (content_type, body) = match body {
        Some((kind, bytes)) => (kind, bytes),
        None => ("", Vec::new()),
    };
    let headers: Vec<(&str, &str)> = if body.is_empty() {
        Vec::new()
    } else {
        vec![("Content-Type", content_type)]
    };
    let answer = net
        .send(&Request {
            method,
            url,
            headers: &headers,
            body: &body,
            max_bytes: 8 * 1024 * 1024,
        })
        .map_err(|e| format!("Couldn't reach Roblox: {e}"))?;
    if answer.status == 404 {
        return Err("That Roblox user has no avatar to copy.".to_owned());
    }
    if !(200..300).contains(&answer.status) {
        return Err(format!("Roblox answered with status {}.", answer.status));
    }
    Ok(answer)
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
