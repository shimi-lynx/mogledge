fn main() {
    std::process::exit(mogledge_lib::state_transfer::run_cli(
        std::env::args_os().skip(1),
        &mut std::io::stdin().lock(),
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
    ));
}
