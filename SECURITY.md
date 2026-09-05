# Security

This project launches Codex with Chromium's `--remote-debugging-pipe`. The pipe
is inherited privately by the launcher; it does not expose a TCP debugging port.

The patch is fail-closed:

- it requires one exact structural source signature for each change;
- it skips hash-matched chunks that do not contain a target signature;
- it rejects duplicate signatures instead of choosing one;
- it terminates the patched launch if interception or rewriting fails;
- it never writes to the installed Codex package or `app.asar`.

Do not weaken the structural source-signature checks when updating support for a
new Codex release. Review changed renderer behavior and update tests first.
