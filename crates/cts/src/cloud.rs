pub fn run() -> Result<(), String> {
    let db = crate::open_db()?;
    let r = cts_core::cloud::sync(&db)?;
    println!("{} cloud sessions seen, {} recorded, {} linked", r.seen, r.recorded, r.linked);
    if r.errors.is_empty() {
        return Ok(());
    }
    Err(format!("{} session(s) failed: {}", r.errors.len(), r.errors.join("; ")))
}
