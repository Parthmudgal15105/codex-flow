# macOS permissions across Codex++ updates

Measured on 2026-10-13: the installed app's designated requirement is a
`cdhash` requirement, and `security find-identity -v -p codesigning` reports
zero valid identities. The installer previously used `--sign -` everywhere.
An ad hoc signature identifies a particular build; changed code or resources
produce a different identity for macOS privacy checks.

The installer now requires a persistent certificate before modifying an app.
Set CODEXPP_SIGNING_IDENTITY to the certificate's 40-character SHA-1 fingerprint,
or put that fingerprint in
`~/Library/Application Support/CodexPP/signing-identity`.
Use `security find-identity -v -p codesigning` to list usable certificates.
Never commit a private key. Keep the certificate and private key across updates.
The native OpenAI Computer Use runtime keeps its original signatures.

The exact staged build uses the same preflight. The staged installer checks
both bundles against each other's designated requirement before moving either
bundle. It refuses identity migrations, including ad hoc build changes.

Activation is pending a usable signing certificate. The first migration from
ad hoc signing requires a deliberate installation outside the continuity-only
staged installer and renewed user grants. Subsequent builds must use that same
certificate, bundle identifier, and installation path. Some macOS permissions
may still prompt under OS policy; this change addresses build identity churn.
No TCC database changes or permission resets are performed.

Validation: shell syntax, Python compilation, and the signing traversal tests
passed, including unavailable-certificate rejection and preservation of trusted
Computer Use code. The fixture was updated to the installer's current nested
CLI paths. Live permission retention across two certificate-signed releases
has not been tested because no signing identity is available.

Apple reference: https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements

Activation completed on 2026-10-13 using Codex++ Local Signing. A changed-resource reseal preserved the certificate-based designated requirement. Installed with a rollback backup; the running process was not restarted. Live TCC grant retention still requires verification after the user restarts and grants permissions for this one-time migration. See signing-activation.json.
