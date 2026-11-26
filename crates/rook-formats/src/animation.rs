//! Animation assets: a `KeyframeSequence` as the keys a host can sample.
//!
//! Roblox's classic R6 clips (and animations built in Studio) are model
//! files whose `KeyframeSequence` holds a `Keyframe` per key, each with a
//! tree of `Pose`s named after the parts they turn. This module reads
//! that tree into plain [`Clip`]s; playing them is the host's job.

use glam::{Mat3, Vec3};
use rbx_dom_weak::WeakDom;
use rbx_types::Variant;

use crate::LoadError;
use rook_types::CFrame;

/// One animation: its length in seconds and its keys, in time order.
#[derive(Debug, Clone, PartialEq)]
pub struct Clip {
    pub length: f32,
    pub keys: Vec<Key>,
}

/// A keyframe's poses: the part each one turns, and its joint CFrame
/// relative to that part's parent pose.
#[derive(Debug, Clone, PartialEq)]
pub struct Key {
    pub time: f32,
    pub poses: Vec<(String, CFrame)>,
}

/// Read an animation asset (binary or XML) into a [`Clip`].
pub fn animation(bytes: &[u8]) -> Result<Clip, LoadError> {
    let loaded = super::load(bytes)?;
    Ok(clip(&loaded.dom))
}

/// The first `KeyframeSequence` in `dom`, as a [`Clip`]. A file without
/// one is an empty clip, which a player treats as "no animation".
pub fn clip(dom: &WeakDom) -> Clip {
    let Some(sequence) = dom
        .descendants()
        .find(|i| i.class.as_str() == "KeyframeSequence")
    else {
        return Clip {
            length: 0.0,
            keys: Vec::new(),
        };
    };
    let mut length = match sequence.properties.get(&"Length".into()) {
        Some(Variant::Float32(length)) => *length,
        Some(Variant::Float64(length)) => *length as f32,
        _ => 0.0,
    };
    let mut keys: Vec<Key> = sequence
        .children()
        .iter()
        .filter_map(|&id| dom.get_by_ref(id))
        .filter(|i| i.class.as_str() == "Keyframe")
        .map(|frame| {
            let time = match frame.properties.get(&"Time".into()) {
                Some(Variant::Float32(time)) => *time,
                Some(Variant::Float64(time)) => *time as f32,
                _ => 0.0,
            };
            let mut poses = Vec::new();
            collect_poses(dom, frame.children(), &mut poses);
            Key { time, poses }
        })
        .collect();
    keys.sort_by(|a, b| a.time.total_cmp(&b.time));
    if length <= 0.0 {
        length = keys.last().map_or(0.0, |key| key.time);
    }
    Clip { length, keys }
}

fn collect_poses(dom: &WeakDom, children: &[rbx_types::Ref], poses: &mut Vec<(String, CFrame)>) {
    for &child in children {
        let Some(instance) = dom.get_by_ref(child) else {
            continue;
        };
        if instance.class.as_str() == "Pose"
            && let Some(Variant::CFrame(cf)) = instance.properties.get(&"CFrame".into())
        {
            poses.push((instance.name.clone(), cframe(cf)));
        }
        collect_poses(dom, instance.children(), poses);
    }
}

/// `rbx_types` stores a CFrame's rotation as rows; Rook's `Mat3` is
/// column-major, so the rows become columns.
fn cframe(cf: &rbx_types::CFrame) -> CFrame {
    let o = cf.orientation;
    CFrame {
        position: Vec3::new(cf.position.x, cf.position.y, cf.position.z),
        rotation: Mat3::from_cols(
            Vec3::new(o.x.x, o.y.x, o.z.x),
            Vec3::new(o.x.y, o.y.y, o.z.y),
            Vec3::new(o.x.z, o.y.z, o.z.z),
        ),
    }
}
