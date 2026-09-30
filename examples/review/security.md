# Security review focus

Imported by `examples/WATCHDOG.md` via an `@` line. Relative imports resolve
beside the importing file; imports inside code fences stay literal.

- Any secret or token compared with `==` / `!==` instead of a constant-time
  comparison.
- Untrusted input passed to a shell, `eval`, or a template without escaping.
- New outbound network calls that send project or user data off-device.
- Authorization checks placed after the resource is already fetched.
