//! Junction creation for Windows tests (mklink /J needs no privilege, unlike a symlink).

use std::os::windows::process::CommandExt;
use std::path::Path;

/// Makes `link` a junction to `target`, panicking with mklink's stderr on failure.
/// Both paths go to cmd inside double quotes through `raw_arg`: std quotes an argument
/// only when it holds a space or tab, so a path with `&`, `|`, `<`, `>` or `^` would
/// reach cmd raw, and a Windows path can't contain `"` to break out of the quotes.
/// cmd still expands `%VAR%` inside them, so a path holding `%` isn't safe here.
/// mklink reads a `/` as a switch, so callers join paths per segment.
pub(crate) fn make_junction(link: &Path, target: &Path) {
    let made = std::process::Command::new("cmd")
        .raw_arg(format!(
            "/C mklink /J \"{}\" \"{}\"",
            link.display(),
            target.display()
        ))
        .output()
        .expect("run mklink");
    assert!(
        made.status.success(),
        "mklink /J failed: {}",
        String::from_utf8_lossy(&made.stderr)
    );
}

#[cfg(test)]
mod tests {
    use super::make_junction;

    /// Paths holding cmd's metacharacters stay literal inside the quotes.
    #[test]
    fn make_junction_takes_paths_with_cmd_metacharacters() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("a&b");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("inside.txt"), b"x").unwrap();
        let link = root.path().join("c&d");
        make_junction(&link, &target);
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(link.join("inside.txt")).unwrap(), b"x");
    }
}
