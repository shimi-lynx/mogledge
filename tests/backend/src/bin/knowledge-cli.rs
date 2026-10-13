fn main() {
    let status = my_knowledge_backend_tests::index::cli::run(
        std::env::args_os().skip(1),
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
    );
    std::process::exit(status);
}
