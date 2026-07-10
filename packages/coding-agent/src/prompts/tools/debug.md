Debugger access.

<instruction>
- You SHOULD prefer this over bash for program state, breakpoints, stepping, thread inspection, or interrupting a running process.
- `action: "launch"` starts a session; `program` required, `adapter` optional. Python: `adapter: "debugpy"`, `program` = target `.py`, interpreter/script flags in `args`. Go: `program` = package directory or `.go` file (dlv picks `mode=debug`) or a compiled binary (`mode=exec`).
- `action: "attach"` connects to a running process: `pid` (local), `port` (remote), `adapter` forces a specific debugger.
- **Breakpoints**: `set_breakpoint`/`remove_breakpoint` with source (`file`+`line`) or function (`function`); optional `condition`.
- **Flow control**: `continue` (resume), `step_over`/`step_in`/`step_out` (single-step), `pause` (interrupt a running program).
- **Inspect**: `threads`, `stack_trace` (current stopped thread), `scopes` (needs `frame_id` or current stopped frame), `variables` (needs `variable_ref` or `scope_id`), `evaluate` (needs `expression`; `context: "repl"` for raw debugger commands), `output` (stdout/stderr/console), `sessions`, `terminate`.
</instruction>

<caution>
- Only one active debug session at a time.
- `adapter` is the configured adapter id (e.g. `gdb`, `lldb-dap`, `debugpy`, `dlv`, `rdbg`, or any `dap.json` entry); the adapter binary must be installed locally.
- `program` is the debug target path, not a shell command. Directory programs are valid only for adapters that accept them (e.g. dlv debugs a Go package directory).
- Python debugging requires `debugpy` (`pip install debugpy`); Go requires Delve (`go install github.com/go-delve/delve/cmd/dlv@latest`); Ruby requires `rdbg` (`gem install debug`).
</caution>
