# Mogledge 0.8.1 update interaction

Version 0.8.1 simplifies the existing manual updater. After automatic signature
and signed-version verification succeeds, **Update and restart** is available
with a short warning that unsaved input will be lost. The mandatory
save-confirmation checkbox is removed from the shared Japanese/English UI and
its IPC/Native API. Ready-state, verified staged bytes, main-window authorization,
cancellation and duplicate-operation guards remain required.

This is a patch correction to an existing feature under the 0.x version policy.
Product version entries and the current Windows verification installer filename
align at 0.8.1. Dependency versions and historical verification records retain
their original scope. The identifier, profiles, installation identity, storage
API and default disabled updater enrollment are unchanged.

Normal Quit and normal launch do not install a staged update. There is no
persistent download, automatic restart, production feed activation or new
permission. Read the [update guide](in-app-updates.md) for saved-input and
installation boundaries.

Retained signed 0.8.0 QA artifacts exercise the previous UI. They remain useful
for that source's cryptographic/install-path evidence, but cannot validate this
interaction without a newly built QA app. Such an app can exercise its handoff
to a retained signed target; validating 0.8.1 as the installed signed target also
requires a new signed artifact. The changed interaction has not passed an
isolated Native probe. Existing incomplete Native rejection and
Mac/platform/distribution conditions remain incomplete.
