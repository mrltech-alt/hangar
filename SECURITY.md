# Security

## Reporting a vulnerability

Please report privately rather than opening a public issue: use
[GitHub's private vulnerability reporting](https://github.com/mrltech-alt/hangar/security/advisories/new)
on this repository.

This is a personal project maintained by one person, so set your expectations accordingly: you will
get an acknowledgement when I next look at the repository, not within a guaranteed window. If
something is being actively exploited, say so in the first line.

Only the latest commit on `main` is supported. There are no release branches and no backports.

## What is most worth looking at

Hangar spawns processes, owns a Unix socket, writes configuration that another program reads, and
feeds text it did not author into a model. The interesting boundaries are:

- **The session host's socket** (`~/.hangar/run/`) and its NDJSON protocol. Anything that lets a
  local process drive a session it does not own, or escape the message schema, matters.
- **The `hangar` CLI**, which agents and Claude Code hooks call. It is the one component an agent
  running inside Hangar can invoke directly.
- **The settings file Hangar writes and passes to `claude --settings`.** Hangar writes its own file
  under `HANGAR_HOME` and never edits yours; a way to make it write somewhere else, or to make the
  user's own settings outrank it, would be a real finding.
- **Untrusted text paths.** Linear ticket text reaches a model prompt and the UI. It is stripped of
  control and invisible characters, and structured values are validated in code against known
  candidates rather than trusted from the model's output. Gaps in that are in scope.
- **Keychain access.** The Linear OAuth token is read per call from Claude Code's own keychain
  entry, matched on server URL, and never written to disk, logged, or sent to the renderer.

[Security posture](README.md#security-posture) in the README describes what is deliberately locked
down and how, which is the fastest way to see what the intended guarantees actually are.

## Out of scope

- The app is **unsigned and un-notarised**. That is documented, not a vulnerability.
- Anything requiring an attacker who already has local code execution as your user. At that point
  they have your shell, your keychain and your source tree regardless of Hangar.
- Vulnerabilities in Claude Code, Anthropic's services, or Linear. Report those to their owners.
