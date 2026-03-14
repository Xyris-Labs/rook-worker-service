rook-worker-service is a Rook Runtime component that turns local LLM coding engines into controllable worker sandboxes.

Each worker runs inside an isolated environment (typically a container) and hosts a coding engine such as Codex CLI. The service exposes these workers to the Rook Runtime so higher-level agents can submit tasks, observe execution, approve actions, and review results.

This allows distributed AI systems to orchestrate autonomous development workflows while keeping execution isolated, observable, and interruptible.
