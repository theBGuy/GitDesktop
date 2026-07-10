// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `GitDesktop(.exe) mcp [--repo <path>]` runs the read-only Tier-3 MCP server
    // over stdio instead of launching the GUI (no window). This is what the in-app
    // "Use GitDesktop as an MCP server" config snippet points external clients at,
    // so the shipped app IS the server — nothing extra to bundle. See
    // docs/mcp-server-tier3.md.
    //
    // NOTE: this branch must stay ahead of `run()` — release builds register the
    // single-instance plugin in the Tauri builder there, and `gitdesktop mcp`
    // child processes must never take (or defer to) that lock.
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        gitdesktop_lib::run_mcp_server();
        return;
    }
    gitdesktop_lib::run()
}
