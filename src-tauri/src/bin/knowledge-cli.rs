fn main() {
    let status = mogledge_lib::index::cli::run(
        std::env::args_os().skip(1),
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
    );
    std::process::exit(status);
}
