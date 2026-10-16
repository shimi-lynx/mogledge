fn main() {
    std::process::exit(mogledge_backend_tests::state_transfer::run_cli(
        std::env::args_os().skip(1),
        &mut std::io::stdin().lock(),
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
    ));
}
