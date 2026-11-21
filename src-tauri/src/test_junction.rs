//! Junction creation for Windows tests (a junction needs no privilege, unlike a symlink).

use std::path::Path;

/// Makes `link` a junction to `target`, panicking with PowerShell's output on failure.
/// Never through cmd, which expands `%VAR%` even inside quotes: PowerShell's New-Item
/// takes each path in a single-quoted string, which is literal (no `$`, no `%`) once
/// any `'` is doubled, and CreateProcess itself expands nothing.
pub(crate) fn make_junction(link: &Path, target: &Path) {
    let quoted = |path: &Path| format!("'{}'", path.display().to_string().replace('\'', "''"));
    let made = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(format!(
            "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path {} -Target {} | Out-Null",
            quoted(link),
            quoted(target)
        ))
        .output()
        .expect("run powershell");
    assert!(
        made.status.success(),
        "New-Item -ItemType Junction failed: {}{}",
        String::from_utf8_lossy(&made.stderr),
        String::from_utf8_lossy(&made.stdout)
    );
}

#[cfg(test)]
mod tests {
    use super::make_junction;

    /// Paths holding cmd's metacharacters, a defined `%VAR%` and a quote stay literal:
    /// each junction exists and resolves to its own target.
    #[test]
    fn make_junction_takes_paths_with_shell_metacharacters() {
        let root = tempfile::tempdir().unwrap();
        for (name, content) in [("a&b", "amp"), ("p%PATH%q", "percent"), ("it's", "quote")] {
            let target = root.path().join(format!("{name}-target"));
            std::fs::create_dir(&target).unwrap();
            std::fs::write(target.join("inside.txt"), content).unwrap();
            let link = root.path().join(format!("{name}-link"));
            make_junction(&link, &target);
            assert!(
                std::fs::symlink_metadata(&link)
                    .unwrap()
                    .file_type()
                    .is_symlink(),
                "{name}"
            );
            assert_eq!(
                std::fs::read_to_string(link.join("inside.txt")).unwrap(),
                content,
                "{name}"
            );
        }
    }
}
