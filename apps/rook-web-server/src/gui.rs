//! The local player's ScreenGuis as a tree of nodes the browser lays out
//! with HTML and CSS.
//!
//! Rook lays the GUI out on the DataModel's thread and writes each object's
//! `AbsolutePosition`, `AbsoluteSize` and `AbsoluteRotation`; this module
//! reads those back, together with the look properties, and turns the tree
//! into [`GuiNode`]s. Positions are parent-relative so the browser can nest
//! elements (and let CSS inherit rotation and clipping), and the top bar's
//! inset is added to the roots as Rook's drawing does.

use glam::Vec2;
use rook_dom::{Dom, InstanceId};
use rook_gui::Gui;

use crate::assets;
use crate::protocol::{GuiNode, TextStroke, align, scale_type};

/// The top bar's height, which ScreenGuis start below unless they ignore
/// the inset (`rook_gui::layout::GUI_INSET`, kept here because the layout
/// module is private).
const GUI_INSET: f32 = 58.0;

/// The whole GUI the browser should draw: one node per enabled ScreenGui,
/// bottom first, each with its objects as children.
pub(crate) fn tree(dom: &Dom, gui: &mut Gui) -> Vec<GuiNode> {
    let Some(player) = dom.local_player() else {
        return Vec::new();
    };
    let Some(player_gui) = dom.find_first_child_of_class(player, "PlayerGui") else {
        return Vec::new();
    };
    let mut screens = Vec::new();
    collect_screens(dom, player_gui, &mut screens);
    screens.retain(|&s| dom.bool_property(s, "Enabled") != Some(false));
    screens.sort_by_key(|&s| dom.number_property(s, "DisplayOrder").unwrap_or(0.0) as i64);

    let mut next_id = 0;
    let mut out = Vec::new();
    for screen in screens {
        let at = dom
            .vector2_property(screen, "AbsolutePosition")
            .unwrap_or_default()
            .0;
        let size = dom
            .vector2_property(screen, "AbsoluteSize")
            .unwrap_or_default()
            .0;
        if size.x <= 0.0 || size.y <= 0.0 {
            continue;
        }
        next_id += 1;
        let id = next_id;
        let mut node = GuiNode {
            id,
            class: "ScreenGui".to_owned(),
            name: name_of(dom, screen),
            position: [at.x, at.y + GUI_INSET],
            size: [size.x, size.y],
            anchor: [0.0, 0.0],
            rotation: 0.0,
            visible: true,
            z_index: dom.number_property(screen, "DisplayOrder").unwrap_or(0.0) as i32,
            background_color: [0.0; 3],
            background_transparency: 1.0,
            border_color: [0.0; 3],
            border_size: 0.0,
            border_transparency: 1.0,
            corner_radius: 0.0,
            text: None,
            text_color: [0.0; 3],
            text_size: 14.0,
            text_transparency: 0.0,
            text_scaled: false,
            text_x_alignment: align::CENTER,
            text_y_alignment: align::CENTER,
            text_wrapped: false,
            rich_text: false,
            line_height: 1.0,
            font: "SourceSans".to_owned(),
            text_stroke: None,
            image: None,
            image_natural: None,
            image_rect: None,
            image_color: [1.0; 3],
            image_transparency: 0.0,
            image_scale_type: scale_type::STRETCH,
            clip: false,
            scrollable: false,
            button: false,
            text_box: false,
            interactive: false,
            placeholder: None,
            children: Vec::new(),
        };
        let origin = at; // the ScreenGui's own top left, without the inset
        let mut builder = Builder { dom, gui, next_id };
        node.children = builder.children(screen, origin, size, 0.0);
        next_id = builder.next_id;
        out.push(node);
    }
    out
}

fn collect_screens(dom: &Dom, parent: InstanceId, out: &mut Vec<InstanceId>) {
    for &child in dom.children(parent) {
        match dom.class_name(child) {
            "Folder" => collect_screens(dom, child, out),
            "ScreenGui" => out.push(child),
            _ => {}
        }
    }
}

fn name_of(dom: &Dom, id: InstanceId) -> String {
    dom.str_property(id, "Name")
        .map(std::borrow::Cow::into_owned)
        .unwrap_or_default()
}

struct Builder<'a> {
    dom: &'a Dom,
    gui: &'a mut Gui,
    next_id: u64,
}

impl Builder<'_> {
    /// `parent`'s GuiObject children, with `origin` the parent's top left on
    /// the screen and `turn` its absolute rotation in degrees.
    fn children(
        &mut self,
        parent: InstanceId,
        origin: Vec2,
        size: Vec2,
        turn: f32,
    ) -> Vec<GuiNode> {
        let mut out = Vec::new();
        for &child in self.dom.children(parent) {
            match self.dom.class_name(child) {
                "Folder" => {
                    let mut nested = self.children(child, origin, size, turn);
                    out.append(&mut nested);
                }
                class if self.dom.is_a(child, "GuiObject") => {
                    if let Some(node) = self.node(child, class, origin, size, turn) {
                        out.push(node);
                    }
                }
                _ => {}
            }
        }
        out
    }

    fn node(
        &mut self,
        id: InstanceId,
        class: &str,
        parent_origin: Vec2,
        parent_size: Vec2,
        parent_turn: f32,
    ) -> Option<GuiNode> {
        if self.dom.bool_property(id, "Visible") == Some(false) {
            return None;
        }
        let at = self
            .dom
            .vector2_property(id, "AbsolutePosition")
            .unwrap_or_default()
            .0;
        let size = self
            .dom
            .vector2_property(id, "AbsoluteSize")
            .unwrap_or_default()
            .0;
        let turn = self
            .dom
            .float_property(id, "AbsoluteRotation")
            .unwrap_or(0.0);
        let position = relative(at, size, parent_origin, parent_size, parent_turn);

        self.next_id += 1;
        let mut node = GuiNode {
            id: self.next_id,
            class: class.to_owned(),
            name: name_of(self.dom, id),
            position: [position.x, position.y],
            size: [size.x.max(0.0), size.y.max(0.0)],
            anchor: [0.0, 0.0],
            // CSS nests transforms: a child's rotation is relative to the
            // parent's, so subtract the parent's absolute turn.
            rotation: turn - parent_turn,
            visible: true,
            z_index: self.dom.number_property(id, "ZIndex").unwrap_or(1.0) as i32,
            background_color: color3(self.dom, id, "BackgroundColor3", [0.639, 0.635, 0.647]),
            background_transparency: self
                .dom
                .float_property(id, "BackgroundTransparency")
                .unwrap_or(0.0),
            border_color: color3(self.dom, id, "BorderColor3", [0.106, 0.165, 0.208]),
            border_size: self
                .dom
                .float_property(id, "BorderSizePixel")
                .unwrap_or(0.0),
            // Rook draws a legacy border with its background's opacity.
            border_transparency: self
                .dom
                .float_property(id, "BackgroundTransparency")
                .unwrap_or(0.0),
            corner_radius: corner_radius(self.dom, id, size),
            text: None,
            text_color: color3(self.dom, id, "TextColor3", [0.0; 3]),
            text_size: self.dom.float_property(id, "TextSize").unwrap_or(14.0),
            text_transparency: self
                .dom
                .float_property(id, "TextTransparency")
                .unwrap_or(0.0),
            text_scaled: self.dom.bool_property(id, "TextScaled") == Some(true),
            text_x_alignment: match self.dom.enum_item_property(id, "TextXAlignment") {
                Some("Left") => align::START,
                Some("Right") => align::END,
                _ => align::CENTER,
            },
            text_y_alignment: match self.dom.enum_item_property(id, "TextYAlignment") {
                Some("Top") => align::START,
                Some("Bottom") => align::END,
                _ => align::CENTER,
            },
            text_wrapped: self.dom.bool_property(id, "TextWrapped") == Some(true),
            rich_text: self.dom.bool_property(id, "RichText") == Some(true),
            line_height: self.dom.float_property(id, "LineHeight").unwrap_or(1.0),
            font: self
                .dom
                .enum_item_property(id, "Font")
                .unwrap_or("SourceSans")
                .to_owned(),
            text_stroke: None,
            image: None,
            image_natural: None,
            image_rect: None,
            image_color: color3(self.dom, id, "ImageColor3", [1.0; 3]),
            image_transparency: self
                .dom
                .float_property(id, "ImageTransparency")
                .unwrap_or(0.0),
            image_scale_type: match self.dom.enum_item_property(id, "ScaleType") {
                Some("Slice") => scale_type::SLICE,
                Some("Tile") => scale_type::TILE,
                Some("Fit") => scale_type::FIT,
                Some("Crop") => scale_type::CROP,
                _ => scale_type::STRETCH,
            },
            clip: self.dom.bool_property(id, "ClipsDescendants") == Some(true),
            scrollable: class == "ScrollingFrame"
                && self.dom.bool_property(id, "ScrollingEnabled") != Some(false),
            button: matches!(class, "TextButton" | "ImageButton"),
            text_box: class == "TextBox",
            // Measured by Rook's input: a press goes to an `Active` object
            // or a button; a TextBox takes it to focus itself. Inactive
            // Frames let the world through.
            interactive: self.dom.bool_property(id, "Interactable") != Some(false)
                && (matches!(class, "TextButton" | "ImageButton" | "TextBox")
                    || self.dom.bool_property(id, "Active") == Some(true)),
            placeholder: None,
            children: Vec::new(),
        };

        let is_text = matches!(class, "TextLabel" | "TextButton" | "TextBox");
        let stroke = stroke_of(self.dom, id, size);
        if let Some((stroke_id, look)) = &stroke {
            let on_text = is_text
                && self.dom.enum_item_property(*stroke_id, "ApplyStrokeMode") != Some("Border");
            if on_text {
                node.text_stroke = Some(look.clone());
            } else {
                node.border_color = look.color;
                node.border_size = look.thickness;
                node.border_transparency = look.transparency;
            }
        } else if node.corner_radius > 0.0 {
            // Measured: an object with a UICorner draws no legacy border.
            node.border_size = 0.0;
        }

        if is_text {
            let mut text = self.dom.string_property(id, "Text").unwrap_or_default();
            if text.is_empty() && node.text_box {
                text = self
                    .dom
                    .string_property(id, "PlaceholderText")
                    .unwrap_or_default();
                node.placeholder = Some(text.clone());
                if !text.is_empty() {
                    node.text_color = color3(self.dom, id, "PlaceholderColor3", [0.7; 3]);
                }
            }
            node.text = (!text.is_empty()).then_some(text);
            if node.text_stroke.is_none() {
                node.text_stroke = legacy_text_stroke(self.dom, id);
            }
        }

        if matches!(class, "ImageLabel" | "ImageButton")
            && let Some(url) = self.dom.content_property(id, "ImageContent")
            && !url.is_empty()
            && let Some(image) = self.gui.image(&url)
        {
            node.image = Some(assets::hex(&image.hash));
            node.image_natural = Some([image.width, image.height]);
            node.image_rect = image_rect(self.dom, id, image.width, image.height);
        }

        node.children = self.children(id, at, size, turn);
        Some(node)
    }
}

/// `child`'s top-left inside `parent`, undoing the parent's rotation so CSS
/// can rotate the parent element and carry the child with it.
fn relative(
    child_at: Vec2,
    child_size: Vec2,
    parent_at: Vec2,
    parent_size: Vec2,
    parent_turn: f32,
) -> Vec2 {
    let delta = (child_at + child_size * 0.5) - (parent_at + parent_size * 0.5);
    let delta = if parent_turn == 0.0 {
        delta
    } else {
        // R(-turn) with screen axes (x right, y down), the same sense as
        // CSS `rotate`.
        let (sin, cos) = (-parent_turn).to_radians().sin_cos();
        Vec2::new(delta.x * cos - delta.y * sin, delta.x * sin + delta.y * cos)
    };
    parent_size * 0.5 + delta - child_size * 0.5
}

fn color3(dom: &Dom, id: InstanceId, name: &str, default: [f32; 3]) -> [f32; 3] {
    dom.color3_property(id, name)
        .map_or(default, |c| [c.r, c.g, c.b])
}

/// The radius of `id`'s first UICorner in screen pixels (uniform; the
/// corners differ only rarely, and CSS needs one value per element).
fn corner_radius(dom: &Dom, id: InstanceId, size: Vec2) -> f32 {
    let Some(corner) = dom.find_first_child_of_class(id, "UICorner") else {
        return 0.0;
    };
    let short = size.x.abs().min(size.y.abs());
    let radius = dom
        .udim_property(corner, "TopLeftRadius")
        .map_or(8.0, |u| u.resolve(short));
    radius.clamp(0.0, short * 0.5)
}

/// The first enabled UIStroke on `id`, its colour, opacity and width in
/// screen pixels.
fn stroke_of(dom: &Dom, id: InstanceId, size: Vec2) -> Option<(InstanceId, TextStroke)> {
    let stroke = dom.children(id).iter().copied().find(|&c| {
        dom.class_name(c) == "UIStroke" && dom.bool_property(c, "Enabled") != Some(false)
    })?;
    let color = color3(dom, stroke, "Color", [0.0; 3]);
    let transparency = dom.float_property(stroke, "Transparency").unwrap_or(0.0);
    let thickness = dom.float_property(stroke, "Thickness").unwrap_or(1.0);
    let thickness = match dom.enum_item_property(stroke, "StrokeSizingMode") {
        Some("ScaledSize") => thickness * size.x.abs().min(size.y.abs()),
        _ => thickness,
    };
    (thickness > 0.0 && transparency < 1.0).then_some((
        stroke,
        TextStroke {
            color,
            transparency,
            thickness,
        },
    ))
}

/// The legacy `TextStrokeColor3` outline, which a UIStroke replaces.
fn legacy_text_stroke(dom: &Dom, id: InstanceId) -> Option<TextStroke> {
    let transparency = dom
        .float_property(id, "TextStrokeTransparency")
        .unwrap_or(1.0);
    (transparency < 1.0).then(|| TextStroke {
        color: color3(dom, id, "TextStrokeColor3", [0.0; 3]),
        transparency,
        thickness: 1.0,
    })
}

/// The part of an image an ImageLabel shows, when it names one.
fn image_rect(dom: &Dom, id: InstanceId, width: u32, height: u32) -> Option<[f32; 4]> {
    let offset = dom
        .vector2_property(id, "ImageRectOffset")
        .unwrap_or_default()
        .0;
    let size = dom
        .vector2_property(id, "ImageRectSize")
        .unwrap_or_default()
        .0;
    let size = if size.x <= 0.0 || size.y <= 0.0 {
        Vec2::new(width as f32, height as f32)
    } else {
        size
    };
    (offset.x > 0.0 || offset.y > 0.0 || size.x < width as f32 || size.y < height as f32)
        .then_some([offset.x, offset.y, size.x, size.y])
}
