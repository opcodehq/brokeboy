#[cfg(feature = "typescript")]
fn main() {
    print!("{}", brokeboy_core::models::declarations());
}
#[cfg(not(feature = "typescript"))]
fn main() {
    eprintln!("Enable the typescript feature to generate declarations.");
    std::process::exit(1);
}
