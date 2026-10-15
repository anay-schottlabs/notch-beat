use std::{env, path::PathBuf, process::Command};

/// Compile the Swift capture helper into the sidecar path Tauri expects
/// (`binaries/<name>-<target-triple>`), before tauri-build checks for it.
fn build_audiotap() {
    let source = "native/audiotap/main.swift";
    println!("cargo:rerun-if-changed={source}");
    let triple = env::var("TARGET").unwrap();
    let arch = triple.split('-').next().unwrap().replace("aarch64", "arm64");
    let out = PathBuf::from("binaries").join(format!("notchbeat-audiotap-{triple}"));
    std::fs::create_dir_all("binaries").unwrap();
    let status = Command::new("xcrun")
        .args(["swiftc", "-O", "-target", &format!("{arch}-apple-macos26.0"), source, "-o"])
        .arg(&out)
        .status()
        .expect("failed to run swiftc (are the Xcode command line tools installed?)");
    assert!(status.success(), "swiftc failed to build {source}");
}

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_audiotap();
    }
    tauri_build::build()
}
