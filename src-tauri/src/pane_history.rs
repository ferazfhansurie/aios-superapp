fn pane_history_store() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(std::path::PathBuf::from(home).join(".aios/state/pane-history.json"))
}

#[tauri::command]
pub fn load_pane_history() -> Vec<serde_json::Value> {
    pane_history_store()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Vec<serde_json::Value>>(&text).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn save_pane_history(items: Vec<serde_json::Value>) -> Result<(), String> {
    let Some(path) = pane_history_store() else {
        return Ok(());
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Unique tmp per writer: firaz runs several oracle sessions concurrently, all
    // pointed at the same pane-history.json. A shared `.json.tmp` would let two
    // writers clobber each other's tmp mid-flight; pid+nanos keeps them isolated.
    // The final rename is still atomic (single inode flip — no partial file ever
    // observed) and last-writer-wins at the content level, which is acceptable.
    let nonce = format!(
        "{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let tmp = path.with_extension(format!("json.tmp.{nonce}"));
    let limited: Vec<serde_json::Value> = items.into_iter().take(200).collect();
    let json = serde_json::to_string(&limited).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}
