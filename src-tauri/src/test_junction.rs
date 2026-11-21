//! Junction creation for Windows tests (a junction needs no privilege, unlike a symlink).

use std::path::Path;

/// Makes `link` a junction to `target`, panicking with PowerShell's output on failure.
/// The paths reach New-Item through the child's environment, never the script text, so
/// no quote or `%` in them needs escaping (cmd would expand `%VAR%` even when quoted).
/// `-Target` resolves wildcards (measured, PowerShell 5.1) and is escaped in the script;
/// `-Path` is literal, and escaping it would put the backticks in the link's name.
pub(crate) fn make_junction(link: &Path, target: &Path) {
    let made = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:JUNCTION_LINK \
             -Target ([WildcardPattern]::Escape($env:JUNCTION_TARGET)) | Out-Null",
        ])
        .env("JUNCTION_LINK", link)
        .env("JUNCTION_TARGET", target)
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

    /// Paths holding cmd's metacharacters, a defined `%VAR%`, straight and curly quotes and
    /// wildcard brackets stay literal: each junction resolves to its own target.
    #[test]
    fn make_junction_takes_paths_with_shell_metacharacters() {
        let root = tempfile::tempdir().unwrap();
        for (name, content) in [
            ("a&b", "amp"),
            ("p%PATH%q", "percent"),
            ("it's", "quote"),
            ("it\u{2019}s", "curly"),
            ("b[1]", "brackets"),
        ] {
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
