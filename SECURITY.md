# Security

This project launches Codex with Chromium's `--remote-debugging-pipe`. The pipe
is inherited privately by the launcher; it does not expose a TCP debugging port.

Windows package activation gives the Node host and its children the installed
Codex package identity. The helper checks the exact package full name before
proceeding. The environment/logging pipe has an explicit current-user ACL,
rejects remote clients, and verifies the connecting process ID before sending
the environment. Environment values are never written to disk. Losing the
launcher connection stops its Codex child and attempts config restoration.

The patch is fail-closed:

- it requires one exact structural source signature for each change;
- it skips hash-matched chunks that do not contain a target signature;
- it rejects duplicate signatures instead of choosing one;
- it terminates the patched launch if interception or rewriting fails;
- it never writes to the installed Codex package or `app.asar`.

During startup only, the launcher transactionally modifies `config.toml` and
restores the original bytes as soon as Codex is ready. The adjacent backup and
transaction marker are checksummed; if the config changes unexpectedly, the
launcher removes only its three settings and preserves non-overlapping Codex
changes. Each temporary setting must still have the exact value written by the
launcher before it can be removed. Overlapping or ambiguous edits preserve both
versions and fail closed.

Config restoration retries only access-denied/busy errors on the config file's
read, stat, rename, or removal operations, for at most seven attempts per recovery
call. Each attempt re-reads the config and repeats the checksum/owned-setting
checks, so waiting does not authorize overwriting intervening user edits.
Shortcut error reports use a fresh per-launch filename in the installation
directory and are removed after display; an old log is not treated as proof
that a new launch restored the config.

Do not weaken the structural source-signature checks when updating support for a
new Codex release. Review changed renderer behavior and update tests first.
