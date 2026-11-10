//! Typed `workflow_dispatch` inputs, read out of a workflow file the dispatch probe
//! already fetched. Only `on → workflow_dispatch → inputs` is read, following gh's own
//! `workflow run` (findInputs) except where [`parse_workflow_dispatch_inputs`] says.

use std::fmt;

use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_saphyr::{DuplicateKeyPolicy, MergeKeyPolicy};

/// Larger files are refused before the parser sees them; real workflow files are KBs.
const MAX_YML_BYTES: usize = 1_048_576;
const MAX_INPUTS: usize = 25;
/// Descriptions are display-only, so they are cut to this many chars; a choice keeps
/// its first `MAX_OPTIONS` options.
const MAX_TEXT_CHARS: usize = 512;
const MAX_OPTIONS: usize = 200;
/// GitHub caps a dispatch's inputs payload at 65,535 chars (workflow_dispatch docs),
/// so a longer default or option could never be sent. Values are never cut: a cut
/// one would be dispatched as if the file had declared it.
const MAX_VALUE_CHARS: usize = 65_535;
const DISPATCH: &str = "workflow_dispatch";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowInputKind {
    String,
    Choice,
    Boolean,
    Number,
    Environment,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInput {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: WorkflowInputKind,
    pub description: Option<String>,
    pub default: Option<String>,
    pub required: bool,
    pub options: Vec<String>,
}

/// The declared inputs of a workflow's `workflow_dispatch` trigger, in file order.
///
/// `None` when the file is over 1 MiB, fails to parse (a blown budget, a duplicate key
/// or a second document included), has no `on` key, or its `on` lacks
/// `workflow_dispatch`; also when `workflow_dispatch` or its `inputs` is neither null
/// nor a map, since a malformed trigger must read as unknown rather than as "no
/// inputs". `Some(vec![])` when the trigger is present with no inputs, or null ones,
/// and for the scalar and list spellings of `on`, which carry none.
///
/// Departures from gh, ruled deliberately: file order is kept (gh sorts by name),
/// booleans and descriptions are carried, a `choice` without options and a `boolean`
/// whose default is neither a YAML boolean nor the text `true`/`false` degrade to
/// `string` instead of failing, and a wrong-typed field reads as absent. Defaults and
/// options keep their scalar text as written (`1.10`, `010`), a boolean's YAML-boolean
/// default excepted (`True` reads "true"), and at most 25 inputs are kept.
pub fn parse_workflow_dispatch_inputs(yml: &str) -> Option<Vec<WorkflowInput>> {
    if yml.len() > MAX_YML_BYTES {
        return None;
    }
    let shape: Shape = serde_saphyr::from_str_with_options(yml, parse_options()).ok()?;
    let doc = serde_saphyr::with_deserializer_from_str_with_options(yml, parse_options(), |d| {
        NodeSeed(&shape).deserialize(d)
    })
    .ok()?;
    dispatch_inputs(&doc)
}

/// Budgets well under the crate's defaults (a workflow file is small), alias replay
/// capped against alias bombs, and YAML 1.2 booleans so the `on` key stays a string.
/// Merge keys stay ordinary keys: GitHub Actions does not expand them.
fn parse_options() -> serde_saphyr::Options {
    serde_saphyr::options! {
        budget: serde_saphyr::budget! {
            max_depth: 32,
            max_nodes: 50_000,
            max_events: 200_000,
            max_aliases: 1_000,
            max_documents: 1,
            max_total_scalar_bytes: MAX_YML_BYTES,
        },
        alias_limits: serde_saphyr::alias_limits! {
            max_total_replayed_events: 100_000,
            max_replay_stack_depth: 16,
        },
        strict_booleans: true,
        merge_keys: MergeKeyPolicy::AsOrdinary,
        duplicate_keys: DuplicateKeyPolicy::Error,
    }
}

fn dispatch_inputs(doc: &Node) -> Option<Vec<WorkflowInput>> {
    let on = lookup(entries(doc)?, |k| k.eq_ignore_ascii_case("on"))?;
    let trigger = match on {
        Node::Scalar { text, .. } => return (text == DISPATCH).then(Vec::new),
        Node::Seq(events) => {
            return events
                .iter()
                .any(|e| scalar_text(e) == Some(DISPATCH))
                .then(Vec::new)
        }
        Node::Map(events) => lookup(events, |k| k == DISPATCH)?,
        Node::Null => return None,
    };
    let inputs = match trigger {
        Node::Null => return Some(Vec::new()),
        Node::Map(fields) => lookup(fields, |k| k == "inputs"),
        _ => return None,
    };
    match inputs {
        None | Some(Node::Null) => Some(Vec::new()),
        Some(Node::Map(declared)) => Some(
            declared
                .iter()
                .filter_map(|(name, body)| Some(input(scalar_text(name)?, body)))
                .take(MAX_INPUTS)
                .collect(),
        ),
        Some(_) => None,
    }
}

fn input(name: &str, body: &Node) -> WorkflowInput {
    let fields = entries(body).unwrap_or_default();
    let field = |key: &str| lookup(fields, |k| k == key);
    let default_text = field("default").and_then(scalar_text);
    let mut default = default_text.filter(|d| sendable(d)).map(str::to_string);
    // An unquoted `True`/`FALSE` is the YAML boolean GitHub reads; only YAML 1.2
    // spellings count, so `yes`, `on` and any quoted text stay text.
    let default_boolean = match field("default") {
        Some(Node::Scalar {
            boolean: Some(b), ..
        }) => Some(*b),
        _ => None,
    };
    let options: Vec<String> = match field("options") {
        Some(Node::Seq(items)) => items
            .iter()
            .filter_map(scalar_text)
            .take(MAX_OPTIONS)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    };
    // A choice with an option it could never send degrades like one with none.
    let kind = match field("type").and_then(scalar_text) {
        Some("choice") if !options.is_empty() && options.iter().all(|o| sendable(o)) => {
            WorkflowInputKind::Choice
        }
        Some("boolean")
            if default_boolean.is_some()
                || default_text.is_none_or(|d| d == "true" || d == "false") =>
        {
            WorkflowInputKind::Boolean
        }
        Some("number") => WorkflowInputKind::Number,
        Some("environment") => WorkflowInputKind::Environment,
        _ => WorkflowInputKind::String,
    };
    if kind == WorkflowInputKind::Boolean {
        if let Some(b) = default_boolean {
            default = Some(b.to_string());
        }
    }
    WorkflowInput {
        name: name.to_string(),
        description: field("description").and_then(scalar_text).map(clamp_text),
        default,
        // Only a YAML boolean counts: a quoted "true" is a string, which GitHub refuses.
        required: matches!(
            field("required"),
            Some(Node::Scalar {
                boolean: Some(true),
                ..
            })
        ),
        // GitHub reads options only for a choice.
        options: if kind == WorkflowInputKind::Choice {
            options
        } else {
            Vec::new()
        },
        kind,
    }
}

fn clamp_text(text: &str) -> String {
    text.chars().take(MAX_TEXT_CHARS).collect()
}

fn sendable(value: &str) -> bool {
    value.chars().count() <= MAX_VALUE_CHARS
}

fn entries(node: &Node) -> Option<&[(Node, Node)]> {
    match node {
        Node::Map(entries) => Some(entries),
        _ => None,
    }
}

fn scalar_text(node: &Node) -> Option<&str> {
    match node {
        Node::Scalar { text, .. } => Some(text),
        _ => None,
    }
}

/// The first entry whose key is a scalar matching `key`.
fn lookup(map: &[(Node, Node)], key: impl Fn(&str) -> bool) -> Option<&Node> {
    map.iter()
        .find(|(k, _)| scalar_text(k).is_some_and(&key))
        .map(|(_, v)| v)
}

/// Pass one: what each node IS, read through `deserialize_any`. Its scalar values are
/// unusable (a plain `1.10` arrives as the float 1.1), so it keeps only the kinds pass
/// two needs to ask for every scalar as a string, and whether a scalar was a boolean.
enum Shape {
    Null,
    Scalar { boolean: Option<bool> },
    Seq(Vec<Shape>),
    Map(Vec<(Shape, Shape)>),
}

impl<'de> Deserialize<'de> for Shape {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(ShapeVisitor)
    }
}

struct ShapeVisitor;

impl<'de> Visitor<'de> for ShapeVisitor {
    type Value = Shape;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any YAML node")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Shape, E> {
        Ok(Shape::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<Shape, E> {
        Ok(Shape::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Shape, D::Error> {
        Shape::deserialize(d)
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Shape, E> {
        Ok(Shape::Scalar { boolean: Some(v) })
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Shape, E> {
        Ok(Shape::Scalar { boolean: None })
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Shape, E> {
        Ok(Shape::Scalar { boolean: None })
    }

    fn visit_i128<E: de::Error>(self, _: i128) -> Result<Shape, E> {
        Ok(Shape::Scalar { boolean: None })
    }

    fn visit_u128<E: de::Error>(self, _: u128) -> Result<Shape, E> {
        Ok(Shape::Scalar { boolean: None })
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Shape, E> {
        Ok(Shape::Scalar { boolean: None })
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<Shape, E> {
        Ok(Shape::Scalar { boolean: None })
    }

    fn visit_bytes<E: de::Error>(self, _: &[u8]) -> Result<Shape, E> {
        Ok(Shape::Scalar { boolean: None })
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Shape, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element::<Shape>()? {
            items.push(item);
        }
        Ok(Shape::Seq(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Shape, A::Error> {
        let mut entries = Vec::new();
        while let Some(key) = map.next_key::<Shape>()? {
            entries.push((key, map.next_value::<Shape>()?));
        }
        Ok(Shape::Map(entries))
    }
}

/// Pass two: the same tree with each scalar read through a `String` target, which
/// keeps its text as written, plus pass one's boolean verdict for it.
enum Node {
    Null,
    Scalar { text: String, boolean: Option<bool> },
    Seq(Vec<Node>),
    Map(Vec<(Node, Node)>),
}

const SHAPE_DRIFT: &str = "the second pass read a different document shape";

/// Walks one node of pass two, asking for exactly the kind pass one saw there.
struct NodeSeed<'s>(&'s Shape);

impl<'de> DeserializeSeed<'de> for NodeSeed<'_> {
    type Value = Node;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Node, D::Error> {
        match self.0 {
            Shape::Null => {
                IgnoredAny::deserialize(d)?;
                Ok(Node::Null)
            }
            Shape::Scalar { boolean } => Ok(Node::Scalar {
                text: String::deserialize(d)?,
                boolean: *boolean,
            }),
            Shape::Seq(items) => d.deserialize_seq(SeqWalk(items)),
            Shape::Map(entries) => d.deserialize_map(MapWalk(entries)),
        }
    }
}

struct SeqWalk<'s>(&'s [Shape]);

impl<'de> Visitor<'de> for SeqWalk<'_> {
    type Value = Node;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a sequence")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Node, A::Error> {
        let mut items = Vec::with_capacity(self.0.len());
        for shape in self.0 {
            let item = seq.next_element_seed(NodeSeed(shape))?;
            items.push(item.ok_or_else(|| de::Error::custom(SHAPE_DRIFT))?);
        }
        if seq.next_element::<IgnoredAny>()?.is_some() {
            return Err(de::Error::custom(SHAPE_DRIFT));
        }
        Ok(Node::Seq(items))
    }
}

struct MapWalk<'s>(&'s [(Shape, Shape)]);

impl<'de> Visitor<'de> for MapWalk<'_> {
    type Value = Node;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a mapping")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Node, A::Error> {
        let mut entries = Vec::with_capacity(self.0.len());
        for (key, value) in self.0 {
            let key = map
                .next_key_seed(NodeSeed(key))?
                .ok_or_else(|| de::Error::custom(SHAPE_DRIFT))?;
            entries.push((key, map.next_value_seed(NodeSeed(value))?));
        }
        if map.next_key::<IgnoredAny>()?.is_some() {
            return Err(de::Error::custom(SHAPE_DRIFT));
        }
        Ok(Node::Map(entries))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn inputs(yml: &str) -> Vec<WorkflowInput> {
        parse_workflow_dispatch_inputs(yml).unwrap_or_else(|| panic!("expected Some for {yml}"))
    }

    fn only(yml: &str) -> WorkflowInput {
        let mut list = inputs(yml);
        assert_eq!(list.len(), 1, "{list:?}");
        list.remove(0)
    }

    fn string_input(name: &str) -> WorkflowInput {
        WorkflowInput {
            name: name.to_string(),
            kind: WorkflowInputKind::String,
            description: None,
            default: None,
            required: false,
            options: Vec::new(),
        }
    }

    #[test]
    fn reads_a_typed_inputs_block_in_file_order() {
        let yml = "name: release\non:\n  workflow_dispatch:\n    inputs:\n      level:\n        type: choice\n        options: [info, debug]\n        default: info\n      dry_run:\n        type: boolean\n        default: true\n        description: |\n          Skip the publish step.\n          Builds still run.\n      version:\n        type: string\n        required: true\njobs: {}\n";
        assert_eq!(
            inputs(yml),
            vec![
                WorkflowInput {
                    name: "level".into(),
                    kind: WorkflowInputKind::Choice,
                    description: None,
                    default: Some("info".into()),
                    required: false,
                    options: vec!["info".into(), "debug".into()],
                },
                WorkflowInput {
                    name: "dry_run".into(),
                    kind: WorkflowInputKind::Boolean,
                    description: Some("Skip the publish step.\nBuilds still run.\n".into()),
                    default: Some("true".into()),
                    required: false,
                    options: Vec::new(),
                },
                WorkflowInput {
                    required: true,
                    ..string_input("version")
                },
            ]
        );
    }

    #[test]
    fn names_keep_file_order_not_sorted_order() {
        let yml = "on:\n  workflow_dispatch:\n    inputs:\n      z_first: {}\n      a_second: {}\n";
        let names: Vec<String> = inputs(yml).into_iter().map(|i| i.name).collect();
        assert_eq!(names, ["z_first", "a_second"]);
    }

    #[test]
    fn every_spelling_of_on_without_inputs_is_an_empty_list() {
        for yml in [
            "on: workflow_dispatch\n",
            "on: [push, workflow_dispatch]\n",
            "on:\n  - push\n  - workflow_dispatch\n",
            "on: {workflow_dispatch: ~}\n",
            "on:\n  workflow_dispatch:\n  push:\n    branches: [main]\n",
            "on:\n  workflow_dispatch: {}\n",
            "on:\n  workflow_dispatch:\n    inputs: ~\n",
            "on:\n  workflow_dispatch:\n    inputs:\n",
        ] {
            assert_eq!(
                parse_workflow_dispatch_inputs(yml),
                Some(Vec::new()),
                "{yml}"
            );
        }
    }

    #[test]
    fn a_missing_trigger_or_on_key_is_unknown() {
        for yml in [
            "on: push\n",
            "on: [push, pull_request]\n",
            "on:\n  push:\n  pull_request:\n",
            "name: ci\njobs: {}\n",
            "on:\n",
            "",
            "- on: workflow_dispatch\n",
            // A malformed trigger or inputs block is unknown, never "no inputs".
            "on:\n  workflow_dispatch: yes please\n",
            "on:\n  workflow_dispatch:\n    inputs: [level]\n",
        ] {
            assert_eq!(parse_workflow_dispatch_inputs(yml), None, "{yml:?}");
        }
    }

    #[test]
    fn a_comment_only_mention_is_not_a_trigger() {
        let yml = "on: push # workflow_dispatch later\n# workflow_dispatch:\njobs: {}\n";
        assert!(yml.contains(DISPATCH));
        assert_eq!(parse_workflow_dispatch_inputs(yml), None);
    }

    #[test]
    fn the_on_key_matches_under_strict_booleans_and_any_case() {
        for key in ["on", "On", "ON", "oN"] {
            let yml = format!("{key}:\n  workflow_dispatch:\n    inputs:\n      x: {{}}\n");
            assert_eq!(inputs(&yml), vec![string_input("x")], "{key}");
        }
        // YAML 1.1 would read `on`/`yes` as booleans; a quoted key is still the key.
        assert_eq!(
            inputs("\"on\": workflow_dispatch\n"),
            Vec::<WorkflowInput>::new()
        );
    }

    #[test]
    fn defaults_and_options_keep_their_scalar_text() {
        let yml = "on:\n  workflow_dispatch:\n    inputs:\n      a:\n        default: true\n      b:\n        default: 1.10\n      c:\n        default: 010\n      d:\n        default: ~\n      e:\n        default: \"quoted\"\n      f:\n        type: choice\n        options: [1.10, 010, true, ~, [nested], plain]\n";
        let got = inputs(yml);
        let defaults: Vec<Option<&str>> = got.iter().map(|i| i.default.as_deref()).collect();
        assert_eq!(
            defaults,
            [
                Some("true"),
                Some("1.10"),
                Some("010"),
                None,
                Some("quoted"),
                None
            ]
        );
        assert_eq!(got[5].options, ["1.10", "010", "true", "plain"]);
    }

    #[test]
    fn a_choice_without_options_degrades_to_string() {
        for body in [
            "type: choice",
            "type: choice\n        options: []",
            "type: choice\n        options: info",
        ] {
            let yml =
                format!("on:\n  workflow_dispatch:\n    inputs:\n      level:\n        {body}\n");
            assert_eq!(only(&yml), string_input("level"), "{body}");
        }
    }

    #[test]
    fn a_boolean_with_a_non_boolean_default_degrades_to_string() {
        for default in ["yes", "on", "1", "\"True\"", "'FALSE'"] {
            let yml = format!(
                "on:\n  workflow_dispatch:\n    inputs:\n      flag:\n        type: boolean\n        default: {default}\n"
            );
            let got = only(&yml);
            assert_eq!(got.kind, WorkflowInputKind::String, "{default}");
            assert_eq!(
                got.default.as_deref(),
                Some(default.trim_matches(['"', '\'']))
            );
        }
        // A YAML 1.2 boolean is the boolean GitHub reads, normalized to its literal.
        for (default, kept) in [
            ("default: true", Some("true")),
            ("default: false", Some("false")),
            ("default: \"true\"", Some("true")),
            ("default: True", Some("true")),
            ("default: TRUE", Some("true")),
            ("default: False", Some("false")),
            ("default: FALSE", Some("false")),
            ("description: x", None),
        ] {
            let yml = format!(
                "on:\n  workflow_dispatch:\n    inputs:\n      flag:\n        type: boolean\n        {default}\n"
            );
            let got = only(&yml);
            assert_eq!(got.kind, WorkflowInputKind::Boolean, "{default}");
            assert_eq!(got.default.as_deref(), kept, "{default}");
        }
        // Only a boolean input normalizes: a string's `TRUE` stays as written.
        let yml = "on:\n  workflow_dispatch:\n    inputs:\n      s:\n        default: TRUE\n";
        assert_eq!(only(yml).default.as_deref(), Some("TRUE"));
    }

    #[test]
    fn every_type_maps_and_anything_else_reads_as_string() {
        for (ty, kind) in [
            ("string", WorkflowInputKind::String),
            ("number", WorkflowInputKind::Number),
            ("environment", WorkflowInputKind::Environment),
            ("boolean", WorkflowInputKind::Boolean),
            ("Number", WorkflowInputKind::String),
            ("secret", WorkflowInputKind::String),
            ("[number]", WorkflowInputKind::String),
        ] {
            let yml =
                format!("on:\n  workflow_dispatch:\n    inputs:\n      x:\n        type: {ty}\n");
            assert_eq!(only(&yml).kind, kind, "{ty}");
        }
    }

    #[test]
    fn required_counts_only_a_yaml_boolean_true() {
        for (value, required) in [
            ("true", true),
            ("True", true),
            ("false", false),
            ("\"yes\"", false),
            ("yes", false),
            ("\"true\"", false),
            ("1", false),
            ("[true]", false),
        ] {
            let yml = format!(
                "on:\n  workflow_dispatch:\n    inputs:\n      x:\n        required: {value}\n"
            );
            assert_eq!(only(&yml).required, required, "{value}");
        }
    }

    #[test]
    fn wrong_typed_fields_read_as_absent_without_failing_the_parse() {
        let yml = "on:\n  workflow_dispatch:\n    inputs:\n      x:\n        description: {a: 1}\n        default: [a, b]\n        options: {a: b}\n      y: just text\n      z: ~\n";
        assert_eq!(
            inputs(yml),
            vec![string_input("x"), string_input("y"), string_input("z")]
        );
    }

    #[test]
    fn unknown_keys_are_ignored_at_every_level() {
        let yml = "x-top: 1\nname: ci\non:\n  push:\n  workflow_dispatch:\n    x-trigger: [1, 2]\n    inputs:\n      level:\n        type: number\n        x-input: {deep: [1]}\n        default: 3\njobs:\n  build:\n    runs-on: ubuntu-latest\n";
        assert_eq!(
            inputs(yml),
            vec![WorkflowInput {
                kind: WorkflowInputKind::Number,
                default: Some("3".into()),
                ..string_input("level")
            }]
        );
    }

    #[test]
    fn anchored_inputs_parse_through_their_aliases() {
        let one = "x-shared: &base\n  type: choice\n  options: [info, debug]\non:\n  workflow_dispatch:\n    inputs:\n      first: *base\n      second:\n        type: string\n";
        let got = inputs(one);
        assert_eq!(got[0].name, "first");
        assert_eq!(got[0].kind, WorkflowInputKind::Choice);
        assert_eq!(got[0].options, ["info", "debug"]);
        assert_eq!(got[1], string_input("second"));

        let whole = "x-inputs: &all\n  level:\n    default: 1.10\n  mode: {type: boolean}\non:\n  workflow_dispatch:\n    inputs: *all\n";
        let got = inputs(whole);
        assert_eq!(got[0].default.as_deref(), Some("1.10"));
        assert_eq!(got[1].kind, WorkflowInputKind::Boolean);
    }

    #[test]
    fn at_most_25_inputs_are_kept_in_file_order() {
        let mut yml = String::from("on:\n  workflow_dispatch:\n    inputs:\n");
        for i in 0..26 {
            yml.push_str(&format!("      in_{i:02}: {{}}\n"));
        }
        let got = inputs(&yml);
        assert_eq!(got.len(), 25);
        assert_eq!(got[0].name, "in_00");
        assert_eq!(got[24].name, "in_24");
    }

    #[test]
    fn descriptions_clamp_to_512_chars_on_a_char_boundary() {
        let long = "é".repeat(600);
        let yml = format!(
            "on:\n  workflow_dispatch:\n    inputs:\n      x:\n        description: {long}\n"
        );
        let description = only(&yml).description.unwrap();
        assert_eq!(description.chars().count(), 512);
        assert!(long.starts_with(&description));
    }

    #[test]
    fn defaults_are_kept_whole() {
        let long = "é".repeat(600);
        let yml =
            format!("on:\n  workflow_dispatch:\n    inputs:\n      x:\n        default: {long}\n");
        assert_eq!(only(&yml).default, Some(long));
    }

    #[test]
    fn a_default_over_the_dispatch_cap_reads_as_absent() {
        for (len, kept) in [(MAX_VALUE_CHARS, true), (MAX_VALUE_CHARS + 1, false)] {
            let long = "a".repeat(len);
            let yml = format!(
                "on:\n  workflow_dispatch:\n    inputs:\n      x:\n        default: {long}\n"
            );
            let got = only(&yml);
            assert_eq!(got.default.is_some(), kept, "len {len}");
            assert_eq!(got.kind, WorkflowInputKind::String);
        }
    }

    #[test]
    fn options_keep_the_first_200_each_whole() {
        let long = "é".repeat(600);
        let items: Vec<String> = (0..201).map(|i| format!("o{i}")).collect();
        let yml = format!(
            "on:\n  workflow_dispatch:\n    inputs:\n      x:\n        type: choice\n        options: [{long}, {}]\n",
            items.join(", ")
        );
        let options = only(&yml).options;
        assert_eq!(options.len(), 200);
        assert_eq!(options[0], long);
        assert_eq!(options[1], "o0");
        assert_eq!(options[199], "o198");
    }

    #[test]
    fn a_choice_with_an_option_over_the_dispatch_cap_degrades_to_string() {
        let long = "a".repeat(MAX_VALUE_CHARS + 1);
        let yml = format!(
            "on:\n  workflow_dispatch:\n    inputs:\n      x:\n        type: choice\n        options: [info, {long}]\n"
        );
        let got = only(&yml);
        assert_eq!(got.kind, WorkflowInputKind::String);
        assert!(got.options.is_empty());
    }

    #[test]
    fn duplicate_input_names_fail_the_parse() {
        let yml = "on:\n  workflow_dispatch:\n    inputs:\n      x: {}\n      x: {}\n";
        assert_eq!(parse_workflow_dispatch_inputs(yml), None);
    }

    #[test]
    fn a_file_over_one_mib_is_refused_before_parsing() {
        let head = "on: workflow_dispatch\n#";
        let at_limit = format!("{head}{}", "x".repeat(MAX_YML_BYTES - head.len()));
        assert_eq!(at_limit.len(), MAX_YML_BYTES);
        assert_eq!(parse_workflow_dispatch_inputs(&at_limit), Some(Vec::new()));
        let over = format!("{at_limit}x");
        assert_eq!(parse_workflow_dispatch_inputs(&over), None);
    }

    #[test]
    fn a_billion_laughs_document_is_refused_fast() {
        let mut yml = String::from("l0: &l0 [lol, lol, lol, lol, lol, lol, lol, lol, lol, lol]\n");
        for level in 1..9 {
            let refs = vec![format!("*l{}", level - 1); 10].join(", ");
            yml.push_str(&format!("l{level}: &l{level} [{refs}]\n"));
        }
        yml.push_str("on:\n  workflow_dispatch:\n    inputs:\n      boom: *l8\n");
        let started = Instant::now();
        assert_eq!(parse_workflow_dispatch_inputs(&yml), None);
        // A hang guard, not a timing benchmark: the bound stays generous for loaded runners.
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn deep_nesting_is_refused_without_overflowing_the_stack() {
        let flow = format!("on: {}{}\n", "[".repeat(10_000), "]".repeat(10_000));
        assert_eq!(parse_workflow_dispatch_inputs(&flow), None);

        let mut block = String::from("on:\n  workflow_dispatch:\n    inputs:\n");
        for depth in 3..300 {
            block.push_str(&format!("{}a:\n", "  ".repeat(depth)));
        }
        assert_eq!(parse_workflow_dispatch_inputs(&block), None);
    }
}
