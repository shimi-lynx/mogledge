fn main() {
    std::process::exit(
        my_knowledge_backend_tests::storage_identity_transition::offline::run_cli(
            std::env::args_os().skip(1),
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
        ),
    );
}
