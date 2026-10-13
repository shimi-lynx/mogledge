fn main() {
    std::process::exit(my_knowledge_lib::state_inspection::run_cli(
        std::env::args_os().skip(1),
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
    ));
}
