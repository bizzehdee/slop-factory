//! Thin Rust shell: starts the Node sidecar (which runs the Claude Agent SDK and the
//! task watcher), forwards its stdout lines to the webview as `sidecar://event`, and
//! writes UI commands to its stdin. All the real logic lives in the sidecar.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[derive(Default)]
struct Sidecar {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
}

/// Where the sidecar's compiled entry point lives.
/// Override with SLOP_FACTORY_SIDECAR; in dev builds use the repo copy; in release, the bundled resource.
fn sidecar_entry(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("SLOP_FACTORY_SIDECAR") {
        return Ok(PathBuf::from(p));
    }
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar/dist/index.js"));
    }
    app.path()
        .resource_dir()
        .map(|d| d.join("sidecar/dist/index.js"))
        .map_err(|e| format!("Couldn't find the app's resources: {e}"))
}

/// The Node.js that runs the sidecar: SLOP_FACTORY_NODE if set, else the copy the installer put
/// beside the app (Tauri's externalBin), else whatever `node` is on PATH (development builds).
fn node_binary() -> String {
    if let Ok(p) = std::env::var("SLOP_FACTORY_NODE") {
        return p;
    }
    let name = if cfg!(windows) { "slop-factory-node.exe" } else { "slop-factory-node" };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "node".into())
}

fn notice(app: &AppHandle, level: &str, text: String) {
    let line = serde_json::json!({ "type": "notice", "level": level, "text": text }).to_string();
    let _ = app.emit("sidecar://event", line);
}

#[tauri::command]
fn sidecar_start(app: AppHandle, state: State<'_, Sidecar>) -> Result<(), String> {
    // Reloading the webview calls this again. Keep a running sidecar so work in open
    // projects carries on; the UI re-opens its projects and the sidecar replays them.
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return Ok(());
            }
            guard.take();
        }
    }

    let entry = sidecar_entry(&app)?;
    let node = node_binary();

    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("Couldn't start the sidecar with `{node}` ({e}). Install Node 24 or set SLOP_FACTORY_NODE to its full path.")
    })?;

    let stdout = child.stdout.take().ok_or("sidecar has no stdout")?;
    let stderr = child.stderr.take().ok_or("sidecar has no stderr")?;
    *state.stdin.lock().unwrap() = child.stdin.take();
    *state.child.lock().unwrap() = Some(child);

    let out_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = out_app.emit("sidecar://event", line);
            }
        }
        notice(&out_app, "error", "The sidecar stopped. Restart the app to reconnect.".into());
    });

    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[sidecar] {line}");
        }
    });

    Ok(())
}

#[tauri::command]
fn sidecar_send(state: State<'_, Sidecar>, line: String) -> Result<(), String> {
    let mut guard = state.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("The sidecar isn't running.")?;
    // One JSON message per line: never let an embedded newline split a message.
    let line = line.replace('\n', " ");
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Couldn't reach the sidecar: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Sidecar::default())
        .invoke_handler(tauri::generate_handler![sidecar_start, sidecar_send])
        .build(tauri::generate_context!())
        .expect("error while building Slop Factory");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<Sidecar>();
            // Closing stdin lets the sidecar shut Claude Code down cleanly; kill as a fallback.
            drop(state.stdin.lock().unwrap().take());
            let child = state.child.lock().unwrap().take();
            if let Some(mut child) = child {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let _ = child.kill();
            }
        }
    });
}
