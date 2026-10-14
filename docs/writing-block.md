## Mandatory Artifact Lifecycle, Stale-State Prevention, and Reproducibility

Treat stale files, incompatible build artifacts, leftover processes, and reused test outputs as potential correctness bugs.

### 1. Classify generated files

Before creating files, identify their category:

- **Persistent user data:** model files, user configuration, and user-created content. Never delete automatically.
- **Source-controlled files:** source code, tests, and documentation. Modify only when required.
- **Reusable build artifacts:** executables, libraries, object files, and compiler caches. Reuse only when their compatibility with the current source and configuration is established.
- **Temporary artifacts:** intermediate files, scratch data, temporary request payloads, and disposable test outputs.
- **Runtime artifacts:** PID files, logs, sockets, lock files, and process state.

Document ownership, location, and cleanup rules for generated artifacts.

### 2. Prevent stale artifact reuse

Before running a build or test:

- Confirm which source revision and configuration the artifact represents.
- Detect relevant changes to source files, compiler, toolchain, CMake options, CUDA settings, RPC protocol, model path, and configuration.
- Reconfigure or rebuild when compatibility cannot be established.
- Never report a successful build or test using an unidentified or incompatible executable.
- Record the executable path, build configuration, and relevant version information in diagnostic output.

Use separate build directories for genuinely different configurations where appropriate, such as CPU-only and CUDA-enabled builds.

Do not delete an entire build directory merely to force a rebuild unless the need is justified and its contents are safe to remove.

### 3. Make temporary-file cleanup reliable

- Use unique, operation-specific temporary directories where practical.
- Track every temporary file and directory created by an operation.
- Clean up temporary artifacts on success, failure, cancellation, and handled exceptions.
- Use scope-based cleanup or equivalent reliable mechanisms.
- Never delete files merely because their names resemble temporary files.
- Never delete files belonging to another process or another running task.
- If cleanup fails, report the exact path and reason.

### 4. Prevent stale-process and port conflicts

Before starting a server:

- Check whether the intended port is already occupied.
- Determine, where safely possible, which process owns the port.
- Check whether an existing server can be reused and whether its configuration is compatible.
- Never kill unrelated processes automatically.
- If an old Swarm process is running, explain the conflict and use a safe shutdown mechanism where appropriate.
- Verify the new process's actual executable path, startup configuration, and listening port.

Do not assume that a process is the correct server just because its port responds.

### 5. Isolate tests

- Give each test run a fresh output directory or unique run identifier.
- Never treat an old output file as evidence that a new test passed.
- Remove or replace only test artifacts that the current test owns.
- Record the start time, inputs, configuration, exit code, and result for each test run.
- Make tests fail clearly when required outputs were not generated during the current run.
- Ensure that repeated test runs produce trustworthy results.

### 6. Verify after cleanup

After every build, test, or temporary operation:

- Confirm expected outputs were created during the current operation.
- Confirm their paths and timestamps or run identifiers.
- Check the exit code and inspect relevant errors.
- Confirm cleanup was performed for disposable artifacts.
- Preserve persistent user data and reusable model files.
- Record any remaining artifacts and explain why they are retained.

### 7. Final completion gate

A task is not complete merely because a command was issued or a file exists.

It is complete only when the current operation's outputs are verified, stale-state risks are addressed, required cleanup has been checked, and test results correspond to the current source and configuration.

Never claim success based solely on an old executable, cached test result, pre-existing output file, or previous run's log.