//! 画板引用判断：逐条跑 contracts/fixtures/board-references 夹具。

use kacha_server::references::board_task_dirs;

#[test]
fn shared_fixture_cases() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../contracts/fixtures/board-references/cases.json");
    let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let text = match c.get("board_text") {
            Some(t) => t.as_str().unwrap().to_string(),
            None => c["board"].to_string(),
        };
        let got = match board_task_dirs(&text) {
            Some(dirs) => serde_json::json!({ "readable": true, "task_dirs": dirs }),
            None => serde_json::json!({ "readable": false }),
        };
        assert_eq!(got, c["expected"], "夹具「{name}」");
    }
}
